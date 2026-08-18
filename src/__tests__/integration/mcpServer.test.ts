/**
 * The live MCP server, end to end.
 *
 * Nothing is mocked below the test's own fixture library: a real socket, a real
 * discovery file, a real MCP SDK client over HTTP. The SDK in particular is
 * never stubbed — a handshake that works against a fake is not evidence of much.
 *
 * The cases that earn their keep are the security ones (an unauthenticated
 * request must be refused, and the token file must never outlive the server) and
 * the gitignore, which is what stops a live bearer token from becoming
 * committable.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, type BlockLibrary } from '../../core';
import { discoveryFilePath, type DiscoveryDocument } from '../../shared/discoveryContract';
import { McpServerHost } from '../../host/mcpServer';
import type { LibraryView } from '../../shared/mcpSurface';

const blocks: BlockLibrary = {
  names: new Map([['output-format', ['prose']]]),
  bodies: new Map([['output-format', new Map([['prose', 'Answer in prose.']])]]),
};

const TEMPLATE = [
  '---',
  'name: greet',
  'description: Say hello',
  '---',
  'Greet {{ who }} [in {{ language }}].',
  '',
  '{{ format: output-format = prose }}',
].join('\n');

function fixtureView(): LibraryView {
  const model = loadTemplate(TEMPLATE, { name: 'greet', parseYaml, blockTypes: blocks.names });
  return { templates: () => [model], blocks: () => blocks };
}

let workspace: string;
let host: McpServerHost;
let url: string;

async function readDiscovery(): Promise<DiscoveryDocument> {
  return JSON.parse(await readFile(discoveryFilePath(workspace), 'utf8')) as DiscoveryDocument;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  return client;
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'struktek-mcp-'));
  host = new McpServerHost({
    workspaceRoot: workspace,
    libraryRoot: path.join(workspace, '.struktek'),
    version: '9.9.9',
    view: fixtureView,
  });
  url = await host.listen();
});

afterEach(async () => {
  await host.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('discovery file', () => {
  it('publishes the url, a fresh token, and the owning pid', async () => {
    const document = await readDiscovery();
    expect(document.url).toBe(url);
    expect(document.token).toMatch(/^[0-9a-f]{64}$/);
    expect(document.schema).toBe(1);
    expect(document.pid).toBe(process.pid);
    expect(document.workspace).toBe(workspace);
    // Carried explicitly so the bridge's offline mode can find the templates
    // even when `struktek.libraryPath` has been changed.
    expect(document.library).toBe(path.join(workspace, '.struktek'));
  });

  it('makes its own directory self-ignoring', async () => {
    const ignore = await readFile(path.join(path.dirname(discoveryFilePath(workspace)), '.gitignore'), 'utf8');
    expect(ignore.trim()).toBe('*');
  });

  it('binds loopback only', () => {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('is deleted when the server closes', async () => {
    expect(existsSync(discoveryFilePath(workspace))).toBe(true);
    await host.close();
    expect(existsSync(discoveryFilePath(workspace))).toBe(false);
  });
});

describe('authentication', () => {
  it('refuses a request with no credentials', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'a'.repeat(64) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('the MCP surface over HTTP', () => {
  it('lists both tools', async () => {
    const client = await connect((await readDiscovery()).token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['struktek_compose', 'struktek_list_templates']);
    await client.close();
  });

  it('exposes each template as a prompt with its arguments', async () => {
    const client = await connect((await readDiscovery()).token);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['greet']);
    expect(prompts[0]?.arguments?.map((a) => a.name)).toEqual(['who', 'language', 'format']);
    // `language` only appears inside the optional segment.
    expect(prompts[0]?.arguments?.find((a) => a.name === 'language')?.required).toBe(false);
    await client.close();
  });

  it('renders a prompt through prompts/get', async () => {
    const client = await connect((await readDiscovery()).token);
    const result = await client.getPrompt({ name: 'greet', arguments: { who: 'Ada' } });
    const content = result.messages[0]?.content;
    expect(content?.type).toBe('text');
    // The optional segment drops out, and the pinned block resolves to its body.
    expect(content && 'text' in content ? content.text : '').toBe('Greet Ada.\n\nAnswer in prose.');
    await client.close();
  });

  it('composes through the tool as well', async () => {
    const client = await connect((await readDiscovery()).token);
    const result = await client.callTool({
      name: 'struktek_compose',
      arguments: { template: 'greet', values: { who: 'Ada', language: 'French' } },
    });
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(JSON.parse(content.text).prompt).toBe('Greet Ada in French.\n\nAnswer in prose.');
    await client.close();
  });

  it('reports the extension version to the client', async () => {
    const client = await connect((await readDiscovery()).token);
    expect(client.getServerVersion()).toMatchObject({ name: 'struktek', version: '9.9.9' });
    await client.close();
  });
});

describe('restart', () => {
  it('rotates the port and token, and rewrites discovery', async () => {
    const before = await readDiscovery();
    await host.close();
    url = await host.listen();

    const document = await readDiscovery();
    expect(document.token).not.toBe(before.token);
    expect(url).not.toBe(before.url);
    // A client using the new token still works — nothing was left half-torn-down.
    const client = await connect(document.token);
    expect((await client.listTools()).tools).toHaveLength(2);
    await client.close();
  });
});
