/**
 * Work out which workspace the bridge should serve.
 *
 * The bridge is a subprocess the agent spawns, so its CWD is whatever the client
 * chose — not necessarily the project root. Resolution order:
 *
 *   1. an explicit `--workspace <path>` (the form the generated config uses), else
 *   2. walk UP from CWD to the nearest ancestor holding `.struktek/`, the way
 *      git finds `.git`.
 *
 * Falling back to CWD when nothing matches lets the caller produce a clear
 * "no library here" message rather than guessing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolveOptions {
  /** Explicit root — wins over everything. */
  workspaceRoot?: string;
  /** Raw CLI args (after `node script`), scanned for `--workspace`. */
  argv?: readonly string[];
  /** Override CWD (tests); defaults to `process.cwd()`. */
  cwd?: string;
}

/** Parse `--workspace <path>` / `--workspace=<path>` / `-w <path>` from argv. */
export function parseWorkspaceArg(argv: readonly string[] = []): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') {
      const next = argv[i + 1];
      // Do not greedily swallow a following flag (`-w --other`) as the path.
      return next && !next.startsWith('-') ? next : undefined;
    }
    const inline = /^--workspace=(.+)$/.exec(arg ?? '');
    if (inline?.[1]) return inline[1];
  }
  return undefined;
}

export function resolveWorkspaceRoot(opts: ResolveOptions = {}): string {
  const explicit = opts.workspaceRoot ?? parseWorkspaceArg(opts.argv);
  if (explicit) return path.resolve(explicit);

  const start = path.resolve(opts.cwd ?? process.cwd());
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.struktek'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
