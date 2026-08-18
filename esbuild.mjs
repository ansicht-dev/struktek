/**
 * Bundler.
 *
 * Two bundles today, both CommonJS/node18:
 *
 *   src/extension.ts     -> out/extension.js    the extension host
 *   src/mcpBridge/cli.ts -> out/mcp-bridge.js   the standalone stdio bridge
 *
 * The bridge keeps its `#!` shebang through the build — that is what makes the
 * bundle directly executable as a `bin`/`npx` target, and
 * `scripts/build-bridge-package.mjs` refuses to publish without it.
 *
 * Source maps are off in production: a `.map` is the easiest path back to
 * readable source, so we do not ship one.
 */

import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

/** Apply the production overrides to a base config. */
function withProdFlags(base) {
  if (!prod) return base;
  return {
    ...base,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    drop: ['debugger'],
    pure: ['console.debug'],
  };
}

const extension = withProdFlags({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Supplied by the extension host at runtime; bundling it would break loading.
  external: ['vscode'],
  sourcemap: true,
  minify: false,
});

const bridgeEntry = 'src/mcpBridge/cli.ts';
const bridge = withProdFlags({
  entryPoints: [bridgeEntry],
  outfile: 'out/mcp-bridge.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
});

// The bridge lands in a later milestone; building it only when the entry exists
// keeps `npm run build` working in between.
const configs = existsSync(bridgeEntry) ? [extension, bridge] : [extension];

if (watch) {
  const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[struktek] watching...');
} else {
  for (const config of configs) await esbuild.build(config);
  console.log('[struktek] built ' + configs.length + ' bundle(s)' + (prod ? ' (production)' : ''));
}
