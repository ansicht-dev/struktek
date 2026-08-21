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
import type { BlockMeta, LibraryScope } from './types';

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
  /** The file as written, header and all — what a reader or an editor needs. */
  readonly sources: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Which library each instance came from.
   *
   * Empty when the loader did not say — a reader that only renders has no use
   * for provenance, and demanding one would make every test construct it.
   */
  readonly scopes: ReadonlyMap<string, ReadonlyMap<string, LibraryScope>>;
  /** Type name to instance names — what `analyze()` needs to validate a pin. */
  readonly names: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_BLOCK_LIBRARY: BlockLibrary = {
  bodies: new Map(),
  meta: new Map(),
  sources: new Map(),
  scopes: new Map(),
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
  /**
   * Stamped onto every instance this reader yields.
   *
   * Recorded per instance rather than per library because libraries get merged
   * — once two are folded together the only place provenance can survive is on
   * the instance itself.
   */
  readonly scope?: LibraryScope;
}

export async function loadBlocks(
  reader: BlockReader,
  opts: LoadBlocksOptions = {},
): Promise<BlockLibrary> {
  const bodies = new Map<string, Map<string, string>>();
  const meta = new Map<string, Map<string, BlockMeta>>();
  const sources = new Map<string, Map<string, string>>();
  const scopes = new Map<string, Map<string, LibraryScope>>();
  const names = new Map<string, readonly string[]>();

  const types = await reader.listTypes();
  for (const type of types) {
    const instances = await reader.listInstances(type);
    const forType = new Map<string, string>();
    const metaForType = new Map<string, BlockMeta>();
    const sourceForType = new Map<string, string>();
    const scopeForType = new Map<string, LibraryScope>();
    for (const instance of instances) {
      try {
        const raw = await reader.readInstance(type, instance);
        const file = readBlockFile(raw, opts.parseYaml);
        forType.set(instance, file.body);
        sourceForType.set(instance, raw);
        if (opts.scope) scopeForType.set(instance, opts.scope);
        if (file.meta) metaForType.set(instance, file.meta);
      } catch {
        // An unreadable instance is skipped rather than failing the whole scan:
        // one bad file must not take the entire library offline.
      }
    }
    bodies.set(type, forType);
    meta.set(type, metaForType);
    sources.set(type, sourceForType);
    scopes.set(type, scopeForType);
    names.set(type, [...forType.keys()]);
  }

  return { bodies, meta, sources, scopes, names };
}

/**
 * One block instance a merge hid behind another of the same name.
 *
 * Kept rather than dropped so the library can show that a global value is
 * there and being overridden. Without it, "why is my global block not the one
 * rendering" has no visible answer anywhere in the UI.
 */
export interface ShadowedBlock {
  readonly type: string;
  readonly instance: string;
  /** The library the hidden copy is in — where to go to edit or delete it. */
  readonly scope: LibraryScope;
  /**
   * The hidden copy's own body and header, not the winner's.
   *
   * Carried here because the merged library no longer holds either: it keeps
   * one entry per name. Without them a UI listing the shadowed value would
   * describe it using the text of the thing that displaced it, which is worse
   * than not listing it at all.
   */
  readonly body: string;
  readonly meta?: BlockMeta;
}

export interface MergedBlocks {
  readonly library: BlockLibrary;
  readonly shadowed: readonly ShadowedBlock[];
}

/**
 * Fold several block libraries into one, later arguments winning.
 *
 * Types union: a type that exists only globally is as usable as a local one,
 * and that is most of the point of a global library — `blocks/depth/` written
 * once makes `depth` a valid field type in every workspace. Instances collide
 * by name WITHIN a type and the last library passed wins, so callers pass them
 * in precedence order: global first, workspace last.
 *
 * Merging here rather than inside each loader is deliberate. The extension host
 * reads through the VS Code filesystem API and the bridge reads through
 * `node:fs`; if they resolved a collision differently, the sidebar and the agent
 * would disagree about which block a template actually renders.
 */
export function mergeBlockLibraries(...libraries: readonly BlockLibrary[]): MergedBlocks {
  const present = libraries.filter((library) => library.names.size > 0);
  // The overwhelmingly common case is one library, and rebuilding every map to
  // arrive back at it would be work for nothing.
  if (present.length === 0) return { library: EMPTY_BLOCK_LIBRARY, shadowed: [] };
  if (present.length === 1) return { library: present[0]!, shadowed: [] };

  const bodies = new Map<string, Map<string, string>>();
  const meta = new Map<string, Map<string, BlockMeta>>();
  const sources = new Map<string, Map<string, string>>();
  const scopes = new Map<string, Map<string, LibraryScope>>();
  const names = new Map<string, readonly string[]>();
  const shadowed: ShadowedBlock[] = [];

  const bucket = <T>(map: Map<string, Map<string, T>>, type: string): Map<string, T> => {
    const existing = map.get(type);
    if (existing) return existing;
    const created = new Map<string, T>();
    map.set(type, created);
    return created;
  };

  for (const library of present) {
    for (const [type, instances] of library.names) {
      const bodiesForType = bucket(bodies, type);
      const metaForType = bucket(meta, type);
      const sourcesForType = bucket(sources, type);
      const scopesForType = bucket(scopes, type);
      for (const instance of instances) {
        const body = library.bodies.get(type)?.get(instance);
        if (body === undefined) continue;
        const losing = scopesForType.get(instance);
        const losingBody = bodiesForType.get(instance);
        // Same name, earlier library: still on disk, still worth naming, just
        // not what renders any more. Captured BEFORE the overwrite below,
        // which is the last moment its body exists in this map.
        if (losingBody !== undefined && losing) {
          const losingMeta = metaForType.get(instance);
          shadowed.push({
            type,
            instance,
            scope: losing,
            body: losingBody,
            ...(losingMeta ? { meta: losingMeta } : {}),
          });
        }
        bodiesForType.set(instance, body);
        // The winner's header replaces the loser's WHOLE header rather than
        // being spread over it: a block that deliberately drops the global
        // one's description should not inherit it back.
        const instanceMeta = library.meta.get(type)?.get(instance);
        if (instanceMeta) metaForType.set(instance, instanceMeta);
        else metaForType.delete(instance);
        const source = library.sources.get(type)?.get(instance);
        if (source !== undefined) sourcesForType.set(instance, source);
        const scope = library.scopes.get(type)?.get(instance);
        if (scope) scopesForType.set(instance, scope);
      }
    }
  }

  for (const [type, instances] of bodies) names.set(type, [...instances.keys()]);
  return { library: { bodies, meta, sources, scopes, names }, shadowed };
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
