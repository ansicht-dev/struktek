/**
 * Assemble the publishable `@struktek/mcp-bridge` package from the built bundle.
 *
 * The package is MIT while the rest of the repository is proprietary. It has to
 * be: its whole purpose is to be fetched and executed on a stranger's machine by
 * `npx`, and an all-rights-reserved licence says nobody may do that.
 *
 * Note what this actually covers. The bundle embeds `src/core` — the template
 * parser — because the bridge renders prompts when no extension host is running.
 * So MIT here applies to the compiled form of that code too, not only to the
 * bridge glue.
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
    'agent as prompts, tools and resources — through the running extension when it is up, ' +
    'straight from disk when it is not.',
  license: 'MIT',
  type: 'commonjs',
  // No `./` prefix and a `git+` scheme: npm rewrites both on publish and warns
  // about it, which means the tarball never quite matches what we generated.
  bin: { 'struktek-mcp-bridge': 'mcp-bridge.js' },
  files: ['mcp-bridge.js', 'README.md', 'LICENSE'],
  engines: { node: '>=18' },
  repository: { ...root.repository, url: 'git+' + String(root.repository.url).replace(/^git\+/, '') },
  homepage: root.homepage,
  keywords: ['mcp', 'model-context-protocol', 'struktek', 'prompt', 'prompt-engineering', 'claude-code', 'codex'],
  publishConfig: { access: 'public' },
};

writeFileSync(join(OUT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(BUNDLE, join(OUT, 'mcp-bridge.js'));

// MIT requires the notice to travel with every copy, so it ships in the tarball
// rather than only being named in package.json.
writeFileSync(
  join(OUT, 'LICENSE'),
  `MIT License

Copyright (c) 2026 Abderraouf Belalia (ansicht)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
);

writeFileSync(
  join(OUT, 'README.md'),
  [
    '# @struktek/mcp-bridge',
    '',
    'Stdio MCP bridge for the [Struktek](' + root.homepage + ') VS Code extension.',
    '',
    'It exposes your prompt templates to an agent three ways at once:',
    '',
    '- **Prompts** — slash commands like `/mcp__struktek__code-review`, each field an',
    '  argument. This is what a template maps onto exactly.',
    '- **Tools** — `struktek_list_templates` and `struktek_compose`, which the model',
    '  itself can see and use when composing prompts for subagents. MCP prompts are',
    '  invisible to the model: you can invoke one, but the agent cannot choose it.',
    '- **Resources** — `struktek://template/{name}` and',
    '  `struktek://block/{type}/{instance}`, returning a file as written. Reading a',
    '  template is the only way to see its wording rather than its fields.',
    '',
    'When the extension is running the bridge proxies to it, so usage stats and',
    'last-used values stay in one place, and `struktek_save_template` and',
    '`struktek_save_block` are offered as well — writing needs a watcher to notice',
    'it and an editor to show it. When the extension is not running, templates are',
    'read straight off disk instead, from the workspace library and the global one',
    'in `~/.struktek`, merged the way the editor merges them. Composing a prompt has',
    'never actually needed an editor.',
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
    '`--global <path>` points at a different global library, and `--no-global`',
    'serves the workspace alone.',
    '',
  ].join('\n'),
);

console.log('[struktek] built ' + OUT + '/ for ' + manifest.name + '@' + manifest.version);
