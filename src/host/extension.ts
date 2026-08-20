/**
 * Activation.
 *
 * Deliberately flat: resolve the library root, load it, register commands. There
 * is no engine graph or state machine here because there is no concurrency to
 * coordinate — struktek reads a few small files and renders strings.
 *
 * The one piece of real lifecycle is the workspace-folder subscription. Without
 * it a folder swap leaves the library pointed at the previous root, which is a
 * bug worth not inheriting.
 */

import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { composeCommand } from './compose';
import { configureMcpCommand } from './configureMcp';
import { blockRefs, History } from './history';
import { BLOCKS_DIR, Library, resolveLibraryRoot, TEMPLATES_DIR } from './library';
import type { LibraryWriter } from '../shared/mcpSurface';
import { initLog, log, setLogLevel, type LogLevel } from './log';
import { McpServerHost } from './mcpServer';
import { McpStatus, MCP_STATUS_COMMAND } from './mcpStatus';
import { StruktekPanel } from './panel';
import { SidebarViewProvider, SIDEBAR_VIEW_ID } from './sidebarView';
import { newBlockBody, newTemplateBody, seedLibrary } from './seed';
import { registerTemplateEditor } from './templateEditor';
import { Stats } from './stats';

interface Session {
  readonly library: Library;
  readonly stats: Stats;
  readonly history: History;
  readonly workspaceRoot: string;
  mcp?: McpServerHost;
}

let session: Session | undefined;

/**
 * Set once the tree view exists, so a session opened later can repaint it.
 *
 * The view outlives sessions, and a workspace change replaces the session that
 * feeds it — without this the tree would keep showing the previous library.
 */
let refreshTree: () => void = () => undefined;

/** Set once the panel exists, so a library change repaints whatever it shows. */
let refreshPanel: () => void = () => undefined;

/**
 * The MCP indicator, created once and told what each session's server is doing.
 *
 * Lives outside the session for the same reason the views do: a workspace
 * change replaces the server, and the item has to survive that to report on
 * the next one.
 */
