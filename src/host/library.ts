/**
 * The on-disk template library, loaded through the VS Code filesystem API.
 *
 * Layout, relative to a library root:
 *
 *   templates/<name>.md          one template per file
 *   blocks/<type>/<instance>.md  a directory IS a type; its files are instances
 *   .runtime/                    per-session state, self-ignoring
 *
 * There are TWO such roots. The workspace one (`.struktek` in the open folder)
 * travels with the project and belongs in its git history. The global one
 * (`~/.struktek`) is the user's own, visible from every workspace — the place
 * for the templates you reach for regardless of what you happen to have open.
 * Both have the identical layout, which is what makes moving a file between
 * them a rename rather than a conversion.
 *
 * They are merged into one library, workspace winning on a name collision, the
 * way git config and VS Code settings resolve. The loser is remembered rather
 * than dropped so the UI can say it is being overridden; silently hiding a
 * global template behind a local one is how you lose an afternoon.
 *
 * `vscode.workspace.fs` rather than `node:fs` so the extension keeps working in
 * remote and virtual workspaces, where the library may not be on a local disk at
 * all. The parsing itself lives in `core/` and knows nothing about any of this —
 * this module only supplies bytes.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import {
  EMPTY_BLOCK_LIBRARY,
  loadBlocks,
  loadTemplate,
  mergeBlockLibraries,
  type BlockLibrary,
  type BlockReader,
  type LibraryScope,
  type ShadowedBlock,
  type TemplateModel,
} from '../core';
import { log } from './log';

import {
  BLOCKS_DIR,
  DEFAULT_LIBRARY_DIR,
  globalLibraryPath,
  RUNTIME_DIR,
  TEMPLATES_DIR,
} from './paths';

export { BLOCKS_DIR, DEFAULT_LIBRARY_DIR, RUNTIME_DIR, TEMPLATES_DIR };

/** Files we treat as templates or block instances. */
const TEXT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.prompt'];

export interface TemplateEntry {
  readonly uri: vscode.Uri;
  readonly model: TemplateModel;
  readonly scope: LibraryScope;
  /**
   * When the file was created, in epoch milliseconds. 0 if the filesystem
   * would not say.
   *
   * Read here rather than derived later because it is a property of the file
   * and nothing downstream has the file — the sidebar gets rows, not paths.
   */
  readonly created: number;
}

/**
 * Where the two libraries are, if they are anywhere.
 *
 * Both are optional and independently so: a window with no folder open still
 * has a global library, and a user who has switched the global one off still
 * has their workspace. A session exists as long as at least one is present.
 */
export interface LibraryRoots {
  readonly workspace?: vscode.Uri;
  readonly global?: vscode.Uri;
}

