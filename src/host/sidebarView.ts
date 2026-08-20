/**
 * The Struktek activity-bar view — the whole sidebar, as one webview.
 *
 * It is one view rather than three because of a single constraint: a view
 * contributed into a container always gets its own collapsible section header,
 * and there is no API to remove it. A search box in its own view therefore
 * reads as a bolted-on section rather than as the view's search box. With one
 * view the container header is the only header, and the frame draws the search
 * row and the Templates / Blocks sections itself — the shape the Extensions
 * view has.
 *
 * The cost is that rows, hovers and their actions are ours to draw. The gain is
 * that filtering is local: the frame holds the whole (small) library and
 * narrows it without a round-trip, so typing is not a conversation with the
 * extension host.
 *
 * Every action that touches disk goes back to the host. This module resolves
 * nothing itself — it hands each message to the command that already
 * implements it, so the sidebar and the command palette cannot diverge.
 */

import * as vscode from 'vscode';
import type { TemplateModel } from '../core';
import type {
  BlockRow,
  BlockTypeRow,
  SidebarHostMessage,
  SidebarMessage,
  TemplateRow,
} from '../shared/sidebarProtocol';
import type { Library } from './library';
import type { Stats } from './stats';
import { buildWebviewHtml } from './webviewHtml';

export const SIDEBAR_VIEW_ID = 'struktek.sidebar';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getLibrary: () => Library | undefined,
    private readonly getStats: () => Stats | undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')],
    };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.extensionUri,
      script: 'sidebar.js',
      title: 'Struktek',
      codicons: true,
      styles: STYLES,
      body: '<div id="root"></div>',
    });

    view.webview.onDidReceiveMessage((message: SidebarMessage) => {
      void this.handle(message);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  refresh(): void {
    if (!this.view) return;
    void this.view.webview.postMessage(this.snapshot());
  }

  private async handle(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.refresh();
        return;
      case 'showTemplate':
        await vscode.commands.executeCommand('struktek.showTemplate', message.name);
        return;
      case 'openTemplate':
        await vscode.commands.executeCommand('struktek.openTemplate', message.name);
        return;
      case 'deleteTemplate':
        await vscode.commands.executeCommand('struktek.deleteTemplate', message.name);
        return;
      case 'newTemplate':
        await vscode.commands.executeCommand('struktek.newTemplate');
        return;
      case 'newBlock':
        await vscode.commands.executeCommand('struktek.newBlock', message.blockType);
        return;
      case 'openBlock':
        await vscode.commands.executeCommand('struktek.openBlock', message.blockType, message.instance);
        return;
      case 'deleteBlock':
        await vscode.commands.executeCommand(
          'struktek.deleteBlock',
          message.blockType,
          message.instance,
        );
        return;
      case 'deleteBlockType':
        await vscode.commands.executeCommand('struktek.deleteBlockType', message.blockType);
        return;
      case 'seedLibrary':
        await vscode.commands.executeCommand('struktek.seedLibrary');
        return;
    }
  }

  private snapshot(): SidebarHostMessage {
    const library = this.getLibrary();
    const stats = this.getStats();
    if (!library || !stats) {
      return { type: 'library', templates: [], blockTypes: [], tags: [], hasWorkspace: false };
    }

    // Most-used first, mirroring the picker and the panel: the list should
    // reflect what you actually reach for.
    const templates = stats
      .order(library.names())
      .map((name) => library.get(name))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .map((entry) => templateRow(entry.model, stats.uses(entry.model.name)));

    const blockTypes = [...library.blocks.names.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((type): BlockTypeRow => ({
        type,
        instances: (library.blocks.names.get(type) ?? []).map((instance) =>
          blockRow(library, type, instance),
        ),
      }));

    const tags = new Set<string>();
    for (const row of templates) for (const tag of row.tags) tags.add(tag);
    for (const group of blockTypes) {
      for (const row of group.instances) for (const tag of row.tags) tags.add(tag);
    }

    return {
      type: 'library',
      templates,
      blockTypes,
      tags: [...tags].sort((a, b) => a.localeCompare(b)),
      hasWorkspace: true,
    };
  }
}

export function templateRow(model: TemplateModel, uses: number): TemplateRow {
  return {
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.note ? { note: model.note } : {}),
    tags: model.tags,
    uses,
    errors: model.diagnostics.filter((d) => d.severity === 'error').length,
    problems: model.diagnostics.map((d) => ({ message: d.message, severity: d.severity })),
  };
}

export function blockRow(library: Library, type: string, instance: string): BlockRow {
  const meta = library.blocks.meta.get(type)?.get(instance);
  // With no header there is still something worth saying: the body's first
  // line is what this block will actually put in the prompt.
  const description = meta?.description ?? firstLine(library.blocks.bodies.get(type)?.get(instance));
  return {
    type,
    instance,
    ...(meta?.title && meta.title !== instance ? { title: meta.title } : {}),
    ...(description ? { description } : {}),
    ...(meta?.note ? { note: meta.note } : {}),
    tags: meta?.tags ?? [],
  };
}

