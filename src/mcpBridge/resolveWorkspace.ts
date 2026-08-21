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
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LIBRARY_DIR, globalLibraryPath } from '../host/paths';

export interface ResolveOptions {
  /** Explicit root — wins over everything. */
  workspaceRoot?: string;
  /** Raw CLI args (after `node script`), scanned for `--workspace`. */
  argv?: readonly string[];
  /** Override CWD (tests); defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Explicit global library root, or `false` to serve the workspace alone.
   *
   * Defaults to `~/.struktek`, which is where the extension puts it. The
   * bridge resolves it independently rather than asking the host, because the
   * whole point of the offline path is that there is no host to ask.
   */
  globalRoot?: string | false;
  /** Override the home directory (tests). */
  home?: string;
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
  const home = homeDir(opts);
  let dir = start;
  for (;;) {
    // Stop AT the home directory, without checking it. `~/.struktek` is the
    // GLOBAL library: matching it would make a session launched from anywhere
    // under home claim the home folder as its workspace, and then read the
    // global library twice, once under each name.
    //
    // The walk ends there rather than continuing above it. Nothing above your
    // home directory is a project, and climbing on lets a stray `.struktek` in
    // `C:\Users` or `/` capture every session started under home.
    if (dir === home) break;
    if (fs.existsSync(path.join(dir, DEFAULT_LIBRARY_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** Parse `--global <path>` / `--global=<path>`, or `--no-global` to switch it off. */
export function parseGlobalArg(argv: readonly string[] = []): string | false | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-global') return false;
    if (arg === '--global') {
      const next = argv[i + 1];
      return next && !next.startsWith('-') ? next : undefined;
    }
    const inline = /^--global=(.+)$/.exec(arg ?? '');
    if (inline?.[1]) return inline[1];
  }
  return undefined;
}

/**
 * The global library root, or undefined when there is none to serve.
 *
 * Undefined for two different reasons that need no distinguishing here: the
 * user switched it off, or there is no home directory to put one in. Either
 * way the bridge serves the workspace alone.
 */
export function resolveGlobalRoot(opts: ResolveOptions = {}): string | undefined {
  const explicit = opts.globalRoot ?? parseGlobalArg(opts.argv);
  if (explicit === false) return undefined;
  if (explicit) return path.resolve(explicit);
  // Through the same resolver the extension host uses, so `~/prompts` in the
  // setting and `--global ~/prompts` on the command line land in one place.
  const resolved = globalLibraryPath(undefined, homeDir(opts));
  return resolved ? path.resolve(resolved) : undefined;
}

function homeDir(opts: ResolveOptions): string | undefined {
  if (opts.home !== undefined) return path.resolve(opts.home);
  try {
    const home = os.homedir();
    return home ? path.resolve(home) : undefined;
  } catch {
    return undefined;
  }
}
