/**
 * Bundler.
 *
 * Four bundles:
 *
 *   src/extension.ts     -> out/extension.js      the extension host  (cjs/node)
 *   src/mcpBridge/cli.ts -> out/mcp-bridge.js     the stdio bridge    (cjs/node)
 *   webview/panel.ts     -> out/webview/panel.js  the panel UI        (iife/browser)
 *   webview/sidebar.ts   -> out/webview/sidebar.js the sidebar UI     (iife/browser)
 *
 * The webview bundle is browser-targeted and pulls in `src/core` directly, so
 * the preview runs the real renderer in the frame rather than a copy of it.
 *
 * The codicon font is copied in beside them. The sidebar frame draws rows that
 * a TreeView would otherwise have drawn, and it uses the workbench's own icon
 * font to do it rather than glyphs that merely resemble one.
 *
 * The bridge keeps its `#!` shebang through the build — that is what makes the
 * bundle directly executable as a `bin`/`npx` target, and
 * `scripts/build-bridge-package.mjs` refuses to publish without it.
 *
 * Source maps are off in production: a `.map` is the easiest path back to
 * readable source, so we do not ship one.
 */

import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

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

const panel = withProdFlags({
  entryPoints: ['webview/panel.ts'],
  outfile: 'out/webview/panel.js',
  bundle: true,
  // Loaded by a plain <script nonce> tag under a strict CSP - no module loader
  // is available in the frame, so iife rather than esm.
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: false,
});

// Same shape as the panel bundle, and for the same reason: a second <script
// nonce> tag in a second frame, with no module loader behind either of them.
const sidebar = withProdFlags({
  entryPoints: ['webview/sidebar.ts'],
  outfile: 'out/webview/sidebar.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
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

/**
 * Copy the codicon font next to the webview bundles.
 *
 * Shipped rather than linked: a webview cannot reach node_modules, and the
 * stylesheet resolves the .ttf relative to itself, so the two files have to
 * travel together into out/webview/.
 */
function copyCodicons() {
  const from = 'node_modules/@vscode/codicons/dist/';
  mkdirSync('out/webview', { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    copyFileSync(from + file, 'out/webview/' + file);
  }
}

// The bridge lands in a later milestone; building it only when the entry exists
// keeps `npm run build` working in between.
const configs = existsSync(bridgeEntry)
  ? [extension, bridge, panel, sidebar]
  : [extension, panel, sidebar];

copyCodicons();

if (watch) {
  const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[struktek] watching...');
} else {
  for (const config of configs) await esbuild.build(config);
  console.log('[struktek] built ' + configs.length + ' bundle(s)' + (prod ? ' (production)' : ''));
}