let mcpStatus: McpStatus | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  applyLogLevel();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('struktek.logLevel')) applyLogLevel();
      // The library path is not hot-swappable; the setting says so.
    }),
  );

  // Before the session opens, because opening one starts the MCP server and
  // reports what happened to this item. Created after, it would miss the only
  // report it ever gets.
  mcpStatus = new McpStatus({
    configure: () => vscode.commands.executeCommand('struktek.configureMcp'),
    restart: () => vscode.commands.executeCommand('struktek.restartMcp'),
  });
  context.subscriptions.push(mcpStatus);

  await openSession();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void openSession();
    }),
  );

  // Registered once and fed by whichever session is live, so the view survives
  // a workspace change without being torn down and rebuilt.
  const sidebar = new SidebarViewProvider(
    context.extensionUri,
    () => session?.library,
    () => session?.stats,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, {
      // The frame holds a half-typed query and which sections are open;
      // rebuilding it on every collapse would throw that away.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  refreshTree = () => sidebar.refresh();
  refreshTree();

  // Squiggles, highlighting and completions inside template files. Registered
  // once and pointed at whichever session is live, like the views.
  context.subscriptions.push(registerTemplateEditor(() => session?.library));

  const panel = new StruktekPanel(context.extensionUri, () =>
    session ? { library: session.library, stats: session.stats, history: session.history } : undefined,
  );
  context.subscriptions.push(panel);
  refreshPanel = () => panel.refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('struktek.compose', (template?: string) =>
      withSession((s) =>
        composeCommand(
          s.library,
          s.stats,
          s.history,
          typeof template === 'string' ? template : undefined,
        ),
      ),
    ),
    // The panel is the main surface; the QuickPick above stays as the fast path
    // for when you already know the template and want it in four keystrokes.
    vscode.commands.registerCommand('struktek.open', () => panel.show()),
    vscode.commands.registerCommand('struktek.showTemplate', (template?: string) =>
      panel.show(typeof template === 'string' ? template : undefined),
    ),
    vscode.commands.registerCommand('struktek.newTemplate', () =>
      withSession((s) => newTemplate(s.library)),
    ),
    vscode.commands.registerCommand('struktek.newBlock', (blockType?: unknown) =>
      withSession((s) => newBlock(s.library, blockTypeOf(blockType))),
    ),
    vscode.commands.registerCommand('struktek.deleteTemplate', (node?: unknown) =>
      withSession((s) => deleteTemplate(s.library, node)),
    ),
    vscode.commands.registerCommand('struktek.deleteBlock', (blockType?: unknown, instance?: unknown) =>
      withSession((s) => deleteBlock(s.library, blockType, instance)),
    ),
    vscode.commands.registerCommand('struktek.deleteBlockType', (node?: unknown) =>
      withSession((s) => deleteBlockType(s.library, node)),
    ),
    vscode.commands.registerCommand('struktek.openLibrary', () =>
      withSession((s) => openLibrary(s.library)),
    ),
    vscode.commands.registerCommand('struktek.configureMcp', () =>
      withSession((s) => configureMcpCommand(s.workspaceRoot)),
    ),
    vscode.commands.registerCommand(MCP_STATUS_COMMAND, () => mcpStatus?.pick()),
    vscode.commands.registerCommand('struktek.restartMcp', () =>
      withSession(async (s) => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        await s.mcp?.close().catch(() => undefined);
        s.mcp = undefined;
        await startMcp(s, folder);
      }),
    ),
    vscode.commands.registerCommand('struktek.refreshLibrary', () =>
      withSession(async (s) => {
        await s.library.reload();
        refreshTree();
        panel.refresh();
      }),
    ),
    vscode.commands.registerCommand('struktek.seedLibrary', () =>
      withSession(async (s) => {
        const created = await seedLibrary(s.library.root);
        await s.library.reload();
        refreshTree();
        panel.refresh();
        if (!created) {
          void vscode.window.showInformationMessage(
            'Struktek: the library already exists — nothing was overwritten.',
          );
        }
      }),
    ),
    vscode.commands.registerCommand('struktek.openTemplate', (target?: unknown) =>
      withSession(async (s) => {
        // A name from the sidebar, a tree item from anywhere else, or nothing
        // from the palette — all three have to land on the same file.
        const name = templateNameOf(target);
        const uri =
          (name ? s.library.get(name)?.uri : undefined) ??
          (target as { resourceUri?: vscode.Uri } | undefined)?.resourceUri ??
          s.library.list()[0]?.uri;
        if (!uri) return;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      }),
    ),
    vscode.commands.registerCommand('struktek.openBlock', (type?: string, instance?: string) =>
      withSession(async (s) => {
        if (!type || !instance) return;
        const uri = await s.library.blockUri(type, instance);
        if (!uri) {
          void vscode.window.showWarningMessage('Struktek: could not locate ' + type + '/' + instance + '.');
          return;
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      }),
    ),
    { dispose: closeSession },
  );

  log('Struktek activated');
}

export function deactivate(): void {
  closeSession();
}

function historyLimit(): number {
  const raw = vscode.workspace.getConfiguration('struktek').get<number>('history.limit', 500);
  // Hand-edited settings are not validated against the manifest, so clamp.
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 10000) : 500;
}

function applyLogLevel(): void {
  const level = vscode.workspace.getConfiguration('struktek').get<string>('logLevel', 'info');
  // VS Code does not enforce the manifest `enum` at read time — a hand-edited
  // settings.json returns whatever it says, so validate before trusting it.
  const known: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
  setLogLevel(known.includes(level as LogLevel) ? (level as LogLevel) : 'info');
}

