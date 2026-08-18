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
import { composeCommand } from './compose';
import { configureMcpCommand } from './configureMcp';
import { History } from './history';
import { Library, resolveLibraryRoot, TEMPLATES_DIR } from './library';
import { LibraryTreeProvider } from './libraryView';
import { initLog, log, setLogLevel, type LogLevel } from './log';
import { McpServerHost } from './mcpServer';
import { StruktekPanel } from './panel';
import { newTemplateBody, seedLibrary } from './seed';
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());
  applyLogLevel();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('struktek.logLevel')) applyLogLevel();
      // The library path is not hot-swappable; the setting says so.
    }),
  );

  await openSession();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void openSession();
    }),
  );

  // Registered once and fed by whichever session is live, so the view survives
  // a workspace change without being torn down and rebuilt.
  const tree = new LibraryTreeProvider(
    () => session?.library,
    () => session?.stats,
  );
  context.subscriptions.push(
    vscode.window.createTreeView('struktek.library', { treeDataProvider: tree }),
  );
  refreshTree = () => tree.refresh();
  refreshTree();

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
    vscode.commands.registerCommand('struktek.openLibrary', () =>
      withSession((s) => openLibrary(s.library)),
    ),
    vscode.commands.registerCommand('struktek.configureMcp', () =>
      withSession((s) => configureMcpCommand(s.workspaceRoot)),
    ),
    vscode.commands.registerCommand('struktek.refreshLibrary', () =>
      withSession(async (s) => {
        await s.library.reload();
        tree.refresh();
        panel.refresh();
      }),
    ),
    vscode.commands.registerCommand('struktek.seedLibrary', () =>
      withSession(async (s) => {
        const created = await seedLibrary(s.library.root);
        await s.library.reload();
        tree.refresh();
        panel.refresh();
        if (!created) {
          void vscode.window.showInformationMessage(
            'Struktek: the library already exists — nothing was overwritten.',
          );
        }
      }),
    ),
    vscode.commands.registerCommand('struktek.openTemplate', (item?: { resourceUri?: vscode.Uri }) =>
      withSession(async (s) => {
        const uri = item?.resourceUri ?? s.library.list()[0]?.uri;
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
  if (!enabled) return;
  if (folder.uri.scheme !== 'file') {
    log('MCP server not started — the workspace is not on a local filesystem', {
      scheme: folder.uri.scheme,
    });
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
      record: (template, values) => current.stats.record(template, values),
    }),
  });

  try {
    await host.listen();
    current.mcp = host;
  } catch (err) {
    log.error('MCP server failed to start', { error: String(err) });
  }
}

function extensionVersion(): string {
  const extension = vscode.extensions.getExtension('ansicht.struktek');
  const packageJson = extension?.packageJSON as { version?: string } | undefined;
  return packageJson?.version ?? '0.0.0';
}

function closeSession(): void {
  const current = session;
  session = undefined;
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
