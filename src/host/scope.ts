/**
 * Moving a template or a block between the workspace library and the global one.
 *
 * Both libraries have the same layout, so this is a file move and nothing else
 * — no format to convert, no id to rewrite, no index to keep in step. What the
 * module actually exists for is the three things that are NOT just a move:
 *
 *   - a name already taken in the destination, which would silently shadow one
 *     copy behind the other rather than fail;
 *   - a template promoted away from block types that only exist in this
 *     workspace, which reads fine here and reports unknown types everywhere
 *     else — the failure only shows up in a different project, days later;
 *   - demotion, which takes a template OUT of every other workspace, and is the
 *     one direction that can lose you something you were relying on.
 *
 * Each of those gets asked about before anything is written. Nothing here
 * refreshes the UI: the library watches both roots and repaints itself.
 */

import * as vscode from 'vscode';
import type { Field, LibraryScope } from '../core';
import { Library, BLOCKS_DIR } from './library';
import { log } from './log';

/** What can be moved. A block type moves as a unit — every instance of it. */
export type ScopeTarget =
  | { readonly kind: 'template'; readonly name: string }
  | { readonly kind: 'block'; readonly blockType: string; readonly instance: string }
  | { readonly kind: 'blockType'; readonly blockType: string };

export function describeScope(scope: LibraryScope): string {
  return scope === 'global' ? 'global' : 'workspace';
}

/** `~/.struktek`, or `.struktek` — whichever the user would recognise. */
function describeRoot(library: Library, scope: LibraryScope): string {
  const root = library.rootFor(scope);
  if (!root) return describeScope(scope);
  if (scope === 'workspace') return vscode.workspace.asRelativePath(root, false);
  return root.fsPath;
}

/**
 * Move one target into the given scope.
 *
 * Returns the file it ended up at, or undefined when nothing was written —
 * cancelled, already there, or nothing found under that name.
 */
export async function moveToScope(
  library: Library,
  target: ScopeTarget,
  to: LibraryScope,
): Promise<vscode.Uri | undefined> {
  const destinationRoot = library.rootFor(to);
  if (!destinationRoot) {
    void vscode.window.showWarningMessage(
      to === 'global'
        ? 'Struktek: the global library is switched off — enable struktek.globalLibrary.enabled first.'
        : 'Struktek: open a workspace folder first — there is no workspace library to move into.',
    );
    return undefined;
  }

  const moves = await plan(library, target, to);
  if (moves === undefined) return undefined;
  if (moves.length === 0) {
    void vscode.window.showInformationMessage(
      'Struktek: ' + label(target) + ' is already ' + describeScope(to) + '.',
    );
    return undefined;
  }

  if (!(await confirm(library, target, to, moves))) return undefined;

  let last: vscode.Uri | undefined;
  for (const move of moves) {
    await moveFile(move.from, move.to);
    last = move.to;
  }
  log('Moved between libraries', {
    target: label(target),
    to,
    files: moves.length,
  });

  // The watcher will get there, but a command that says nothing looks like it
  // did nothing, and this one moved a file the user cannot see.
  await library.reload();
  void vscode.window.showInformationMessage(
    'Struktek: ' +
      label(target) +
      ' is now ' +
      describeScope(to) +
      ' (' +
      describeRoot(library, to) +
      ').',
  );
  return last;
}

interface Move {
  readonly from: vscode.Uri;
  readonly to: vscode.Uri;
  /** Set when the destination file already exists and will be replaced. */
  readonly replaces?: boolean;
}

/**
 * Work out the files to move, or undefined when the target does not resolve.
 *
 * An empty list means "already in the destination scope", which is a distinct
 * answer from "not found" and gets a distinct message.
 */
async function plan(
  library: Library,
  target: ScopeTarget,
  to: LibraryScope,
): Promise<readonly Move[] | undefined> {
  const from: LibraryScope = to === 'global' ? 'workspace' : 'global';

  if (target.kind === 'template') {
    const entry =
      findTemplate(library, target.name, from) ?? findTemplate(library, target.name, to);
    if (!entry) return undefined;
    if (entry.scope === to) return [];
    const destination = library.templateUri(target.name, to);
    if (!destination) return undefined;
    return [{ from: entry.uri, to: destination, ...((await exists(destination)) ? { replaces: true } : {}) }];
  }

  const instances =
    target.kind === 'block'
      ? [target.instance]
      : // Every instance the source scope actually has, not the merged view:
        // moving a type must not try to move a value that is already global.
        await instancesIn(library, target.blockType, from);
  if (instances.length === 0) {
    // Nothing in the source scope. Either it is all in the destination
    // already, or the type does not exist at all.
    const inDestination = await instancesIn(library, target.blockType, to);
    return inDestination.length > 0 ? [] : undefined;
  }

  const moves: Move[] = [];
  for (const instance of instances) {
    const source = await library.blockUri(target.blockType, instance, from);
    if (!source) continue;
    const root = library.rootFor(to);
    if (!root) return undefined;
    // Keep the source file's extension: a `.prompt` block stays a `.prompt`
    // block, and renaming it to `.md` would change the file for no reason.
    const destination = vscode.Uri.joinPath(
      root,
      BLOCKS_DIR,
      target.blockType,
      basename(source),
    );
    const collision = (await library.blockUri(target.blockType, instance, to)) ?? undefined;
    moves.push({
      from: source,
      to: destination,
      ...(collision ? { replaces: true } : {}),
    });
  }
  if (moves.length === 0) return [];
  return moves;
}

