/**
 * Assemble the publishable `@struktek/mcp-bridge` package from the built bundle.
 *
 * `dist-bridge/` is generated from scratch every time and is gitignored — this
 * script is the source of truth, not the directory. The version is read from the
 * root manifest so the two can never drift.
 *
 * Only the bundle and its README ship. No extension internals, no source.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-bridge';
const BUNDLE = 'out/mcp-bridge.js';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

let bundle;
try {
  bundle = readFileSync(BUNDLE, 'utf8');
} catch {
  console.error('[struktek] ' + BUNDLE + ' is missing — run `node esbuild.mjs --prod` first.');
  process.exit(1);
}

// The shebang is what makes the bundle executable as a bin/npx target. esbuild
// preserves it from cli.ts; if it is gone, publishing would ship something that
// cannot be launched.
if (!bundle.startsWith('#!')) {
  console.error('[struktek] ' + BUNDLE + ' is missing its `#!` shebang — bin/npx would not be executable.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest = {
  name: '@struktek/mcp-bridge',
  version: root.version,
  description:
    'Stdio MCP bridge for the Struktek VS Code extension. Serves your prompt templates to an ' +
    'agent — through the running extension when it is up, straight from disk when it is not.',
  license: 'UNLICENSED',
  type: 'commonjs',
  bin: { 'struktek-mcp-bridge': './mcp-bridge.js' },
  files: ['mcp-bridge.js', 'README.md'],
  engines: { node: '>=18' },
  repository: root.repository,
  homepage: root.homepage,
  keywords: ['mcp', 'model-context-protocol', 'struktek', 'prompt', 'prompt-engineering', 'claude-code', 'codex'],
  publishConfig: { access: 'public' },
};

writeFileSync(join(OUT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(BUNDLE, join(OUT, 'mcp-bridge.js'));

writeFileSync(
  join(OUT, 'README.md'),
  [
    '# @struktek/mcp-bridge',
    '',
    'Stdio MCP bridge for the [Struktek](' + root.homepage + ') VS Code extension.',
    '',
    'It exposes your prompt templates to an agent twice over: as MCP **prompts**, which',
    'show up as slash commands like `/mcp__struktek__code-review`, and as **tools**',
    '(`struktek_list_templates`, `struktek_compose`), which the model itself can see and',
    'use when composing prompts for subagents.',
    '',
    'When the extension is running the bridge proxies to it, so usage stats and',
    'last-used values stay in one place. When it is not, templates are read straight',
    'off disk — composing a prompt has never actually needed an editor.',
    '',
    '## Use',
    '',
    'Run `Struktek: Configure MCP for Agent` in VS Code, or add it by hand:',
    '',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "struktek": {',
    '      "command": "npx",',
    '      "args": ["-y", "@struktek/mcp-bridge", "--workspace", "/path/to/your/project"]',
    '    }',
    '  }',
    '}',
    '```',
    '',
    'The config carries no port and no token — the bridge discovers those itself — so',
    'it is static, committable, and survives restarts.',
    '',
  ].join('\n'),
);

console.log('[struktek] built ' + OUT + '/ for ' + manifest.name + '@' + manifest.version);
