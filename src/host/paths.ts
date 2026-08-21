/**
 * Library layout constants.
 *
 * Their own module so data-only code (the starter library, and anything that
 * needs to be unit-testable) can name a directory without importing the loader
 * and pulling `vscode` in behind it.
 */

export const TEMPLATES_DIR = 'templates';
export const BLOCKS_DIR = 'blocks';

/**
 * The library folder name, used for both scopes.
 *
 * The same name in the workspace and in the home directory, so `~/.struktek`
 * and `<project>/.struktek` are the same thing at two altitudes — nothing to
 * learn twice, and a folder can be moved between them as-is. The bridge
 * imports this too, which is why it lives in the module that imports nothing.
 */
export const DEFAULT_LIBRARY_DIR = '.struktek';

/**
 * Where the global library is, given what the user configured.
 *
 * Shared by the extension host and the standalone bridge so both land on the
 * same folder — a host serving one directory while the offline bridge serves
 * another is the one failure mode a second library really can introduce.
 *
 * Rules, in order:
 *   nothing configured  ->  `<home>/.struktek`
 *   `~/x` or `~`        ->  expanded against home
 *   an absolute path    ->  taken as written
 *   anything else       ->  undefined
 *
 * A RELATIVE path is rejected rather than resolved against the CWD. The whole
 * point of this root is that it belongs to no project, so there is no honest
 * base to resolve it against, and quietly picking one would put a user's
 * library somewhere they would never think to look.
 */
export function globalLibraryPath(
  configured: string | undefined,
  home: string | undefined,
): string | undefined {
  const value = (configured ?? '').trim();
  if (value.length === 0) return home ? join(home, DEFAULT_LIBRARY_DIR) : undefined;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return home ? join(home, value.slice(2)) : undefined;
  }
  return isAbsolute(value) ? value : undefined;
}

/**
 * Path joining without `node:path`.
 *
 * This module is imported by the webview-adjacent code paths as well as by
 * node ones, and has stayed dependency-free since it was split out. Two string
 * operations are a smaller price than making it importable from fewer places.
 */
function join(base: string, rest: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + separator + rest.replace(/^[\\/]+/, '');
}

/** Absolute means a POSIX root, a drive letter, or a UNC share. */
function isAbsolute(value: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(value);
}

/**
 * Per-session runtime state, self-ignoring.
 *
 * Kept OUT of the library root proper. The ignore file written here says `*`,
 * and pointing that at `.struktek/` would silently stop tracking the template
 * library — which is the one thing in there the user definitely wants committed.
 */
export const RUNTIME_DIR = '.runtime';