/**
 * Ask about everything that is not just a move, in one dialog per concern.
 *
 * Modal, because all three are decisions with consequences somewhere the user
 * is not currently looking — another workspace, or a file about to be
 * overwritten.
 */
async function confirm(
  library: Library,
  target: ScopeTarget,
  to: LibraryScope,
  moves: readonly Move[],
): Promise<boolean> {
  const replacing = moves.filter((move) => move.replaces);
  if (replacing.length > 0) {
    const replace = 'Replace';
    const detail =
      replacing.length === 1
        ? 'A ' +
          describeScope(to) +
          ' copy already exists at ' +
          describeRoot(library, to) +
          '. It is currently ' +
          (to === 'workspace' ? 'the one that renders' : 'hidden behind the workspace copy') +
          '. Replacing overwrites it — this one cannot be undone from the trash.'
        : String(replacing.length) +
          ' of these already exist in the ' +
          describeScope(to) +
          ' library. Replacing overwrites them — this cannot be undone from the trash.';
    const choice = await vscode.window.showWarningMessage(
      'Replace the existing ' + describeScope(to) + ' copy?',
      { modal: true, detail },
      replace,
    );
    if (choice !== replace) return false;
  }

  if (to === 'global' && target.kind === 'template') {
    if (!(await confirmBlockTypes(library, target.name))) return false;
  }

  if (to === 'workspace') {
    const proceed = 'Move Here';
    const choice = await vscode.window.showWarningMessage(
      'Make ' + label(target) + ' workspace-only?',
      {
        modal: true,
        detail:
          'It moves into ' +
          describeRoot(library, 'workspace') +
          ' and stops appearing in your other workspaces. Nothing is deleted.',
      },
      proceed,
    );
    if (choice !== proceed) return false;
  }

  return true;
}

/**
 * Warn when promoting a template away from block types it needs.
 *
 * A `{{ depth: forensic-review }}` field backed by a workspace-only block type
 * keeps resolving in THIS window — the merged library still has it — and
 * reports an unknown type in every other one. That is the worst shape of bug
 * this feature can produce, so it is the one thing checked rather than assumed.
 */
async function confirmBlockTypes(library: Library, name: string): Promise<boolean> {
  const entry = library.get(name);
  if (!entry) return true;
  const missing = await workspaceOnlyBlockTypes(library, entry.model.fields);
  if (missing.length === 0) return true;

  const bring = 'Move the Blocks Too';
  const anyway = 'Promote Anyway';
  const list = missing.join(', ');
  const choice = await vscode.window.showWarningMessage(
    'Promote "' + name + '" without its block types?',
    {
      modal: true,
      detail:
        (missing.length === 1 ? 'The block type ' : 'The block types ') +
        list +
        (missing.length === 1 ? ' exists' : ' exist') +
        ' only in this workspace. A global template referencing ' +
        (missing.length === 1 ? 'it' : 'them') +
        ' will report an unknown type in every other workspace.',
    },
    bring,
    anyway,
  );
  if (choice === undefined) return false;
  if (choice === anyway) return true;

  // No replace-confirmation here, and none is owed: `missing` is exactly the
  // types with NO global instance, so there is nothing in the destination for
  // these files to overwrite.
  for (const type of missing) {
    const moves = await plan(library, { kind: 'blockType', blockType: type }, 'global');
    for (const move of moves ?? []) await moveFile(move.from, move.to);
  }
  log('Promoted block types alongside a template', { template: name, types: missing.join(',') });
  return true;
}

