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

/** A split with the header still as raw YAML text — nothing interpreted yet. */
export interface SplitDocument {
  /** The text between the fences, absent when the file has no header. */
  readonly yaml?: string;
  readonly body: string;
  readonly bodyOffset: number;
}

const FRONTMATTER = /^\ufeff?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split leading `--- ... ---` off the body, without interpreting it.
 *
 * Templates and blocks share the fence but not the vocabulary inside it, so the
 * split and the coercion are separate steps — each caller narrows the YAML to
 * the keys it honours.
 *
 * `bodyOffset` is why this returns a struct rather than a tuple: every span the
 * parser produces is an offset into the ORIGINAL file, so an editor can put a
 * squiggle on the right character without the caller re-deriving the shift.
 */
export function splitDocument(source: string): SplitDocument {
  const match = FRONTMATTER.exec(source);
  if (!match) return { body: source, bodyOffset: 0 };
  const bodyOffset = match[0].length;
  return { yaml: match[1] ?? '', body: source.slice(bodyOffset), bodyOffset };
}

/** Split, then narrow the header to the keys a template honours. */
export function splitFrontmatter(source: string, parseYaml: YamlParser): SplitTemplate {
  const split = splitDocument(source);
  if (split.yaml === undefined) return { body: split.body, bodyOffset: split.bodyOffset };
  const frontmatter = coerceFrontmatter(parseYaml(split.yaml));
  return {
    ...(frontmatter ? { frontmatter } : {}),
    body: split.body,
    bodyOffset: split.bodyOffset,
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
  const tags = coerceTags(record['tags']);
  const note = typeof record['note'] === 'string' ? record['note'] : undefined;

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

  if (!name && !description && !args && !tags && !note) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(note ? { note } : {}),
    ...(args ? { args } : {}),
  };
}

/**
 * Accept tags as a YAML list or a comma-separated string.
 *
 * `tags: [review, quality]` and `tags: review, quality` both read naturally to
 * someone typing frontmatter by hand, and rejecting either would be a papercut
 * with no upside. Values are lowercased and de-duplicated so `Review` and
 * `review` do not become two entries in the library's filter list.
 */
export function coerceTags(raw: unknown): readonly string[] | undefined {
  const parts =
    typeof raw === 'string'
      ? raw.split(',')
      : Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string')
        : undefined;
  if (!parts) return undefined;
  const seen = new Set<string>();
  for (const part of parts) {
    const tag = part.trim().toLowerCase();
    if (tag.length > 0) seen.add(tag);
  }
  return seen.size > 0 ? [...seen] : undefined;
}