function firstLine(body: string | undefined): string | undefined {
  const line = (body ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
  if (line.length === 0) return undefined;
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}

/**
 * Sidebar density, not page density.
 *
 * The frame has to look like the rest of the workbench sidebar rather than
 * like a small web page: 22px rows, a section header that is a real button,
 * actions that appear on hover, and a hover card instead of a native tooltip.
 * Sizes are the workbench's own; colours are all tokens, as everywhere else.
 */
const STYLES = `
/*
 * Workbench metrics, taken from VS Code's own stylesheets rather than eyeballed.
 *
 *   pane header   22px, 11px bold uppercase   (paneview.css)
 *   count badge   padding 3px 5px, radius 11px, min 18px, 11px/11px normal
 *                                              (countBadge.css)
 *   tree row      22px, twistie then icon then label
 *
 * Icons are codicons — the workbench's own font, linked into the frame — so
 * they are the same glyphs at the same weight as every other view.
 */
body { overflow: hidden; }
#root { display: flex; flex-direction: column; height: 100vh; }
.codicon { flex: 0 0 auto; }

/* ── search row ─────────────────────────────────────────── */
.stk-search { display: flex; gap: 4px; padding: 6px 8px; flex: 0 0 auto; }
/* VS Code inputs are 2px-radius and tighter than the panel's form fields. */
.stk-search input { flex: 1 1 auto; width: auto; min-width: 0; padding: 3px 5px; border-radius: 2px; }
.stk-funnel {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  width: 24px; padding: 0; border-radius: 2px;
  background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-contrastBorder, transparent);
}
.stk-funnel:hover { background: var(--vscode-toolbar-hoverBackground); }
.stk-funnel[aria-pressed="true"] {
  background: var(--vscode-inputOption-activeBackground, var(--vscode-toolbar-hoverBackground));
  color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
  border-color: var(--vscode-inputOption-activeBorder, var(--vscode-contrastBorder, transparent));
}
.stk-tagrow { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 6px; flex: 0 0 auto; }

/* ── pane headers ───────────────────────────────────────── */
.stk-body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; }
.stk-section-title {
  display: flex; align-items: center; width: 100%;
  height: 22px; line-height: 22px; padding: 0;
  border: none; border-radius: 0; cursor: pointer; text-align: left;
  background: var(--vscode-sideBarSectionHeader-background, transparent);
  color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  font-size: 11px; font-weight: bold; text-transform: uppercase;
}
.stk-section-title:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.stk-pane-twistie { margin: 0 2px; font-size: 16px; }
.stk-grow { flex: 1 1 auto; }
/* Count always visible, actions on hover — the Extensions view's arrangement. */
.stk-section-count {
  padding: 3px 5px; border-radius: 11px;
  font-size: 11px; line-height: 11px; font-weight: normal;
  min-width: 18px; min-height: 18px; text-align: center; margin-right: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.stk-section-actions { display: flex; margin-right: 4px; }
.stk-section-title:not(:hover) .stk-section-actions { visibility: hidden; }

/* ── tree rows ──────────────────────────────────────────── */
.stk-row {
  display: flex; align-items: center;
  height: 22px; line-height: 22px; padding: 0;
  cursor: pointer; color: inherit;
}
.stk-row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground, inherit); }
.stk-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* The list is not focused while you are typing in the search box, so a selected
   row uses the inactive pair — the same distinction a real tree makes. */
.stk-row.stk-active {
  background: var(--vscode-list-inactiveSelectionBackground);
  color: var(--vscode-list-inactiveSelectionForeground, inherit);
}
/* Every row reserves the twistie column, leaf or not, so labels line up. */
.stk-twistie { width: 16px; font-size: 16px; flex: 0 0 auto; }
.stk-indent { padding-left: 8px; }
.stk-icon { margin-right: 6px; font-size: 16px; }
.stk-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stk-row-note {
  margin-left: 6px; opacity: .7; font-size: .9em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stk-row-actions { margin-left: auto; margin-right: 4px; display: flex; flex: 0 0 auto; }
.stk-row:not(:hover) .stk-row-actions { display: none; }
.stk-act {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 5px;
  background: transparent; color: var(--vscode-icon-foreground, inherit);
}
.stk-act:hover { background: var(--vscode-toolbar-hoverBackground); }
.stk-act .codicon { font-size: 16px; }

/* Colour marks ordered state only, and never alone — the count carries text. */
.stk-err { color: var(--vscode-editorError-foreground); }

/* ── hover ──────────────────────────────────────────────── */
/* VS Code draws its own hovers rather than using the browser's title tooltip,
   and so does this — a native tooltip cannot carry a title, a rule and a field
   list. Tokens are the editor hover widget's own. */
.stk-hover {
  position: fixed; z-index: 10;
  padding: 4px 8px; border-radius: 3px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-contrastBorder, transparent));
  font-size: var(--vscode-font-size); line-height: 1.4;
  pointer-events: none;
}
.stk-hover-title { font-weight: 600; }
.stk-hover-desc { font-style: italic; opacity: .85; }
.stk-hover-line { margin-top: 2px; }
.stk-hover-note { margin-top: 2px; opacity: .8; }
/* A problem is the only thing a hover adds below the description, and it is
   marked by its icon as well as its colour. */
.stk-problem {
  display: flex; gap: 5px; align-items: flex-start;
  margin-top: 4px; word-break: break-word;
}
.stk-problem .codicon { font-size: 14px; line-height: 1.4; }
.stk-problem.stk-error { color: var(--vscode-editorError-foreground); }
.stk-problem.stk-warning { color: var(--vscode-editorWarning-foreground); }

/* ── welcome content ────────────────────────────────────── */
/* The workbench's own welcome-view padding, so an empty section reads like an
   empty tree rather than like a card. */
.stk-empty { padding: 0 20px 1em; color: inherit; line-height: 1.4; }
.stk-empty div { margin-block-start: 1em; }
.stk-empty button { margin-top: 8px; width: 100%; max-width: 300px; border-radius: 2px; }
.stk-none { padding: 2px 8px 4px 24px; opacity: .7; }
`;
