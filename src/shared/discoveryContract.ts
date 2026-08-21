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
  /**
   * Absolute path to the global library root, when one is in use.
   *
   * Same reason `library` is here, one level up: the path is configurable and
   * can be switched off, and the offline bridge would otherwise fall back to
   * its own `~/.struktek` guess — serving a different set of templates than
   * the editor does, which is the one thing the two must never do.
   *
   * Absent means the user has no global library, and the bridge should not
   * invent one.
   */
  readonly globalLibrary?: string;
  /** PID of the owning extension host, so a reader can spot a stale file. */
  readonly pid: number;
  readonly schema: number;
}

export function discoveryFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DISCOVERY_DIR, DISCOVERY_FILENAME);
}
