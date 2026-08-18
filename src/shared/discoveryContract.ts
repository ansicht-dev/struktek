/**
 * The MCP discovery-file contract — the one agreement between the extension
 * host that WRITES `.struktek/.runtime/mcp.json` and the standalone bridge that
 * READS it.
 *
 * Both sides import this module so the filename, schema, and document shape can
 * never drift apart. It stays dependency-free (only `node:path`) because the
 * bridge runs outside the extension host and must not pull `vscode` in.
 *
 * The file lives under `.runtime/`, NOT directly in the library root. The
 * directory it lands in is made self-ignoring with a `*` gitignore — pointing
 * that at `.struktek/` would silently stop tracking the template library, which
 * is the one thing in there the user definitely wants committed.
 */

import * as path from 'node:path';

/** Fixed relative to the workspace root, so the bridge can find it by walking up. */
export const DISCOVERY_DIR = path.join('.struktek', '.runtime');
export const DISCOVERY_FILENAME = 'mcp.json';
export const DISCOVERY_SCHEMA = 1;

export interface DiscoveryDocument {
  /** Where the live server is listening, including the `/mcp` path. */
  readonly url: string;
  /** Per-listen bearer token. Rotates on every restart — never commit it. */
  readonly token: string;
  /** Workspace root the server is serving. */
  readonly workspace: string;
  /**
   * Absolute path to the resolved library root.
   *
   * Carried explicitly because `struktek.libraryPath` is configurable, and the
   * bridge's offline fallback reads templates straight off disk — it cannot ask
   * VS Code where they went.
   */
  readonly library: string;
  /** PID of the owning extension host, so a reader can spot a stale file. */
  readonly pid: number;
  readonly schema: number;
}

export function discoveryFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DISCOVERY_DIR, DISCOVERY_FILENAME);
}
