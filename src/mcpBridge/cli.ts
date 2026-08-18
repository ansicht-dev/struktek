#!/usr/bin/env node
/**
 * The `struktek-mcp-bridge` entry point.
 *
 * Launched by an MCP client — Claude Code's `.mcp.json`, Codex's
 * `[mcp_servers.*]`. Connects the agent's stdio to the live extension host when
 * one is running, and to the library on disk when one is not.
 *
 * CRITICAL: stdout is the MCP JSON-RPC channel. Every human-facing line goes to
 * stderr, and the discovery token is never logged anywhere.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectBridge } from './bridge';

async function main(): Promise<void> {
  try {
    const handle = await connectBridge(new StdioServerTransport(), { argv: process.argv.slice(2) });
    process.stderr.write(
      handle.connected
        ? '[struktek-bridge] connected to the extension host at ' + String(handle.url) + '\n'
        : '[struktek-bridge] serving templates from ' + handle.workspaceRoot + ' (extension host not running)\n',
    );
    const shutdown = (): void => {
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    process.stderr.write(
      '[struktek-bridge] failed to start: ' + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    process.exit(1);
  }
}

void main();
