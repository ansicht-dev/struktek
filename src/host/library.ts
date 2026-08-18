/**
 * The on-disk template library, loaded through the VS Code filesystem API.
 *
 * Layout, relative to the configured library root (default `.struktek`):
 *
 *   templates/<name>.md          one template per file
 *   blocks/<type>/<instance>.md  a directory IS a type; its files are instances
 *   .runtime/                    per-session state, self-ignoring
 *
 * `vscode.workspace.fs` rather than `node:fs` so the extension keeps working in
 * remote and virtual workspaces, where the library may not be on a local disk at
 * all. The parsing itself lives in `core/` and knows nothing about any of this —
 * this module only supplies bytes.
 */

import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import {
  EMPTY_BLOCK_LIBRARY,
  loadBlocks,
  loadTemplate,
  type BlockLibrary,
  type BlockReader,
  type TemplateModel,
} from '../core';
import { log } from './log';

import { BLOCKS_DIR, RUNTIME_DIR, TEMPLATES_DIR } from './paths';

export { BLOCKS_DIR, RUNTIME_DIR, TEMPLATES_DIR };

/** Files we treat as templates or block instances. */
const TEXT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.prompt'];

export interface TemplateEntry {
  readonly uri: vscode.Uri;
  readonly model: TemplateModel;
}

export class Library implements vscode.Disposable {
  private templates = new Map<string, TemplateEntry>();
  private blockLibrary: BlockLibrary = EMPTY_BLOCK_LIBRARY;
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires after a reload triggered by a file change. */
  readonly onDidChange = this.changed.event;

  constructor(readonly root: vscode.Uri) {}

  get runtimeDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, RUNTIME_DIR);
  }

  get blocks(): BlockLibrary {
    return this.blockLibrary;
  }

  list(): readonly TemplateEntry[] {
    return [...this.templates.values()];
  }

  names(): readonly string[] {
    return [...this.templates.keys()];
  }

  get(name: string): TemplateEntry | undefined {
    return this.templates.get(name);
  }

  /**
   * Locate a block instance's file.
   *
   * Instance names have had their extension stripped, so the directory has to
   * be re-read to find which file actually backs one — the library holds
   * bodies, not paths.
   */
  async blockUri(type: string, instance: string): Promise<vscode.Uri | undefined> {
    const dir = vscode.Uri.joinPath(this.root, BLOCKS_DIR, type);
    for (const [filename, fileType] of await readDirectory(dir)) {
      if (fileType !== vscode.FileType.File || !isTextFile(filename)) continue;
      if (stem(filename) === instance) return vscode.Uri.joinPath(dir, filename);
    }
    return undefined;
  }

  /**
   * Rescan the library.
   *
   * Blocks load first because `analyze()` needs the block-type names to tell an
   * unknown type from a legitimate one, and to validate a pinned instance.
   */
  async reload(): Promise<void> {
    this.blockLibrary = await this.readBlocks();
    this.templates = await this.readTemplates(this.blockLibrary);
    log('Library loaded', {
      templates: this.templates.size,
      blockTypes: this.blockLibrary.names.size,
    });
  }

  /**
   * Reload on any change under the library root.
   *
   * Debounced because a single editor save, a git checkout, or a multi-file
   * paste all produce bursts of events, and a rescan of a few dozen small files
   * is cheap enough that granular invalidation would be complexity for nothing.
   */
  watch(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, '{' + TEMPLATES_DIR + ',' + BLOCKS_DIR + '}/**'),
    );
    const schedule = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reload().then(() => this.changed.fire());
      }, 250);
    };
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.dispose();
    this.changed.dispose();
  }

  private async readTemplates(blocks: BlockLibrary): Promise<Map<string, TemplateEntry>> {
    const dir = vscode.Uri.joinPath(this.root, TEMPLATES_DIR);
    const out = new Map<string, TemplateEntry>();
    for (const [filename, type] of await readDirectory(dir)) {
      if (type !== vscode.FileType.File || !isTextFile(filename)) continue;
      const uri = vscode.Uri.joinPath(dir, filename);
      try {
        const source = await readText(uri);
        const model = loadTemplate(source, {
          name: stem(filename),
          parseYaml,
          blockTypes: blocks.names,
        });
        if (out.has(model.name)) {
          log.warn('Duplicate template name — the later file wins', {
            name: model.name,
            file: filename,
          });
        }
        out.set(model.name, { uri, model });
      } catch (err) {
        // One malformed file must not take the whole library offline.
        log.warn('Skipped an unreadable template', { file: filename, error: String(err) });
      }
    }
    return out;
  }

  private async readBlocks(): Promise<BlockLibrary> {
    const root = vscode.Uri.joinPath(this.root, BLOCKS_DIR);
    // Instance names drop their extension, so the real filename has to be
    // remembered to read the body back.
    const filenames = new Map<string, Map<string, string>>();

    const reader: BlockReader = {
      listTypes: async () =>
        (await readDirectory(root))
          .filter(([, type]) => type === vscode.FileType.Directory)
          .map(([name]) => name),

      listInstances: async (type) => {
        const entries = (await readDirectory(vscode.Uri.joinPath(root, type))).filter(
          ([name, fileType]) => fileType === vscode.FileType.File && isTextFile(name),
        );
        const forType = new Map<string, string>();
        for (const [filename] of entries) forType.set(stem(filename), filename);
        filenames.set(type, forType);
        return [...forType.keys()];
      },

      readInstance: async (type, instance) => {
        const filename = filenames.get(type)?.get(instance);
        if (!filename) throw new Error('No file for block ' + type + '/' + instance);
        return readText(vscode.Uri.joinPath(root, type, filename));
      },
    };

    return loadBlocks(reader);
  }
}

/** Resolve the library root, or undefined when no folder is open. */
export function resolveLibraryRoot(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const configured = vscode.workspace
    .getConfiguration('struktek')
    .get<string>('libraryPath', '.struktek');
  return vscode.Uri.joinPath(folder.uri, configured);
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return [...(await vscode.workspace.fs.readDirectory(uri))];
  } catch {
    // A library that does not exist yet is empty, not broken.
    return [];
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function isTextFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}