/** Build a session for the current workspace, replacing any previous one. */
async function openSession(): Promise<void> {
  closeSession();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const root = resolveLibraryRoot();
  if (!folder || !root) {
    log('No workspace folder — struktek is idle until one is opened');
    return;
  }
  const library = new Library(root);
  await library.reload();
  library.watch();

  const stats = new Stats(library.runtimeDir);
  await stats.load();

  const history = new History(library.runtimeDir, historyLimit());
  await history.load();

  const current: Session = { library, stats, history, workspaceRoot: folder.uri.fsPath };
  session = current;

  // Slash commands are per-session registrations, so an edited library has to
  // be pushed to any connected agent — otherwise a new template stays invisible
  // until the agent reconnects.
  library.onDidChange(() => {
    current.mcp?.refreshPrompts();
    refreshTree();
    refreshPanel();
  });
  refreshTree();
  refreshPanel();

  await startMcp(current, folder);
}

/**
 * Start the MCP server, unless it is switched off or cannot be reached.
 *
 * The bridge finds the host through a file on the local disk and connects over
 * loopback, so neither works for a virtual or remote workspace. Starting anyway
 * would write a discovery file nothing can use.
 */
async function startMcp(current: Session, folder: vscode.WorkspaceFolder): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('struktek').get<boolean>('mcp.enabled', true);
  // Switched off, or a workspace that cannot host it: not running, and not a
  // problem either. The indicator says nothing rather than nagging.
  if (!enabled) {
    mcpStatus?.set({ kind: 'off' });
    return;
  }
  if (folder.uri.scheme !== 'file') {
    log('MCP server not started — the workspace is not on a local filesystem', {
      scheme: folder.uri.scheme,
    });
    mcpStatus?.set({ kind: 'off' });
    return;
  }

  const host = new McpServerHost({
    workspaceRoot: current.workspaceRoot,
    libraryRoot: current.library.root.fsPath,
    version: extensionVersion(),
    // Read per request, never snapshotted — the library is watched and mutates.
    view: () => ({
      templates: () => current.library.list().map((entry) => entry.model),
      blocks: () => current.library.blocks,
      // An agent composing a prompt is still a prompt produced, so it lands in
      // the feed like any other — tagged with where it came from.
      record: (template, values, prompt) => {
        current.stats.record(template, values);
        const fields = current.library.get(template)?.model.fields ?? [];
        current.history.record(template, values, prompt, 'mcp', blockRefs(fields, values));
      },
      // Only the running extension writes. The watcher picks the change up and
      // repaints the sidebar and the panel, which is the whole reason the
      // offline bridge does not offer these tools.
      write: libraryWriter(current.library),
    }),
    onSessionsChanged: () => mcpStatus?.update(host.agents),
  });

  try {
    const url = await host.listen();
    current.mcp = host;
    mcpStatus?.set({ kind: 'running', url, agents: host.agents });
  } catch (err) {
    log.error('MCP server failed to start', { error: String(err) });
    // The only state you could not previously discover without opening the log.
    mcpStatus?.set({ kind: 'failed', reason: String(err) });
  }
}

/**
 * Writing a template or a block on an agent\u2019s behalf.
 *
 * Deliberately thin: it writes the bytes and reloads, and refuses nothing.
 * What may be written is decided in `mcpSurface`, so the same rules apply
 * however the call arrives.
 */
function libraryWriter(library: Library): LibraryWriter {
  const write = async (uri: vscode.Uri, body: string): Promise<void> => {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
    // Reload rather than waiting on the watcher: an agent that saves and
    // immediately composes must not read the previous version back.
    await library.reload();
    log("Saved through MCP", { file: uri.toString() });
  };

  return {
    parseYaml,
    saveTemplate: (name, body) =>
      write(vscode.Uri.joinPath(library.root, TEMPLATES_DIR, name + '.md'), body),
    saveBlock: (type, instance, body) =>
      write(vscode.Uri.joinPath(library.root, BLOCKS_DIR, type, instance + '.md'), body),
  };
}

