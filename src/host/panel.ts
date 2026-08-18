/**
 * The Struktek panel — one webview in the editor area, two screens.
 *
 * The sidebar tree stays the fast launcher; this is where the work happens,
 * because a form beside a live preview needs width the sidebar does not have.
 *
 * The host sends the parsed template rather than rendered text: the webview
 * runs `core`'s renderer itself, so the preview updates on each keystroke with
 * no message round-trip and no second renderer to drift from this one.
 */

import * as vscode from 'vscode';
import type { History } from './history';
import type { Library } from './library';
import { log } from './log';
import type { Stats } from './stats';
import { buildPanelHtml } from './panelHtml';
import type {
  BlockBodies,
  Delivery,
  HostMessage,
  LibraryCard,
  TemplateDetail,
  WebviewMessage,
} from '../shared/panelProtocol';

export const PANEL_VIEW_TYPE = 'struktek.panel';

export interface PanelDeps {
  readonly library: Library;
  readonly stats: Stats;
  readonly history: History;
}

export class StruktekPanel {
  private panel: vscode.WebviewPanel | undefined;
  private current: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: () => PanelDeps | undefined,
  ) {}

  /** Open, or reveal an existing panel — never two of the same thing. */
  show(template?: string): void {
    this.current = template ?? this.current;
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
      this.push();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Struktek',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Cheap here — the panel holds unsaved form values, and rebuilding it
        // on every tab switch would throw away a half-filled prompt.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'out', 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'assets'),
        ],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'struktek-activitybar.svg');
    this.panel.webview.html = buildPanelHtml(this.panel.webview, this.extensionUri);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handle(message);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Repaint whatever is on screen — called when the library changes on disk. */
  refresh(): void {
    if (this.panel) this.push();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private send(message: HostMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private push(): void {
    if (this.current) void this.pushTemplate(this.current);
    else this.pushLibrary();
  }

  private pushLibrary(): void {
    const deps = this.deps();
    if (!deps) return;
    const { library, stats, history } = deps;

    const cards: LibraryCard[] = library.list().map((entry) => {
      const { model } = entry;
      return {
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        tags: model.tags,
        uses: stats.uses(model.name),
        ...(history.lastUsed(model.name) ? { lastUsed: history.lastUsed(model.name)! } : {}),
        historyCount: history.count(model.name),
        fieldCount: model.fields.length,
        errorCount: model.diagnostics.filter((d) => d.severity === 'error').length,
      };
    });

    // Most-used first, mirroring the picker: the list should reflect what you
    // actually reach for, not what happens to sort first.
    const order = stats.order(cards.map((card) => card.name));
    cards.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

    const tags = [...new Set(cards.flatMap((card) => card.tags))].sort((a, b) => a.localeCompare(b));
    this.send({ type: 'library', cards, tags });
  }

  private async pushTemplate(name: string): Promise<void> {
    const deps = this.deps();
    if (!deps) return;
    const { library, stats, history } = deps;
    const entry = library.get(name);
    if (!entry) {
      // Deleted or renamed under us — fall back rather than showing a blank.
      this.current = undefined;
      this.pushLibrary();
      return;
    }

    const blocks: BlockBodies = {};
    const blockNames: Record<string, readonly string[]> = {};
    for (const [type, instances] of library.blocks.bodies) {
      blocks[type] = Object.fromEntries(instances);
    }
    for (const [type, names] of library.blocks.names) blockNames[type] = names;

    const sticky: Record<string, string> = {};
    for (const field of entry.model.fields) {
      const value = stats.sticky(name, field.name);
      if (value !== undefined) sticky[field.name] = value;
    }

    const detail: TemplateDetail = {
      name: entry.model.name,
      ...(entry.model.description ? { description: entry.model.description } : {}),
      tags: entry.model.tags,
      fields: entry.model.fields,
      nodes: entry.model.nodes,
      blocks,
      blockNames,
      sticky,
      history: history.for(name).map((row) => ({
        id: row.id,
        at: row.at,
        values: row.values,
        prompt: row.prompt,
        ...(row.via ? { via: row.via } : {}),
      })),
      uses: stats.uses(name),
      diagnostics: entry.model.diagnostics.map((d) => ({ message: d.message, severity: d.severity })),
      files: await workspaceFiles(),
    };
    this.send({ type: 'template', detail });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    const deps = this.deps();
    if (!deps) return;

    switch (message.type) {
      case 'ready':
        this.push();
        return;

      case 'openLibrary':
        this.current = undefined;
        this.pushLibrary();
        return;

      case 'openTemplate':
        this.current = message.name;
        await this.pushTemplate(message.name);
        return;

      case 'newTemplate':
        await vscode.commands.executeCommand('struktek.newTemplate');
        return;

      case 'editTemplate': {
        const entry = deps.library.get(message.name);
        if (!entry) return;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(entry.uri), {
          viewColumn: vscode.ViewColumn.Beside,
        });
        return;
      }

      case 'deliver':
        await this.deliver(deps, message.name, message.values, message.prompt, message.via);
        return;

      case 'clearHistory': {
        const confirm = 'Clear';
        const choice = await vscode.window.showWarningMessage(
          'Clear the generated-prompt history for "' + message.name + '"? This cannot be undone.',
          { modal: true },
          confirm,
        );
        if (choice !== confirm) return;
        await deps.history.clear(message.name);
        await this.pushTemplate(message.name);
        return;
      }

      case 'copyHistory': {
        const entry = deps.history.get(message.id);
        if (!entry) return;
        await vscode.env.clipboard.writeText(entry.prompt);
        void vscode.window.showInformationMessage('Struktek: prompt copied.');
        return;
      }
    }
  }

  private async deliver(
    deps: PanelDeps,
    name: string,
    values: Readonly<Record<string, string>>,
    prompt: string,
    via: Delivery,
  ): Promise<void> {
    if (prompt.trim().length === 0) {
      void vscode.window.showWarningMessage('Struktek: nothing to send — the prompt is empty.');
      return;
    }

    deps.stats.record(name, values);
    deps.history.record(name, values, prompt, via);

    switch (via) {
      case 'chat':
        await sendToChat(prompt);
        break;
      case 'clipboard':
        await vscode.env.clipboard.writeText(prompt);
        void vscode.window.showInformationMessage('Struktek: prompt copied.');
        break;
      case 'insert': {
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
        if (!editor) {
          void vscode.window.showWarningMessage('Struktek: no open editor to insert into.');
          break;
        }
        await editor.edit((builder) => builder.replace(editor.selection, prompt));
        break;
      }
      case 'editor': {
        const document = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
        break;
      }
    }

    // The run just recorded belongs in the history list immediately — waiting
    // for a file watcher would make it feel like it had not been saved.
    await this.pushTemplate(name);
  }
}

/**
 * Prefill the chat box WITHOUT submitting.
 *
 * `isPartialQuery` is the point: struktek composes a prompt for you to look at,
 * not one to fire blind. Falls back to the clipboard rather than losing it.
 */
async function sendToChat(prompt: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
      isPartialQuery: true,
    });
  } catch (err) {
    log.warn('Chat open failed — falling back to the clipboard', { error: String(err) });
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showInformationMessage(
      'Struktek: no chat view available — prompt copied instead.',
    );
  }
}

async function workspaceFiles(): Promise<string[]> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const found = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist}/**', 2000);
  const paths = found.map((uri) => vscode.workspace.asRelativePath(uri));
  const activePath = active ? vscode.workspace.asRelativePath(active) : undefined;
  // Nine times out of ten the file you mean is the one you are looking at.
  return activePath ? [activePath, ...paths.filter((p) => p !== activePath)] : paths;
}
