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
import { blockRefs, type History, type HistoryEntry } from './history';
import type { Field } from '../core';
import type { Library } from './library';
import { log } from './log';
import type { Stats } from './stats';
import { buildPanelHtml } from './panelHtml';
import type {
  BlockBodies,
  Delivery,
  HistoryFeedRow,
  HistoryRow,
  HostMessage,

  TemplateDetail,
  WebviewMessage,
} from '../shared/panelProtocol';

export const PANEL_VIEW_TYPE = 'struktek.panel';

export interface PanelDeps {
  readonly library: Library;
  readonly stats: Stats;
  readonly history: History;
}

/** Which screen the frame is on, so a repaint does not move it. */
type Screen = 'history' | 'template';

export class StruktekPanel {
  private panel: vscode.WebviewPanel | undefined;
  private current: string | undefined;
  /**
   * History, not the library, is what opening the panel means now.
   *
   * The sidebar is the library browser; a second one in a tab was the same list
   * twice. What the tab can show that the sidebar cannot is every prompt you
   * have actually produced.
   */
  private screen: Screen = 'history';
  private seed: { readonly id: string; readonly values: Readonly<Record<string, string>> } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: () => PanelDeps | undefined,
  ) {}

  /** Open, or reveal an existing panel — never two of the same thing. */
  show(template?: string): void {
    if (template) {
      this.current = template;
      this.screen = 'template';
    }
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
    if (this.screen === 'template' && this.current) void this.pushTemplate(this.current);
    else this.pushHistory();
  }

  /**
   * Every prompt ever produced, newest first.
   *
   * Joined against the library on the way out so a row can show the template's
   * tags and say whether it still exists — the entry itself only knows a name,
   * and a name outlives the file behind it.
   */
  private pushHistory(focus?: string): void {
    const deps = this.deps();
    if (!deps) return;
    const { library, history } = deps;

    const rows = history.all().map((entry): HistoryFeedRow => {
      const model = library.get(entry.template)?.model;
      return {
        ...toRow(entry, model?.fields),
        template: entry.template,
        tags: model?.tags ?? [],
        templateExists: model !== undefined,
      };
    });

    const templates = [...new Set(rows.map((row) => row.template))];
    const tags = [...new Set(rows.flatMap((row) => row.tags))].sort((a, b) => a.localeCompare(b));
    // A focus only survives if that template actually has runs; otherwise the
    // feed would open filtered to nothing.
    const focused = focus && templates.includes(focus) ? { focus } : {};
    this.send({ type: 'history', rows, templates, tags, ...focused });
  }

  private async pushTemplate(name: string): Promise<void> {
    const deps = this.deps();
    if (!deps) return;
    const { library, stats, history } = deps;
    const entry = library.get(name);
    if (!entry) {
      // Deleted or renamed under us — fall back rather than showing a blank.
      // History, not the library: the runs made from it are still there, and
      // are the only remaining trace of what it said.
      this.current = undefined;
      this.screen = 'history';
      this.pushHistory();
      return;
    }

    const blocks: BlockBodies = {};
    const blockNames: Record<string, readonly string[]> = {};
    for (const [type, instances] of library.blocks.bodies) {
      blocks[type] = Object.fromEntries(instances);
    }
    for (const [type, names] of library.blocks.names) blockNames[type] = names;

    // The seed beats sticky values, and is consumed once: a later repaint of
    // the same template must not silently re-apply an old run.
    const seed = this.seed;
    this.seed = undefined;

    const sticky: Record<string, string> = {};
    for (const field of entry.model.fields) {
      const value = stats.sticky(name, field.name);
      if (value !== undefined) sticky[field.name] = value;
    }

    const detail: TemplateDetail = {
      name: entry.model.name,
      scope: entry.scope,
      ...(entry.model.description ? { description: entry.model.description } : {}),
      tags: entry.model.tags,
      fields: entry.model.fields,
      nodes: entry.model.nodes,
      blocks,
      blockNames,
      sticky,
      ...(seed ? { seed: seed.values, seedId: seed.id } : {}),
      uses: stats.uses(name),
      ...(history.lastUsed(name) ? { lastUsed: history.lastUsed(name)! } : {}),
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

      case 'openHistory':
        this.screen = 'history';
        this.pushHistory(message.template);
        return;

      case 'pickTemplate': {
        // The native picker rather than a grid inside the frame: the sidebar is
        // the library, and this is only a way to swap without leaving.
        const picked = await vscode.window.showQuickPick(
          deps.library.list().map((entry) => ({
            label: entry.model.name,
            ...(entry.model.description ? { detail: entry.model.description } : {}),
          })),
          { title: 'Struktek - Compose', placeHolder: 'Which template?', matchOnDetail: true },
        );
        if (!picked) return;
        this.current = picked.label;
        this.screen = 'template';
        this.seed = undefined;
        await this.pushTemplate(picked.label);
        return;
      }

      case 'openTemplate':
        this.current = message.name;
        this.screen = 'template';
        this.seed = undefined;
        await this.pushTemplate(message.name);
        return;

      case 'variant': {
        // Varying a run means the composer, opened on that template with the
        // values it actually used — not a blank form you have to reconstruct.
        const run = deps.history.get(message.id);
        if (!run) return;
        if (!deps.library.get(run.template)) {
          void vscode.window.showWarningMessage(
            'Struktek: "' + run.template + '" no longer exists, so there is nothing to vary.',
          );
          return;
        }
        this.current = run.template;
        this.screen = 'template';
        this.seed = { id: run.id, values: run.values };
        await this.pushTemplate(run.template);
        return;
      }

      case 'clearAllHistory': {
        const confirm = 'Clear';
        const choice = await vscode.window.showWarningMessage(
          'Clear every generated prompt Struktek has kept? This cannot be undone.',
          { modal: true, detail: 'Use counts and last-used values are left alone.' },
          confirm,
        );
        if (choice !== confirm) return;
        await deps.history.clear();
        this.pushHistory();
        return;
      }

      case 'newTemplate':
        await vscode.commands.executeCommand('struktek.newTemplate');
        return;

      case 'openBlockFile':
        // Through the command the sidebar uses, rather than resolving the file
        // here: two ways to open the same block would eventually disagree
        // about which copy wins.
        await vscode.commands.executeCommand(
          'struktek.openBlock',
          message.blockType,
          message.instance,
        );
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

      case 'deleteHistory': {
        // No confirmation: one row is a line in a log, it is on screen when
        // you press the button, and a modal per row would make tidying the
        // feed a chore. Clearing a template's history, or all of it, still
        // asks — those throw away runs you cannot see from the button.
        await deps.history.remove(message.id);
        this.pushHistory();
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
    deps.history.record(
      name,
      values,
      prompt,
      via,
      blockRefs(deps.library.get(name)?.model.fields ?? [], values),
    );

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

/**
 * One history entry as the frame sees it.
 *
 * `blocks` is derived when the entry predates the field being recorded: a
 * block-typed value IS the instance name, so the pairs can be reconstructed
 * from the template as long as it still declares those fields. Entries whose
 * template is gone simply show no block chips rather than wrong ones.
 */
function toRow(entry: HistoryEntry, fields: readonly Field[] | undefined): HistoryRow {
  return {
    id: entry.id,
    at: entry.at,
    values: entry.values,
    prompt: entry.prompt,
    ...(entry.via ? { via: entry.via } : {}),
    blocks: entry.blocks ?? (fields ? blockRefs(fields, entry.values) : []),
  };
}

async function workspaceFiles(): Promise<string[]> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const found = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist}/**', 2000);
  const paths = found.map((uri) => vscode.workspace.asRelativePath(uri));
  const activePath = active ? vscode.workspace.asRelativePath(active) : undefined;
  // Nine times out of ten the file you mean is the one you are looking at.
  return activePath ? [activePath, ...paths.filter((p) => p !== activePath)] : paths;
}
