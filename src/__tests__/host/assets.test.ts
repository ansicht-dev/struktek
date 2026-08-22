/**
 * The image files, checked as files.
 *
 * This suite exists because of a specific escape. An SVG is XML, and XML
 * forbids a double hyphen inside a comment — so a comment written to explain
 * that VS Code sizes the icon with its `--activity-bar-icon-size` variable
 * made the document unparseable, and the activity bar rendered an empty slot
 * with a working tooltip beside it. Nothing caught it: the typechecker does
 * not read assets, the tests did not either, `vsce package` embeds a file
 * without parsing it, and the renderer that produced the preview images was
 * lenient enough to draw it anyway. It shipped, and the first report came from
 * someone installing it from the store.
 *
 * So the rule is now enforced where every other rule in this repo is: an asset
 * the manifest points at has to exist and has to parse.
 *
 * There is no XML parser among the dependencies and this is not worth adding
 * one for, so `wellFormed` implements the parts that can actually break a hand
 * written SVG — comments, tag balance, and the root element. It is not a
 * general parser and does not pretend to be.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const ASSETS = path.join(ROOT, 'assets');

/** Every SVG that ships, by repo-relative path. */
const SVGS = readdirSync(ASSETS)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => path.join('assets', file));

/**
 * Why an SVG would fail to load, in the ways a hand-edited one actually does.
 *
 * Returns the complaint, or undefined when there is nothing to say.
 */
function wellFormed(source: string): string | undefined {
  // Comments: every `<!--` needs a `-->`, and the text between them may not
  // contain `--` at all. This is the one that shipped.
  let at = 0;
  for (;;) {
    const open = source.indexOf('<!--', at);
    if (open === -1) break;
    const close = source.indexOf('-->', open + 4);
    if (close === -1) return 'a comment is never closed';
    const body = source.slice(open + 4, close);
    if (body.includes('--')) {
      const line = source.slice(0, open + 4 + body.indexOf('--')).split('\n').length;
      return 'line ' + line + ': "--" inside a comment, which XML forbids';
    }
    at = close + 3;
  }

  // Tags: balanced, and nothing left open at the end.
  const stack: string[] = [];
  for (const [, closing, name, selfClosing] of source.matchAll(
    /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g,
  )) {
    if (source.slice(0, 0)) continue;
    if (closing === '/') {
      const open = stack.pop();
      if (open !== name) return 'closing </' + name + '> does not match <' + (open ?? 'nothing') + '>';
    } else if (selfClosing !== '/') {
      stack.push(name);
    }
  }
  if (stack.length > 0) return '<' + stack[stack.length - 1] + '> is never closed';

  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/.test(source)) {
    return 'the root element is not <svg>';
  }
  return undefined;
}

describe('the svgs that ship', () => {
  it('finds them', () => {
    expect(SVGS.length).toBeGreaterThan(0);
  });

  it.each(SVGS)('%s is well-formed', (file) => {
    expect(wellFormed(readFileSync(path.join(ROOT, file), 'utf8'))).toBeUndefined();
  });
});

/**
 * The manifest names icons by path, and a path that points at nothing fails
 * silently: VS Code renders an empty slot rather than refusing to load.
 */
describe('every icon the manifest points at', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    icon?: string;
    contributes?: {
      viewsContainers?: Record<string, { id: string; icon?: string }[]>;
    };
  };

  const referenced: string[] = [];
  if (manifest.icon) referenced.push(manifest.icon);
  for (const containers of Object.values(manifest.contributes?.viewsContainers ?? {})) {
    for (const container of containers) if (container.icon) referenced.push(container.icon);
  }

  it('is actually referenced by something', () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(referenced)('%s exists', (file) => {
    expect(existsSync(path.join(ROOT, file)), file + ' is missing').toBe(true);
  });

  /** The panel's tab icon is set in code rather than the manifest. */
  it('includes the one the panel sets itself', () => {
    const panel = readFileSync(path.join(ROOT, 'src/host/panel.ts'), 'utf8');
    const named = [...panel.matchAll(/'(assets\/[\w.-]+)'|'assets',\s*'([\w.-]+)'/g)]
      .map((m) => m[1] ?? 'assets/' + m[2]);
    for (const file of named) {
      expect(existsSync(path.join(ROOT, file)), file + ' is missing').toBe(true);
    }
  });
});
