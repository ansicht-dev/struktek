/**
 * Agent-config spec.
 *
 * The property that matters most is what is NOT in the output: no token, no
 * absolute path to the extension, no port. That is what makes the generated
 * config safe to commit and able to survive restarts — and it is easy to
 * regress by "helpfully" inlining something.
 *
 * The other is that merging never destroys somebody's other MCP servers.
 */

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PACKAGE,
  buildAgentConfig,
  mergeProjectConfig,
  projectConfigRelPath,
} from '../../host/mcpAgentConfig';

const input = { workspaceRoot: '/home/dev/project' };

describe('buildAgentConfig', () => {
  it('launches the published bridge through npx, pointed at the workspace', () => {
    const document = JSON.parse(buildAgentConfig('claude-code', input));
    expect(document.mcpServers.struktek).toEqual({
      command: 'npx',
      args: ['-y', BRIDGE_PACKAGE, '--workspace', '/home/dev/project'],
    });
  });

  it('emits a Codex table for Codex', () => {
    const toml = buildAgentConfig('codex', input);
    expect(toml).toContain('[mcp_servers.struktek]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('"--workspace", "/home/dev/project"');
  });

  it('carries no token, port, or version pin', () => {
    for (const client of ['claude-code', 'codex'] as const) {
      const config = buildAgentConfig(client, input);
      expect(config).not.toMatch(/token/i);
      expect(config).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}/);
      expect(config).not.toMatch(/@struktek\/mcp-bridge@/);
    }
  });

  it('targets the conventional config file for each client', () => {
    expect(projectConfigRelPath('claude-code')).toBe('.mcp.json');
    expect(projectConfigRelPath('codex')).toMatch(/\.codex[\\/]config\.toml/);
  });
});

describe('mergeProjectConfig — Claude Code', () => {
  it('creates a fresh document when there is no existing file', () => {
    const merged = JSON.parse(mergeProjectConfig('claude-code', undefined, input));
    expect(Object.keys(merged.mcpServers)).toEqual(['struktek']);
  });

  it('preserves other MCP servers already configured', () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: 'other-server', args: [] } },
    });
    const merged = JSON.parse(mergeProjectConfig('claude-code', existing, input));
    expect(merged.mcpServers.other).toEqual({ command: 'other-server', args: [] });
    expect(merged.mcpServers.struktek.command).toBe('npx');
  });

  it('preserves unrelated top-level keys', () => {
    const existing = JSON.stringify({ someOtherKey: { keep: true }, mcpServers: {} });
    const merged = JSON.parse(mergeProjectConfig('claude-code', existing, input));
    expect(merged.someOtherKey).toEqual({ keep: true });
  });

  it('replaces a previous struktek entry rather than duplicating it', () => {
    const first = mergeProjectConfig('claude-code', undefined, input);
    const second = mergeProjectConfig('claude-code', first, { workspaceRoot: '/elsewhere' });
    const merged = JSON.parse(second);
    expect(Object.keys(merged.mcpServers)).toEqual(['struktek']);
    expect(merged.mcpServers.struktek.args).toContain('/elsewhere');
  });

  it('treats an empty file as a fresh start', () => {
    expect(() => mergeProjectConfig('claude-code', '   ', input)).not.toThrow();
  });

  it('throws on an unparseable file so the caller can decline to clobber it', () => {
    expect(() => mergeProjectConfig('claude-code', '{ not json', input)).toThrow();
  });

  it('throws when the existing file is valid JSON but not an object', () => {
    expect(() => mergeProjectConfig('claude-code', '[1, 2]', input)).toThrow();
  });
});

describe('mergeProjectConfig — Codex', () => {
  it('appends to a config that has other tables', () => {
    const existing = '[mcp_servers.other]\ncommand = "other"\n';
    const merged = mergeProjectConfig('codex', existing, input);
    expect(merged).toContain('[mcp_servers.other]');
    expect(merged).toContain('[mcp_servers.struktek]');
  });

  it('replaces an existing struktek table without duplicating it', () => {
    const first = mergeProjectConfig('codex', undefined, input);
    const second = mergeProjectConfig('codex', first, { workspaceRoot: '/elsewhere' });
    expect(second.match(/\[mcp_servers\.struktek\]/g)).toHaveLength(1);
    expect(second).toContain('/elsewhere');
  });

  it('leaves a table that follows ours intact when replacing', () => {
    const existing =
      '[mcp_servers.struktek]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const merged = mergeProjectConfig('codex', existing, input);
    expect(merged).toContain('[mcp_servers.other]');
    expect(merged).toContain('command = "other"');
    expect(merged).not.toContain('command = "old"');
  });
});
