/**
 * A `LibraryView` backed by plain `node:fs`.
 *
 * This is what makes struktek answer with VS Code closed. Templates and blocks
 * are files, so the bridge can read them itself; nothing about composing a
 * prompt actually requires a running editor. What the live host adds is usage
 * recording and sticky values, which is why this view has no `record` — writing
 * stats from a second process would put two writers on one file for a
 * convenience nobody would miss.
 *
 * Both library roots are read, the workspace one shadowing the global one by
 * name, exactly as the extension host merges them. That has to match: an agent
 * asking for `code-review` at 2am in a bare terminal must get the same file the
 * sidebar shows, or the global library would mean one thing in the editor and
 * another to the agent it exists to serve.
 *
 * Re-read on a short TTL rather than cached forever: a template edited in
 * another editor should show up without restarting the agent, and the whole
 * library is a few dozen small files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  EMPTY_BLOCK_LIBRARY,
  loadTemplate,
  mergeBlockLibraries,
  readBlockFile,
  type BlockLibrary,
  type BlockMeta,
  type LibraryScope,
  type TemplateModel,
} from '../core';

const TEXT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.prompt'];
const TTL_MS = 2000;

export interface DiskLibraryOptions {
  /** Absolute path to the workspace library root (the folder holding `templates/`). */
  readonly root: string;
  /** Absolute path to the global library root, when there is one. */
  readonly globalRoot?: string;
  readonly ttlMs?: number;
}

export class DiskLibrary {
  private cachedTemplates: readonly TemplateModel[] = [];
  private cachedBlocks: BlockLibrary = EMPTY_BLOCK_LIBRARY;
  private readAt = 0;

  constructor(private readonly options: DiskLibraryOptions) {}

  templates(): readonly TemplateModel[] {
    this.refreshIfStale();
    return this.cachedTemplates;
  }

  blocks(): BlockLibrary {
    this.refreshIfStale();
    return this.cachedBlocks;
  }

  /**
   * The roots to read, in precedence order, lowest first.
   *
   * Deduplicated by resolved path for the same reason the host does it: a
   * bridge launched with `--workspace ~` would otherwise read one folder as
   * both libraries and report everything in it as shadowing itself.
   */
  private scanOrder(): readonly (readonly [LibraryScope, string])[] {
    const workspace = path.resolve(this.options.root);
    const out: (readonly [LibraryScope, string])[] = [];
    const globalRoot = this.options.globalRoot ? path.resolve(this.options.globalRoot) : undefined;
    if (globalRoot && !samePath(globalRoot, workspace)) out.push(['global', globalRoot]);
    out.push(['workspace', workspace]);
    return out;
  }

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.readAt < (this.options.ttlMs ?? TTL_MS)) return;
    this.readAt = now;

    const scopes = this.scanOrder();
    // Merged before any template is analysed: a workspace template is entitled
    // to a field typed with a globally-defined block type, and analysing it
    // against the workspace's blocks alone would call that an unknown type.
    this.cachedBlocks = mergeBlockLibraries(
      ...scopes.map(([scope, root]) => this.readBlocks(root, scope)),
    ).library;

    const resolved = new Map<string, TemplateModel>();
    for (const [scope, root] of scopes) {
      for (const model of this.readTemplates(root, scope, this.cachedBlocks)) {
        resolved.set(model.name, model);
      }
    }
    this.cachedTemplates = [...resolved.values()];
  }

  private readBlocks(root: string, scope: LibraryScope): BlockLibrary {
    const blocksRoot = path.join(root, 'blocks');
    const bodies = new Map<string, Map<string, string>>();
    const meta = new Map<string, Map<string, BlockMeta>>();
    const sources = new Map<string, Map<string, string>>();
    const scopes = new Map<string, Map<string, LibraryScope>>();
    const names = new Map<string, readonly string[]>();

    for (const type of listDirectories(blocksRoot)) {
      const forType = new Map<string, string>();
      const metaForType = new Map<string, BlockMeta>();
      const sourceForType = new Map<string, string>();
      const scopeForType = new Map<string, LibraryScope>();
      for (const filename of listTextFiles(path.join(blocksRoot, type))) {
        try {
          // Through the same splitter the extension host uses, so a block with
          // a header renders identically whether VS Code is running or not.
          const raw = fs.readFileSync(path.join(blocksRoot, type, filename), 'utf8');
          const file = readBlockFile(raw, parseYaml);
          forType.set(stem(filename), file.body);
          sourceForType.set(stem(filename), raw);
          scopeForType.set(stem(filename), scope);
          if (file.meta) metaForType.set(stem(filename), file.meta);
        } catch {
          // One unreadable instance must not take the type offline.
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

  private readTemplates(
    root: string,
    scope: LibraryScope,
    blocks: BlockLibrary,
  ): readonly TemplateModel[] {
    const dir = path.join(root, 'templates');
    const models: TemplateModel[] = [];
    for (const filename of listTextFiles(dir)) {
      try {
        const source = fs.readFileSync(path.join(dir, filename), 'utf8');
        models.push(
          loadTemplate(source, {
            name: stem(filename),
            parseYaml,
            blockTypes: blocks.names,
            scope,
          }),
        );
      } catch {
        // Skip and keep going — a malformed file is not a reason to serve none.
      }
    }
    return models;
  }
}

/** Case-insensitive on Windows, where two spellings name one folder. */
function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string =>
    process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalise(a) === normalise(b);
}

function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listTextFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}
