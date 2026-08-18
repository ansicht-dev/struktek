/**
 * Build, package, and install the extension into every editor on this machine.
 *
 * `code` is not a reliable target on its own: VS Code, VSCodium, Insiders, and
 * the various forks each ship their own CLI, and whichever one happens to own
 * `code` on PATH is rarely the one you are actually working in. Installing into
 * all of them beats guessing wrong and wondering why the icon never appeared.
 *
 *   node scripts/install-local.mjs           # every editor found
 *   node scripts/install-local.mjs codium    # just this one
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CANDIDATES = ['code', 'code-insiders', 'codium', 'cursor', 'windsurf'];
const VSIX = 'struktek-local.vsix';

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const wanted = requested.length > 0 ? requested : CANDIDATES;

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', shell: true, ...options });
}

function isInstalled(cli) {
  const probe = spawnSync(cli, ['--version'], { stdio: 'ignore', shell: true });
  return probe.status === 0;
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

const build = run('node', ['esbuild.mjs']);
if (build.status !== 0) process.exit(build.status ?? 1);

const pack = run('npx', ['--no-install', '@vscode/vsce', 'package', '-o', VSIX]);
if (pack.status !== 0) process.exit(pack.status ?? 1);

const found = wanted.filter(isInstalled);
if (found.length === 0) {
  console.error('\n[struktek] no editor CLI found on PATH (tried: ' + wanted.join(', ') + ').');
  console.error('[struktek] ' + VSIX + ' is built — install it by hand from the Extensions view.');
  process.exit(1);
}

const failed = [];
for (const cli of found) {
  console.log('\n[struktek] installing into ' + cli + '...');
  const result = run(cli, ['--install-extension', VSIX, '--force']);
  if (result.status !== 0) failed.push(cli);
}

console.log('\n[struktek] struktek ' + version + ' installed into: ' + found.filter((c) => !failed.includes(c)).join(', '));
if (failed.length > 0) console.error('[struktek] failed for: ' + failed.join(', '));
console.log('[struktek] reload the window for the change to take effect.');
process.exit(failed.length > 0 ? 1 : 0);
