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
  readBlockFile,
  type BlockLibrary,
  type BlockMeta,
  type TemplateModel,
} from '../core';

const TEXT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.prompt'];
const TTL_MS = 2000;

export interface DiskLibraryOptions {
  /** Absolute path to the library root (the folder holding `templates/`). */
  readonly root: string;
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

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.readAt < (this.options.ttlMs ?? TTL_MS)) return;
    this.readAt = now;
    this.cachedBlocks = this.readBlocks();
    this.cachedTemplates = this.readTemplates(this.cachedBlocks);
  }

  private readBlocks(): BlockLibrary {
    const root = path.join(this.options.root, 'blocks');
    const bodies = new Map<string, Map<string, string>>();
    const meta = new Map<string, Map<string, BlockMeta>>();
    const sources = new Map<string, Map<string, string>>();
    const names = new Map<string, readonly string[]>();

    for (const type of listDirectories(root)) {
      const forType = new Map<string, string>();
      const metaForType = new Map<string, BlockMeta>();
      const sourceForType = new Map<string, string>();
      for (const filename of listTextFiles(path.join(root, type))) {
        try {
          // Through the same splitter the extension host uses, so a block with
          // a header renders identically whether VS Code is running or not.
          const raw = fs.readFileSync(path.join(root, type, filename), 'utf8');
          const file = readBlockFile(raw, parseYaml);
          forType.set(stem(filename), file.body);
          sourceForType.set(stem(filename), raw);
          if (file.meta) metaForType.set(stem(filename), file.meta);
        } catch {
          // One unreadable instance must not take the type offline.
        }
      }
      bodies.set(type, forType);
      meta.set(type, metaForType);
      sources.set(type, sourceForType);
      names.set(type, [...forType.keys()]);
    }
    return { bodies, meta, sources, names };
  }

  private readTemplates(blocks: BlockLibrary): readonly TemplateModel[] {
    const dir = path.join(this.options.root, 'templates');
    const models: TemplateModel[] = [];
    for (const filename of listTextFiles(dir)) {
      try {
        const source = fs.readFileSync(path.join(dir, filename), 'utf8');
        models.push(
          loadTemplate(source, { name: stem(filename), parseYaml, blockTypes: blocks.names }),
        );
      } catch {
        // Skip and keep going — a malformed file is not a reason to serve none.
      }
    }
    return models;
  }
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
