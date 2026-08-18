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

export interface BlockReader {
  /** Directory names under `blocks/`. */
  listTypes(): Promise<readonly string[]>;
  /** Instance names within one type, without their file extension. */
  listInstances(type: string): Promise<readonly string[]>;
  /** The instance file's contents. */
  readInstance(type: string, instance: string): Promise<string>;
}

export interface BlockLibrary {
  /** Type name to instance name to body text. */
  readonly bodies: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Type name to instance names — what `analyze()` needs to validate a pin. */
  readonly names: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_BLOCK_LIBRARY: BlockLibrary = { bodies: new Map(), names: new Map() };

/**
 * Read every block into memory.
 *
 * Libraries are small — tens of files of a few hundred bytes — so eager loading
 * keeps both the composer and `prompts/get` synchronous once the scan is done,
 * and sidesteps a per-render await on a hot path.
 */
export async function loadBlocks(reader: BlockReader): Promise<BlockLibrary> {
  const bodies = new Map<string, Map<string, string>>();
  const names = new Map<string, readonly string[]>();

  const types = await reader.listTypes();
  for (const type of types) {
    const instances = await reader.listInstances(type);
    const forType = new Map<string, string>();
    for (const instance of instances) {
      try {
        forType.set(instance, await reader.readInstance(type, instance));
      } catch {
        // An unreadable instance is skipped rather than failing the whole scan:
        // one bad file must not take the entire library offline.
      }
    }
    bodies.set(type, forType);
    names.set(type, [...forType.keys()]);
  }

  return { bodies, names };
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