function extensionVersion(): string {
  const extension = vscode.extensions.getExtension('ansicht.struktek');
  const packageJson = extension?.packageJSON as { version?: string } | undefined;
  return packageJson?.version ?? '0.0.0';
}

function closeSession(): void {
  const current = session;
  session = undefined;
  mcpStatus?.set({ kind: 'off' });
  current?.library.dispose();
  void current?.mcp?.close().catch(() => undefined);
}

/**
 * Run a command against the live session, or explain why it cannot run.
 *
 * Commands are registered unconditionally so they always appear in the palette;
 * a command that silently does nothing is worse than one that says what is
 * missing.
 */
async function withSession(run: (session: Session) => Promise<void>): Promise<void> {
  if (!session) {
    void vscode.window.showWarningMessage(
      'Struktek: open a workspace folder first — the template library lives in it.',
    );
    return;
  }
  try {
    await run(session);
  } catch (err) {
    log.error('Command failed', { error: String(err) });
    void vscode.window.showErrorMessage('Struktek: ' + String(err));
  }
}

async function newTemplate(library: Library): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Struktek — New Template',
    prompt: 'Template name',
    placeHolder: 'code-review',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return 'Give the template a name.';
      if (!/^[A-Za-z0-9_.\-]+$/.test(trimmed)) return 'Letters, digits, dot, dash and underscore only.';
      if (library.get(trimmed)) return 'A template called "' + trimmed + '" already exists.';
      return undefined;
    },
  });
  if (!name) return;

  const uri = vscode.Uri.joinPath(library.root, TEMPLATES_DIR, name.trim() + '.md');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(newTemplateBody(name.trim()), 'utf8'));
  await library.reload();
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

/**
 * Delete a library file, once.
 *
 * Modal because the tree's inline actions sit a few pixels apart and one of
 * them composes; the trash lands in the OS bin rather than being unlinked,
 * because a prompt someone spent an afternoon on is worth a recoverable
 * mistake. Nothing is refreshed here — the watcher does that.
 */
async function confirmDelete(label: string, detail: string, uri: vscode.Uri): Promise<void> {
  const confirm = 'Delete';
  const choice = await vscode.window.showWarningMessage(
    'Delete \"' + label + '\"?',
    { modal: true, detail },
    confirm,
  );
  if (choice !== confirm) return;
  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
  log('Deleted a library file', { file: uri.toString() });
}

async function deleteTemplate(library: Library, node: unknown): Promise<void> {
  const name = templateNameOf(node);
  const entry = name ? library.get(name) : undefined;
  if (!entry) return;
  await confirmDelete(
    entry.model.name,
    'The file moves to the trash, so you can put it back. Its history and use count stay.',
    entry.uri,
  );
}

async function deleteBlock(library: Library, node: unknown, instance?: unknown): Promise<void> {
  const target = blockOf(node, instance);
  if (!target) return;
  const uri = await library.blockUri(target.type, target.instance);
  if (!uri) {
    void vscode.window.showWarningMessage(
      'Struktek: could not locate ' + target.type + '/' + target.instance + '.',
    );
    return;
  }
  await confirmDelete(
    target.instance,
    'A template pinned to this value will stop resolving until you pick another. ' +
      'The file moves to the trash.',
    uri,
  );
}

async function deleteBlockType(library: Library, node: unknown): Promise<void> {
  const type = blockTypeOf(node);
  if (!type) return;
  const instances = library.blocks.names.get(type) ?? [];
  await confirmDelete(
    type,
    // The count is the whole point of the warning: deleting a type takes every
    // value in it, and every field annotated with it stops resolving.
    'This removes the folder and ' +
      (instances.length === 1 ? 'its 1 value' : 'all ' + String(instances.length) + ' of its values') +
      '. Any field typed \"' + type + '\" will report an unknown type until you recreate it.',
    vscode.Uri.joinPath(library.root, BLOCKS_DIR, type),
  );
}

