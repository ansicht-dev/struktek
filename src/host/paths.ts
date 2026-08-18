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
 * Per-session runtime state, self-ignoring.
 *
 * Kept OUT of the library root proper. The ignore file written here says `*`,
 * and pointing that at `.struktek/` would silently stop tracking the template
 * library — which is the one thing in there the user definitely wants committed.
 */
export const RUNTIME_DIR = '.runtime';
