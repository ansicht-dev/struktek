/**
 * The block library — user-defined types.
 *
 * A directory under `blocks/` IS a type; the files inside it are the instances:
 *
 *   blocks/output-format/json-strict.md    -> type `output-format`, instance `json-strict`
 *   blocks/output-format/markdown-table.md
 *
 * There is no registry and no schema to keep in step. Dropping in
 * `blocks/output-format/csv.md` makes `csv` valid in every template that has an
 * `output-format` field — extend the type once, everything using it gains the
 * option. That compounding is the reason blocks exist rather than a flat list of
 * snippets.
 *
 * Filesystem access is INJECTED. The extension host reads through the VS Code
 * workspace API, the standalone MCP bridge reads through `node:fs`, and tests
 * pass a literal map — all three run this exact code.
 */

import { coerceTags, splitDocument, type YamlParser } from './template';
import type { BlockMeta } from './types';

export interface BlockReader {
  /** Directory names under `blocks/`. */
  listTypes(): Promise<readonly string[]>;
  /** Instance names within one type, without their file extension. */
  listInstances(type: string): Promise<readonly string[]>;
  /** The instance file's contents. */
  readInstance(type: string, instance: string): Promise<string>;
}

export interface BlockLibrary {
  /** Type name to instance name to body text, with any header already stripped. */
  readonly bodies: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Type name to instance name to its header. Always present, often empty. */
  readonly meta: ReadonlyMap<string, ReadonlyMap<string, BlockMeta>>;
  /** Type name to instance names — what `analyze()` needs to validate a pin. */
  readonly names: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_BLOCK_LIBRARY: BlockLibrary = {
  bodies: new Map(),
  meta: new Map(),
  names: new Map(),
};

/**
 * Read every block into memory.
 *
 * Libraries are small — tens of files of a few hundred bytes — so eager loading
 * keeps both the composer and `prompts/get` synchronous once the scan is done,
 * and sidesteps a per-render await on a hot path.
 */
export interface LoadBlocksOptions {
  /**
   * Supply it to honour block headers; omit it and every file is pure body.
   *
   * Optional because the header is a convenience for the library UI, not part
   * of what a prompt says — a caller that only renders does not need YAML.
   */
  readonly parseYaml?: YamlParser;
}

export async function loadBlocks(
  reader: BlockReader,
  opts: LoadBlocksOptions = {},
): Promise<BlockLibrary> {
  const bodies = new Map<string, Map<string, string>>();
  const meta = new Map<string, Map<string, BlockMeta>>();
  const names = new Map<string, readonly string[]>();

  const types = await reader.listTypes();
  for (const type of types) {
    const instances = await reader.listInstances(type);
    const forType = new Map<string, string>();
    const metaForType = new Map<string, BlockMeta>();
    for (const instance of instances) {
      try {
        const file = readBlockFile(await reader.readInstance(type, instance), opts.parseYaml);
        forType.set(instance, file.body);
        if (file.meta) metaForType.set(instance, file.meta);
      } catch {
        // An unreadable instance is skipped rather than failing the whole scan:
        // one bad file must not take the entire library offline.
      }
    }
    bodies.set(type, forType);
    meta.set(type, metaForType);
    names.set(type, [...forType.keys()]);
  }

  return { bodies, meta, names };
}

export interface BlockFile {
  readonly body: string;
  readonly meta?: BlockMeta;
}

/**
 * Split one block file into what renders and what only describes it.
 *
 * Shared by every reader — the async library, the bridge's synchronous one —
 * so a header can never be stripped by one and rendered by the other.
 */
export function readBlockFile(source: string, parseYaml?: YamlParser): BlockFile {
  const split = splitDocument(source);
  if (split.yaml === undefined || !parseYaml) return { body: split.body };
  const meta = coerceBlockMeta(split.yaml, parseYaml);
  return { body: split.body, ...(meta ? { meta } : {}) };
}

/**
 * Narrow a block header to the keys we honour.
 *
 * A malformed header degrades to no header rather than losing the block: the
 * body is the substance, and a YAML typo must not remove a value from every
 * template that references its type.
 */
function coerceBlockMeta(yaml: string, parseYaml: YamlParser): BlockMeta | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : undefined;

  const title = text('title') ?? text('name');
  const description = text('description');
  const note = text('note');
  const tags = coerceTags(record['tags']) ?? [];
  if (!title && !description && !note && tags.length === 0) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    tags,
    ...(note ? { note } : {}),
  };
}

/** An in-memory reader, for tests and for previewing an unsaved library. */
export function mapBlockReader(source: Readonly<Record<string, Readonly<Record<string, string>>>>): BlockReader {
  return {
    listTypes: async () => Object.keys(source),
    listInstances: async (type) => Object.keys(source[type] ?? {}),
    readInstance: async (type, instance) => {
      const body = source[type]?.[instance];
      if (body === undefined) throw new Error('No such block instance: ' + type + '/' + instance);
      return body;
    },
  };
}
