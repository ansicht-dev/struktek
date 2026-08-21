/**
 * The global library, as the offline bridge sees it.
 *
 * This is the case that decided where the global library lives. An agent in a
 * bare terminal is exactly who global templates are for, and it reaches them
 * through the bridge with no extension host to ask — so the bridge has to
 * resolve the second root itself, and fold it into the workspace one by the
 * same rule the editor uses. If these two ever disagree, `code-review` means
 * one file in the sidebar and a different file to the agent.
 *
 * A real MCP client over a real linked transport, against two real directories.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectBridge, type BridgeHandle } from '../../mcpBridge/bridge';
import { parseGlobalArg, resolveGlobalRoot, resolveWorkspaceRoot } from '../../mcpBridge/resolveWorkspace';

let home: string;
let workspace: string;
let bridge: BridgeHandle;
let client: Client;

/** Write `<root>/.struktek/templates/<name>.md`. */
async function template(root: string, name: string, body: string): Promise<void> {
  const dir = path.join(root, '.struktek', 'templates');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name + '.md'), body);
}

/** Write `<root>/.struktek/blocks/<type>/<instance>.md`. */
async function block(root: string, type: string, instance: string, body: string): Promise<void> {
  const dir = path.join(root, '.struktek', 'blocks', type);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, instance + '.md'), body);
}

async function text(promise: Promise<unknown>): Promise<string> {
  const result = (await promise) as { content: { text: string }[] };
  return result.content[0]?.text ?? '';
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'struktek-home-'));
  workspace = await mkdtemp(path.join(tmpdir(), 'struktek-ws-'));

  await template(home, 'commit-message', 'Write a commit message for {{ change }}.');
  await template(home, 'greet', 'Global greeting for {{ who }}.');
  await block(home, 'output-format', 'prose', 'Answer in prose.\n');
  await block(home, 'output-format', 'json', 'Answer as JSON.\n');

  await template(workspace, 'greet', 'Workspace greeting for {{ who }}.');
  // Typed with a block type that exists only in the GLOBAL library. If the
  // bridge analysed each root against its own blocks, this would come back as
  // an unknown type and refuse every value.
  await template(workspace, 'report', 'Report on {{ topic }} as {{ format: output-format }}.');
  await block(workspace, 'output-format', 'prose', 'Answer in workspace prose.\n');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  bridge = await connectBridge(serverTransport, {
    workspaceRoot: workspace,
    globalRoot: path.join(home, '.struktek'),
    offlineOnly: true,
  });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  await bridge.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('the bridge with two libraries', () => {
  it('serves a global template in a workspace that has none of its own', async () => {
    const listed = await text(
      client.callTool({ name: 'struktek_list_templates', arguments: {} }),
    );
    const names = (JSON.parse(listed) as { templates: { name: string }[] }).templates.map(
      (t) => t.name,
    );
    expect(names).toContain('commit-message');
  });

  it('marks a global template as global, and says nothing about a local one', async () => {
    const listed = await text(
      client.callTool({ name: 'struktek_list_templates', arguments: {} }),
    );
    const templates = (JSON.parse(listed) as { templates: { name: string; scope?: string }[] })
      .templates;
    expect(templates.find((t) => t.name === 'commit-message')?.scope).toBe('global');
    expect(templates.find((t) => t.name === 'report')?.scope).toBeUndefined();
  });

  it('lists a shadowed name exactly once', async () => {
    const listed = await text(
      client.callTool({ name: 'struktek_list_templates', arguments: {} }),
    );
    const names = (JSON.parse(listed) as { templates: { name: string }[] }).templates.map(
      (t) => t.name,
    );
    expect(names.filter((name) => name === 'greet')).toEqual(['greet']);
  });

  it('composes the workspace copy when both libraries have the name', async () => {
    const composed = await text(
      client.callTool({
        name: 'struktek_compose',
        arguments: { template: 'greet', values: { who: 'the team' } },
      }),
    );
    expect((JSON.parse(composed) as { prompt: string }).prompt).toBe(
      'Workspace greeting for the team.',
    );
  });

  it('resolves a workspace template against a globally-defined block type', async () => {
    const composed = await text(
      client.callTool({
        name: 'struktek_compose',
        arguments: { template: 'report', values: { topic: 'latency', format: 'json' } },
      }),
    );
    // `json` exists only globally; the merge is what makes it a legal value.
    expect((JSON.parse(composed) as { prompt: string }).prompt).toContain('Answer as JSON.');
  });

  it('renders the workspace block when both libraries define the value', async () => {
    const composed = await text(
      client.callTool({
        name: 'struktek_compose',
        arguments: { template: 'report', values: { topic: 'latency', format: 'prose' } },
      }),
    );
    expect((JSON.parse(composed) as { prompt: string }).prompt).toContain(
      'Answer in workspace prose.',
    );
  });

  it('reads a global template as a resource under its plain name', async () => {
    const result = (await client.readResource({
      uri: 'struktek://template/commit-message',
    })) as { contents: { text: string }[] };
    expect(result.contents[0]?.text).toContain('Write a commit message');
  });

  it('offers no save tools, global library or not', async () => {
    // Writing still needs a running host to notice the change; a second
    // library does not change that.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('struktek_save_template');
  });
});

describe('resolving the two roots', () => {
  it('defaults the global root to .struktek under the home directory', () => {
    expect(resolveGlobalRoot({ home })).toBe(path.join(home, '.struktek'));
  });

  it('takes --global, and --no-global as a switch-off', () => {
    expect(parseGlobalArg(['--global', '/srv/prompts'])).toBe('/srv/prompts');
    expect(parseGlobalArg(['--global=/srv/prompts'])).toBe('/srv/prompts');
    expect(parseGlobalArg(['--no-global'])).toBe(false);
    expect(resolveGlobalRoot({ argv: ['--no-global'], home })).toBeUndefined();
  });

  it('does not mistake the home directory for a workspace', async () => {
    // `~/.struktek` is the global library. Walking up into it and calling home
    // the workspace would read one folder as both, and report every template
    // in it as shadowing itself.
    const nested = path.join(home, 'scratch');
    await mkdir(nested, { recursive: true });
    expect(resolveWorkspaceRoot({ cwd: nested, home })).toBe(nested);
  });

  it('stops at home rather than climbing above it', async () => {
    // The walk must not continue past home looking for a library. It would
    // find whatever `.struktek` happens to sit in the real home directory or
    // at the filesystem root and hand every session that folder — which is
    // exactly what this test caught when the walk merely SKIPPED home.
    const nested = path.join(home, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    expect(resolveWorkspaceRoot({ cwd: nested, home })).toBe(nested);
  });

  it('still walks up to a real project below home', async () => {
    const project = path.join(home, 'code', 'thing');
    await mkdir(path.join(project, '.struktek'), { recursive: true });
    const deep = path.join(project, 'src', 'nested');
    await mkdir(deep, { recursive: true });
    expect(resolveWorkspaceRoot({ cwd: deep, home })).toBe(project);
  });
});