/** Block types the template references that have no global instance at all. */
async function workspaceOnlyBlockTypes(
  library: Library,
  fields: readonly Field[],
): Promise<readonly string[]> {
  const referenced = new Set<string>();
  for (const field of fields) {
    if (field.type.kind === 'blockType') referenced.add(field.type.name);
  }
  const missing: string[] = [];
  for (const type of referenced) {
    if ((await instancesIn(library, type, 'global')).length === 0) missing.push(type);
  }
  return missing.sort((a, b) => a.localeCompare(b));
}

/**
 * Instance names a single scope holds, read from disk rather than the merge.
 *
 * The merged library cannot answer this: once a workspace value has shadowed a
 * global one of the same name, only the winner is in it, and both questions
 * here are about what each root separately contains.
 */
async function instancesIn(
  library: Library,
  type: string,
  scope: LibraryScope,
): Promise<readonly string[]> {
  const root = library.rootFor(scope);
  if (!root) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(root, BLOCKS_DIR, type),
    );
    return entries
      .filter(([, fileType]) => fileType === vscode.FileType.File)
      .map(([filename]) => stem(filename));
  } catch {
    return [];
  }
}

/**
 * A template in one specific scope, shadowed or not.
 *
 * `library.get()` only ever returns the winner, so promoting the global copy of
 * a name the workspace also uses would otherwise be unreachable.
 */
function findTemplate(
  library: Library,
  name: string,
  scope: LibraryScope,
): { readonly uri: vscode.Uri; readonly scope: LibraryScope } | undefined {
  const resolved = library.get(name);
  if (resolved?.scope === scope) return resolved;
  return library.shadowedTemplates().find((entry) => entry.model.name === name && entry.scope === scope);
}

/**
 * Move one file, creating the destination directory on the way.
 *
 * `rename` first because it is atomic and keeps the file's timestamps, then a
 * read/write/delete fallback: the two roots can sit behind different
 * filesystem providers — a remote workspace and a local home directory — and
 * no provider can rename across that boundary.
 */
async function moveFile(from: vscode.Uri, to: vscode.Uri): Promise<void> {
  await ensureDirectory(parent(to));
  try {
    await vscode.workspace.fs.rename(from, to, { overwrite: true });
    return;
  } catch {
    // Fall through — almost always a cross-provider move.
  }
  const bytes = await vscode.workspace.fs.readFile(from);
  await vscode.workspace.fs.writeFile(to, bytes);
  // Not the trash: the bytes are already at the destination, and a copy of the
  // file sitting in the bin invites restoring it back into the scope it left.
  await vscode.workspace.fs.delete(from, { useTrash: false });
}

async function ensureDirectory(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // Already there, which is the outcome we wanted.
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function label(target: ScopeTarget): string {
  switch (target.kind) {
    case 'template':
      return '"' + target.name + '"';
    case 'block':
      return '"' + target.blockType + '/' + target.instance + '"';
    case 'blockType':
      return 'the "' + target.blockType + '" block type';
  }
}

/**
 * The command-palette path: pick something to move, when nothing was passed in.
 *
 * Only offers what is in the SOURCE scope, so the list never contains an entry
 * that would immediately answer "already there".
 */
export async function pickScopeTarget(
  library: Library,
  to: LibraryScope,
): Promise<ScopeTarget | undefined> {
  const from: LibraryScope = to === 'global' ? 'workspace' : 'global';
  const templates = [
    ...library.list(),
    ...library.shadowedTemplates(),
  ].filter((entry) => entry.scope === from);

  interface Item extends vscode.QuickPickItem {
    readonly target: ScopeTarget;
  }
  const items: Item[] = templates
    .sort((a, b) => a.model.name.localeCompare(b.model.name))
    .map((entry) => ({
      label: '$(file) ' + entry.model.name,
      ...(entry.model.description ? { description: entry.model.description } : {}),
      target: { kind: 'template', name: entry.model.name } as ScopeTarget,
    }));

  for (const type of [...library.blocks.names.keys()].sort((a, b) => a.localeCompare(b))) {
    const owned = await instancesIn(library, type, from);
    if (owned.length === 0) continue;
    items.push({
      label: '$(symbol-namespace) ' + type,
      description: owned.length === 1 ? '1 value' : String(owned.length) + ' values',
      target: { kind: 'blockType', blockType: type },
    });
    for (const instance of [...owned].sort((a, b) => a.localeCompare(b))) {
      items.push({
        label: '$(circle-small-filled) ' + type + '/' + instance,
        target: { kind: 'block', blockType: type, instance },
      });
    }
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      'Struktek: nothing in the ' + describeScope(from) + ' library to move.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: to === 'global' ? 'Struktek — Make Global' : 'Struktek — Make Workspace-Only',
    placeHolder: 'Move into the ' + describeScope(to) + ' library',
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  return picked?.target;
}

function parent(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? '';
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}
