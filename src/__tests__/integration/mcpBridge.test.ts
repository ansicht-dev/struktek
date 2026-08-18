/**
 * The bridge's offline mode.
 *
 * This is the case struktek deliberately supports and the sibling architecture
 * does not: no extension host running, and the agent still gets the templates.
 * `/mcp__struktek__code-review` should work in a bare terminal at 2am, not fail
 * because a GUI is closed.
 *
 * A real MCP client over a real linked transport, against a real directory of
 * template files. Only the socket is absent, which is the point.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectBridge, type BridgeHandle } from '../../mcpBridge/bridge';

let workspace: string;
let bridge: BridgeHandle;
let client: Client;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'struktek-bridge-'));
  const library = path.join(workspace, '.struktek');
  await mkdir(path.join(library, 'templates'), { recursive: true });
  await mkdir(path.join(library, 'blocks', 'output-format'), { recursive: true });

  await writeFile(
    path.join(library, 'templates', 'greet.md'),
    [
      '---',
      'name: greet',
      'description: Say hello',
      '---',
      'Greet {{ who }} [in {{ language }}].',
      '',
      '{{ format: output-format = prose }}',
    ].join('\n'),
  );
  await writeFile(path.join(library, 'blocks', 'output-format', 'prose.md'), 'Answer in prose.\n');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  bridge = await connectBridge(serverTransport, { workspaceRoot: workspace, offlineOnly: true });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close().catch(() => undefined);
  await bridge.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('offline bridge', () => {
  it('reports itself as disconnected from any host', () => {
    expect(bridge.connected).toBe(false);
    expect(bridge.url).toBeUndefined();
  });

  it('still advertises both tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['struktek_compose', 'struktek_list_templates']);
  });

  it('lists the templates it read off disk', async () => {
    const result = await client.callTool({ name: 'struktek_list_templates', arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.templates.map((t: { name: string }) => t.name)).toEqual(['greet']);
  });

  it('composes a prompt, resolving blocks from disk', async () => {
    const result = await client.callTool({
      name: 'struktek_compose',
      arguments: { template: 'greet', values: { who: 'Ada' } },
    });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.prompt).toBe('Greet Ada.\n\nAnswer in prose.');
    expect(payload.unfilled).toEqual(['language']);
  });

  it('exposes the template as a slash-command prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['greet']);
    expect(prompts[0]?.description).toBe('Say hello');
  });

  it('renders through prompts/get', async () => {
    const result = await client.getPrompt({
      name: 'greet',
      arguments: { who: 'Ada', language: 'French' },
    });
    const content = result.messages[0]?.content;
    expect(content && 'text' in content ? content.text : '').toBe(
      'Greet Ada in French.\n\nAnswer in prose.',
    );
  });

  it('picks up a template added after startup', async () => {
    await writeFile(
      path.join(workspace, '.struktek', 'templates', 'later.md'),
      'Added later: {{ thing }}.',
    );
    // The disk view re-reads on a short TTL rather than caching forever, so a
    // file written by another editor appears without restarting the agent.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const result = await client.callTool({ name: 'struktek_list_templates', arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.templates.map((t: { name: string }) => t.name).sort()).toEqual(['greet', 'later']);
  });

  it('reports a missing template without failing the call', async () => {
    const result = await client.callTool({
      name: 'struktek_compose',
      arguments: { template: 'nope', values: {} },
    });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.error).toContain('nope');
  });
});