/**
 * A tree row hands the command its node; the palette hands it nothing.
 *
 * The commands are hidden from the palette, but a keybinding or another
 * extension can still invoke them, so every accessor tolerates the shapes it
 * did not expect rather than throwing.
 */
function templateNameOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  const entry = (node as { entry?: { model?: { name?: unknown } } })?.entry;
  return typeof entry?.model?.name === 'string' ? entry.model.name : undefined;
}

function blockTypeOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  const type = (node as { type?: unknown })?.type;
  return typeof type === 'string' ? type : undefined;
}

/** Two loose arguments from the frame, or one tree node from a menu. */
function blockOf(node: unknown, second?: unknown): { type: string; instance: string } | undefined {
  const type = blockTypeOf(node);
  const instance = typeof second === 'string' ? second : (node as { instance?: unknown })?.instance;
  return type && typeof instance === 'string' ? { type, instance } : undefined;
}

/**
 * Create a block instance, and its type if it does not exist yet.
 *
 * A directory under blocks/ IS a type, so making the first value of a new type
 * is the same act as declaring it — which is why the type step is a QuickPick
 * with an escape hatch rather than a separate command.
 */
async function newBlock(library: Library, preselected?: string): Promise<void> {
  const NEW_TYPE = String.fromCharCode(43) + ' New type...';
  let type = preselected;

  if (!type) {
    const types = [...library.blocks.names.keys()].sort((a, b) => a.localeCompare(b));
    const picked = await vscode.window.showQuickPick(
      [
        ...types.map((name) => ({
          label: name,
          description: String((library.blocks.names.get(name) ?? []).length) + ' values',
        })),
        { label: NEW_TYPE, description: 'a new folder under blocks/' },
      ],
      { title: 'Struktek - New Block', placeHolder: 'Which type?', ignoreFocusOut: true },
    );
    if (!picked) return;
    type = picked.label === NEW_TYPE ? await askName(library, 'Type name', 'output-format') : picked.label;
    if (!type) return;
  }

  const instance = await askName(
    library,
    'Value name',
    'markdown-table',
    library.blocks.names.get(type) ?? [],
  );
  if (!instance) return;

  const uri = vscode.Uri.joinPath(library.root, BLOCKS_DIR, type, instance + '.md');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(newBlockBody(type, instance), 'utf8'));
  await library.reload();
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/** The same name rules the template command uses — a name is also a filename. */
async function askName(
  _library: Library,
  prompt: string,
  placeHolder: string,
  taken: readonly string[] = [],
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Struktek - New Block',
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return 'Give it a name.';
      if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) return 'Letters, digits, dot, dash and underscore only.';
      if (taken.includes(trimmed)) return '\"' + trimmed + '\" already exists.';
      return undefined;
    },
  });
  return value?.trim();
}

async function openLibrary(library: Library): Promise<void> {
  const entries = library.list();
  if (entries.length === 0) {
    const seed = 'Create Starter Templates';
    const choice = await vscode.window.showInformationMessage(
      'Struktek: no templates in ' + vscode.workspace.asRelativePath(library.root) + '.',
      seed,
    );
    if (choice !== seed) return;
    await seedLibrary(library.root);
    await library.reload();
  }

  const picked = await vscode.window.showQuickPick(
    library.list().map((entry) => ({
      label: entry.model.name,
      detail: entry.model.description,
      description: describeDiagnostics(entry.model.diagnostics.length),
      entry,
    })),
    { title: 'Struktek — Template Library', placeHolder: 'Open a template', ignoreFocusOut: true },
  );
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(picked.entry.uri);
  await vscode.window.showTextDocument(doc);
}

function describeDiagnostics(count: number): string | undefined {
  return count > 0 ? '$(warning) ' + String(count) + ' issue(s)' : undefined;
}
