/**
 * Template file to `TemplateModel` — frontmatter split, then parse, then analyze.
 *
 * Frontmatter is entirely optional. Inline annotation (`{{ target: file "..." }}`)
 * covers the common case with the field name appearing exactly once, and
 * frontmatter is the escape hatch for what inline cannot carry gracefully:
 * defaults, and descriptions long enough to wreck the body's readability.
 * Where both are present frontmatter wins, so an agent-facing template can
 * document its arguments without the author rewriting the prose.
 */

import { parse } from './parse';
import { analyze, type AnalyzeOptions } from './analyze';
import type { Frontmatter, TemplateModel } from './types';

export interface SplitTemplate {
  readonly frontmatter?: Frontmatter;
  readonly body: string;
  /** Offset of `body` within the original file, so spans point at real lines. */
  readonly bodyOffset: number;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split leading `--- ... ---` frontmatter off the body.
 *
 * `bodyOffset` is why this returns a struct rather than a tuple: every span the
 * parser produces is an offset into the ORIGINAL file, so an editor can put a
 * squiggle on the right character without the caller re-deriving the shift.
 */
export function splitFrontmatter(source: string, parseYaml: YamlParser): SplitTemplate {
  const match = FRONTMATTER.exec(source);
  if (!match) return { body: source, bodyOffset: 0 };
  const bodyOffset = match[0].length;
  const frontmatter = coerceFrontmatter(parseYaml(match[1] ?? ''));
  return {
    ...(frontmatter ? { frontmatter } : {}),
    body: source.slice(bodyOffset),
    bodyOffset,
  };
}

/**
 * A YAML parse function, injected.
 *
 * `core/` stays free of any particular YAML implementation so the same code
 * runs in the extension host, the bridge, and a browser.
 */
export type YamlParser = (source: string) => unknown;

export interface LoadTemplateOptions extends Omit<AnalyzeOptions, 'frontmatter'> {
  readonly parseYaml: YamlParser;
}

/** The whole pipeline: file text in, model out. */
export function loadTemplate(source: string, opts: LoadTemplateOptions): TemplateModel {
  const split = splitFrontmatter(source, opts.parseYaml);
  const parsed = parse(split.body, split.bodyOffset);
  return analyze(parsed, {
    name: opts.name,
    ...(split.frontmatter ? { frontmatter: split.frontmatter } : {}),
    ...(opts.blockTypes ? { blockTypes: opts.blockTypes } : {}),
  });
}

/**
 * Narrow arbitrary parsed YAML to the fields we honour.
 *
 * Malformed frontmatter degrades to "no frontmatter" rather than failing the
 * template: the body is the substance, and a typo in an optional header should
 * not take the prompt away from the author.
 */
function coerceFrontmatter(raw: unknown): Frontmatter | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'] : undefined;
  const description = typeof record['description'] === 'string' ? record['description'] : undefined;

  let args: Record<string, { type?: string; description?: string; default?: string }> | undefined;
  const rawArgs = record['args'];
  if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
    args = {};
    for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
      if (typeof value === 'string') {
        args[key] = { type: value };
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const type = typeof entry['type'] === 'string' ? entry['type'] : undefined;
      const desc = typeof entry['description'] === 'string' ? entry['description'] : undefined;
      // A numeric default is legitimate for a `number` field; normalise to text
      // because every value the renderer substitutes is a string.
      const def =
        typeof entry['default'] === 'string'
          ? entry['default']
          : typeof entry['default'] === 'number'
            ? String(entry['default'])
            : undefined;
      args[key] = {
        ...(type ? { type } : {}),
        ...(desc ? { description: desc } : {}),
        ...(def !== undefined ? { default: def } : {}),
      };
    }
  }

  if (!name && !description && !args) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(args ? { args } : {}),
  };
}