export class Library implements vscode.Disposable {
  private templates = new Map<string, TemplateEntry>();
  private shadowedTemplateEntries: readonly TemplateEntry[] = [];
  private blockLibrary: BlockLibrary = EMPTY_BLOCK_LIBRARY;
  private shadowedBlockInstances: readonly ShadowedBlock[] = [];
  private blockTimes = new Map<string, Map<string, number>>();
  private watchers: vscode.FileSystemWatcher[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires after a reload triggered by a file change. */
  readonly onDidChange = this.changed.event;

  constructor(readonly roots: LibraryRoots) {}

  /**
   * The scope a new file lands in unless something says otherwise.
   *
   * The workspace, whenever there is one: a template written while a project
   * is open is far more often about that project than about everything the
   * user will ever do. With no folder open there is only one place it can go.
   */
  get defaultScope(): LibraryScope {
    return this.roots.workspace ? 'workspace' : 'global';
  }

  /**
   * The root writes go to by default.
   *
   * Present because most callers — seeding, the new-template command, the
   * runtime directory — want "the library" and have no opinion about scope.
   */
  get root(): vscode.Uri {
    const root = this.rootFor(this.defaultScope);
    // A Library is only ever built with at least one root, so this is a type
    // narrowing rather than a real branch.
    if (!root) throw new Error('The library has no root.');
    return root;
  }

  rootFor(scope: LibraryScope): vscode.Uri | undefined {
    return scope === 'global' ? this.roots.global : this.roots.workspace;
  }

  /** True when both libraries are live, so scope is a choice worth offering. */
  get hasBothScopes(): boolean {
    return this.roots.workspace !== undefined && this.roots.global !== undefined;
  }

  /**
   * Where per-session state lives — always beside the writable library.
   *
   * Usage counts and history stay with the workspace even when every template
   * in play is global: "how often do I use this HERE" is the question the
   * ordering answers, and a global count would flatten every project into one.
   */
  get runtimeDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, RUNTIME_DIR);
  }

  get blocks(): BlockLibrary {
    return this.blockLibrary;
  }

  /** Global instances a workspace one of the same name is overriding. */
  get shadowedBlocks(): readonly ShadowedBlock[] {
    return this.shadowedBlockInstances;
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
   * Templates that exist but do not resolve, because a nearer one has the name.
   *
   * Never returned from `list()` or `get()` — they are not part of the library
   * as far as composing is concerned. The sidebar shows them so the override is
   * visible, and promote/demote consults them so it can warn before creating
   * one.
   */
  shadowedTemplates(): readonly TemplateEntry[] {
    return this.shadowedTemplateEntries;
  }

  /** The file a template of this name would occupy in the given scope. */
  templateUri(name: string, scope: LibraryScope): vscode.Uri | undefined {
    const root = this.rootFor(scope);
    return root ? vscode.Uri.joinPath(root, TEMPLATES_DIR, name + '.md') : undefined;
  }

  /**
   * Locate a block instance's file.
   *
   * Instance names have had their extension stripped, so the directory has to
   * be re-read to find which file actually backs one — the library holds
   * bodies, not paths. With no scope given, the resolved instance is found:
   * workspace first, since that is the one that renders.
   */
  async blockUri(
    type: string,
    instance: string,
    scope?: LibraryScope,
  ): Promise<vscode.Uri | undefined> {
    const order: readonly LibraryScope[] = scope ? [scope] : ['workspace', 'global'];
    for (const candidate of order) {
      const root = this.rootFor(candidate);
      if (!root) continue;
      const dir = vscode.Uri.joinPath(root, BLOCKS_DIR, type);
      for (const [filename, fileType] of await readDirectory(dir)) {
        if (fileType !== vscode.FileType.File || !isTextFile(filename)) continue;
        if (stem(filename) === instance) return vscode.Uri.joinPath(dir, filename);
      }
    }
    return undefined;
  }

  /** Which library a block instance actually resolves from. */
  scopeOfBlock(type: string, instance: string): LibraryScope | undefined {
    return this.blockLibrary.scopes.get(type)?.get(instance);
  }

  /**
   * When a block instance's file was created, in epoch milliseconds.
   *
   * Kept beside the block library rather than inside it: `BlockLibrary` is a
   * `core/` type and `core/` has no filesystem, so a timestamp has no business
   * in it. This map is the host's own note about files it read.
   */
  createdAtBlock(type: string, instance: string): number {
    return this.blockTimes.get(type)?.get(instance) ?? 0;
  }

  /**
   * The folder backing a block type, in one scope or wherever it exists.
   *
   * A type can exist in both libraries at once — the merge unions them — so
   * "delete the type" needs to be told which folder it means. Without a scope,
   * the workspace's is preferred, matching how an instance resolves.
   */
  async blockTypeUri(type: string, scope?: LibraryScope): Promise<vscode.Uri | undefined> {
    const order: readonly LibraryScope[] = scope ? [scope] : ['workspace', 'global'];
    for (const candidate of order) {
      const root = this.rootFor(candidate);
      if (!root) continue;
      const dir = vscode.Uri.joinPath(root, BLOCKS_DIR, type);
      try {
        await vscode.workspace.fs.stat(dir);
        return dir;
      } catch {
        // Not in this library; try the next.
      }
    }
    return undefined;
  }

  /** Instances of a type that live in one specific library. */
  instancesInScope(type: string, scope: LibraryScope): readonly string[] {
    const names = this.blockLibrary.names.get(type) ?? [];
    const own = names.filter((instance) => this.scopeOfBlock(type, instance) === scope);
    // Plus any copy this scope holds that a nearer one is overriding.
    for (const block of this.shadowedBlockInstances) {
      if (block.type === type && block.scope === scope) own.push(block.instance);
    }
    return own;
  }

  /**
   * Rescan both libraries.
   *
   * Blocks load first — for both roots, and merged — because `analyze()` needs
   * the block-type names to tell an unknown type from a legitimate one, and a
   * workspace template is perfectly entitled to a field typed with a global
   * block type. Analysing per-root against per-root blocks would report those
   * as unknown types.
   */
  async reload(): Promise<void> {
    const scopes = this.scanOrder();
    // Rebuilt from scratch, so a deleted block does not leave its timestamp
    // behind to be reported for a later file of the same name.
    this.blockTimes = new Map();
    const perRoot = new Map<LibraryScope, BlockLibrary>();
    for (const [scope, root] of scopes) perRoot.set(scope, await this.readBlocks(root, scope));

    // Global first, workspace last: the merge lets the last one win.
    const merged = mergeBlockLibraries(
      ...scopes.map(([scope]) => perRoot.get(scope) ?? EMPTY_BLOCK_LIBRARY),
    );
    this.blockLibrary = merged.library;
    this.shadowedBlockInstances = merged.shadowed;

    const resolved = new Map<string, TemplateEntry>();
    const shadowed: TemplateEntry[] = [];
    for (const [scope, root] of scopes) {
      for (const entry of await this.readTemplates(root, scope, this.blockLibrary)) {
        const previous = resolved.get(entry.model.name);
        // Same precedence order as the blocks: whoever comes later wins, and
        // the one it displaced is kept so the UI can say so.
        if (previous) shadowed.push(previous);
        resolved.set(entry.model.name, entry);
      }
    }
    this.templates = resolved;
    this.shadowedTemplateEntries = shadowed;

    log('Library loaded', {
      templates: this.templates.size,
      blockTypes: this.blockLibrary.names.size,
      shadowedTemplates: shadowed.length,
      shadowedBlocks: merged.shadowed.length,
      scopes: scopes.map(([scope]) => scope).join('+'),
    });
  }

  /**
   * The roots to read, in precedence order, lowest first.
   *
   * Deduplicated by path: a workspace opened ON the home directory makes the
   * two roots the same folder, and reading it twice would report every template
   * in it as shadowing itself.
   */
  private scanOrder(): readonly (readonly [LibraryScope, vscode.Uri])[] {
    const out: (readonly [LibraryScope, vscode.Uri])[] = [];
    const { global: globalRoot, workspace } = this.roots;
    if (globalRoot && !(workspace && sameUri(globalRoot, workspace))) {
      out.push(['global', globalRoot]);
    }
    if (workspace) out.push(['workspace', workspace]);
    return out;
  }

  /**
   * Reload on any change under either library root.
   *
   * Debounced because a single editor save, a git checkout, or a multi-file
   * paste all produce bursts of events, and a rescan of a few dozen small files
   * is cheap enough that granular invalidation would be complexity for nothing.
   *
   * The global root is outside the workspace, which VS Code supports watching
   * so long as the pattern is given a base `Uri` — the same call, a different
   * base.
   */
  watch(): void {
    this.unwatch();
    const schedule = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reload().then(() => this.changed.fire());
      }, 250);
    };
    for (const [, root] of this.scanOrder()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '{' + TEMPLATES_DIR + ',' + BLOCKS_DIR + '}/**'),
      );
      watcher.onDidCreate(schedule);
      watcher.onDidChange(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.unwatch();
    this.changed.dispose();
  }

  private unwatch(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private async readTemplates(
    root: vscode.Uri,
    scope: LibraryScope,
    blocks: BlockLibrary,
  ): Promise<readonly TemplateEntry[]> {
    const dir = vscode.Uri.joinPath(root, TEMPLATES_DIR);
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
          scope,
        });
        if (out.has(model.name)) {
          log.warn('Duplicate template name — the later file wins', {
            name: model.name,
            file: filename,
            scope,
          });
        }
        out.set(model.name, { uri, model, scope, created: await createdAt(uri) });
      } catch (err) {
        // One malformed file must not take the whole library offline.
        log.warn('Skipped an unreadable template', { file: filename, error: String(err) });
      }
    }
    return [...out.values()];
  }

  private async readBlocks(root: vscode.Uri, scope: LibraryScope): Promise<BlockLibrary> {
    const blocksRoot = vscode.Uri.joinPath(root, BLOCKS_DIR);
    // Instance names drop their extension, so the real filename has to be
    // remembered to read the body back.
    const filenames = new Map<string, Map<string, string>>();

    const reader: BlockReader = {
      listTypes: async () =>
        (await readDirectory(blocksRoot))
          .filter(([, type]) => type === vscode.FileType.Directory)
          .map(([name]) => name),

      listInstances: async (type) => {
        const entries = (await readDirectory(vscode.Uri.joinPath(blocksRoot, type))).filter(
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
        const uri = vscode.Uri.joinPath(blocksRoot, type, filename);
        // Noted on the way past: this is the one moment the reader holds both
        // the instance name and the file it came from.
        let times = this.blockTimes.get(type);
        if (!times) {
          times = new Map<string, number>();
          this.blockTimes.set(type, times);
        }
        times.set(instance, await createdAt(uri));
        return readText(uri);
      },
    };

    return loadBlocks(reader, { parseYaml, scope });
  }
}

/** Resolve the workspace library root, or undefined when no folder is open. */
export function resolveLibraryRoot(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const configured = vscode.workspace
    .getConfiguration('struktek')
    .get<string>('libraryPath', DEFAULT_LIBRARY_DIR);
  return vscode.Uri.joinPath(folder.uri, configured);
}

/**
 * Resolve the global library root, or undefined when it is switched off.
 *
 * Defaults to `~/.struktek` rather than the extension's `globalStorageUri`,
 * and that is the load-bearing choice here. The offline bridge — the thing that
 * answers when VS Code is closed — has no extension context to ask, so a
 * library under `globalStorage` would be invisible to exactly the agent
 * sessions the global scope is meant to serve. A home-directory folder is also
 * something a user can commit to their dotfiles, which is how a prompt library
 * survives a new machine.
 */
export function resolveGlobalLibraryRoot(): vscode.Uri | undefined {
  const config = vscode.workspace.getConfiguration('struktek');
  if (!config.get<boolean>('globalLibrary.enabled', true)) return undefined;
  const resolved = globalLibraryPath(config.get<string>('globalLibrary.path', ''), homeDir());
  // A configured path that resolves to nothing — relative, or no home
  // directory to expand against — leaves the user with the workspace library
  // alone rather than a folder somewhere they did not choose.
  if (!resolved) {
    log.warn('No global library root — check struktek.globalLibrary.path');
    return undefined;
  }
  return vscode.Uri.file(resolved);
}

function homeDir(): string | undefined {
  try {
    // Homeless environments exist (some containers); no global library there.
    return os.homedir() || undefined;
  } catch {
    return undefined;
  }
}

/** Case-insensitive on Windows, because the two roots are compared as paths. */
function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme) return false;
  const normalise = (uri: vscode.Uri): string => {
    const fsPath = uri.scheme === 'file' ? path.normalize(uri.fsPath) : uri.path;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  };
  return normalise(a) === normalise(b);
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

/**
 * When a file was created, or 0 when the filesystem will not say.
 *
 * Zero rather than "now": an unknown age must not make a file look like the
 * newest thing in the library. Sorting treats it as oldest, which puts the
 * unknowns together at one end instead of scattering them.
 */
async function createdAt(uri: vscode.Uri): Promise<number> {
  try {
    return (await vscode.workspace.fs.stat(uri)).ctime;
  } catch {
    return 0;
  }
}

function isTextFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}
