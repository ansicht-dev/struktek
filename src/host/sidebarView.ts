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
import type { LibraryScope, ShadowedBlock, TemplateModel } from '../core';
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
        await vscode.commands.executeCommand('struktek.openTemplate', message.name, message.scope);
        return;
      case 'deleteTemplate':
        await vscode.commands.executeCommand('struktek.deleteTemplate', message.name, message.scope);
        return;
      case 'newTemplate':
        await vscode.commands.executeCommand('struktek.newTemplate');
        return;
      case 'newBlock':
        await vscode.commands.executeCommand('struktek.newBlock', message.blockType);
        return;
      case 'openBlock':
        await vscode.commands.executeCommand(
          'struktek.openBlock',
          message.blockType,
          message.instance,
          message.scope,
        );
        return;
      case 'deleteBlock':
        await vscode.commands.executeCommand(
          'struktek.deleteBlock',
          message.blockType,
          message.instance,
          message.scope,
        );
        return;
      case 'deleteBlockType':
        await vscode.commands.executeCommand(
          'struktek.deleteBlockType',
          message.blockType,
          message.scope,
        );
        return;
      case 'setScope':
        await vscode.commands.executeCommand(
          message.to === 'global' ? 'struktek.makeGlobal' : 'struktek.makeWorkspace',
          message.target,
        );
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
      return {
        type: 'library',
        templates: [],
        blockTypes: [],
        tags: [],
        hasWorkspace: false,
        hasGlobal: false,
      };
    }

    // Unordered on purpose. The frame sorts, because the ordering is a live
    // choice the user makes in the search row and re-sorting must not cost a
    // round-trip. What crosses is the two keys it sorts by, neither of which
    // is ever drawn: how often this has been composed here, and how old it is.
    const templates = library
      .list()
      .map((entry) =>
        templateRow(entry.model, stats.uses(entry.model.name), entry.scope, entry.created),
      );

    // Overridden templates go last rather than beside their winner: they are
    // not things to compose, and interleaving them would double the length of
    // a list whose whole job is being scannable.
    for (const entry of library.shadowedTemplates()) {
      templates.push(
        templateRow(entry.model, stats.uses(entry.model.name), entry.scope, entry.created, true),
      );
    }

    const blockTypes = [...library.blocks.names.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((type): BlockTypeRow => {
        const instances = (library.blocks.names.get(type) ?? []).map((instance) =>
          blockRow(library, type, instance),
        );
        for (const block of library.shadowedBlocks) {
          if (block.type !== type) continue;
          instances.push(shadowedBlockRow(block));
        }
        return {
          type,
          instances,
          // Global only when nothing in it is local — see the protocol note.
          // A shadowed global value does not make the type global: what other
          // workspaces see is what counts, and the winner here is local.
          scope: instances.every((row) => row.scope === 'global') ? 'global' : 'workspace',
        };
      });

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
      hasWorkspace: library.roots.workspace !== undefined,
      hasGlobal: library.roots.global !== undefined,
    };
  }
}

export function templateRow(
  model: TemplateModel,
  uses: number,
  scope: LibraryScope,
  created = 0,
  shadowed = false,
): TemplateRow {
  return {
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.note ? { note: model.note } : {}),
    tags: model.tags,
    uses,
    errors: model.diagnostics.filter((d) => d.severity === 'error').length,
    problems: model.diagnostics.map((d) => ({ message: d.message, severity: d.severity })),
    created,
    scope,
    ...(shadowed ? { shadowed: true } : {}),
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
    created: library.createdAtBlock(type, instance),
    scope: library.scopeOfBlock(type, instance) ?? 'workspace',
  };
}

/**
 * A row for a value that is on disk but not what renders.
 *
 * Built from the shadowed copy's own body and header rather than from the
 * library, which by then holds only the winner — describing the hidden value
 * with the displacing value's text would be worse than showing nothing.
 */
export function shadowedBlockRow(block: ShadowedBlock): BlockRow {
  const description = block.meta?.description ?? firstLine(block.body);
  return {
    type: block.type,
    instance: block.instance,
    ...(block.meta?.title && block.meta.title !== block.instance ? { title: block.meta.title } : {}),
    ...(description ? { description } : {}),
    ...(block.meta?.note ? { note: block.meta.note } : {}),
    tags: block.meta?.tags ?? [],
    // The hidden copy's own file, not the winner's — the same reason its body
    // and header come from `block` rather than from the library.
    created: 0,
    scope: block.scope,
    shadowed: true,
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

/* ── search row ─────────────────────────────────────────── */
.stk-search { display: flex; gap: 4px; padding: 6px 8px; flex: 0 0 auto; }
/* Only the flex behaviour is the search row's own now - the metrics moved into
   the base stylesheet, where every field in both frames takes them. */
.stk-search input { flex: 1 1 auto; width: auto; min-width: 0; height: 24px; }

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

/* ── scope ──────────────────────────────────────────────────────────── */
/*
 * The global badge, composed onto the row's own icon.
 *
 * A corner overlay rather than a second icon beside the name: the row should
 * read as "a template" first and "a global one" second, and a standalone glyph
 * after the name competed with the name for the eye. This is the arrangement
 * the Explorer uses for a decorated file — base glyph, small mark in a corner.
 *
 * The wrapper only appears on a badged row, and adds no width of its own, so
 * badged and unbadged rows line up to the pixel.
 */
/*
 * The badge is a declared FRACTION of the icon it sits on, not a hand-picked
 * pixel size. Every codicon in a row renders at 16px — codicon.css sets that
 * with a font shorthand — so the one number that matters is the ratio, and
 * it is written down rather than implied by a magic 8.
 *
 * Half. A badge has to leave the icon it is badging legible: the row must
 * still read as "a template" first and "a global one" second, and anything
 * approaching the base size reads as a REPLACED icon instead of a badged one.
 */
.stk-icon-stack {
  --stk-icon: 16px;
  --stk-badge-scale: .5;
  --stk-badge: calc(var(--stk-icon) * var(--stk-badge-scale));
  position: relative; display: inline-flex; align-items: center;
  height: var(--stk-icon); flex: 0 0 auto;
}
/*
 * Specificity here is load-bearing, not stylistic.
 *
 * codicon.css sizes glyphs through a selector carrying a class AND an
 * attribute test, which is
 * (0,2,0). A single-class rule loses to it SILENTLY: the declaration is
 * ignored, the badge renders at the full 16px, and the composition reads as an
 * icon that was replaced rather than decorated. Three classes clear it
 * outright, so this cannot regress on stylesheet order.
 */
.stk-icon-stack .codicon.stk-overlay {
  /* Offset from the corner by less than its own radius, so the disc hangs off
     the bottom-left and clips about a fifth of the base rather than covering
     its middle. Not a full half-diameter: that would push it into the twistie
     column, where a block type's chevron already is. */
  position: absolute; left: -3px; bottom: -3px;
  font-size: var(--stk-badge); line-height: var(--stk-badge);
  padding: 1px; border-radius: 50%;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
}
/*
 * The badge sits ON the base glyph, so it needs its own ground to read against
 * — and that ground has to be whatever the row is currently painted with, or
 * the badge shows as a differently-coloured dot exactly when you hover it.
 *
 * Hover and selection tokens are often translucent, so they are layered OVER
 * the sidebar background rather than replacing it. That is what the row itself
 * does; a gradient of one colour is the only way to stack two backgrounds on
 * one element.
 */
.stk-overlay { background-color: var(--vscode-sideBar-background); }
.stk-row:hover .stk-overlay {
  background-image: linear-gradient(
    var(--vscode-list-hoverBackground),
    var(--vscode-list-hoverBackground)
  );
}
.stk-row.stk-active .stk-overlay {
  background-image: linear-gradient(
    var(--vscode-list-inactiveSelectionBackground),
    var(--vscode-list-inactiveSelectionBackground)
  );
}

/* A row that is on disk but not what renders. Dimmed rather than hidden, and
   never dimmed so far that its name stops being readable — it is still a file
   you may want to open, promote or delete. Opacity alone does not carry it:
   the hover says "Overridden" in words. */
.stk-shadowed { opacity: .55; }
.stk-shadowed .stk-row-name { text-decoration: line-through; text-decoration-thickness: 1px; }
.stk-shadowed:hover { opacity: 1; }
.stk-scope-note, .stk-shadowed-note { opacity: .8; }

/* A template with errors keeps its own icon and is coloured, the way the
   explorer decorates a file with problems. Colour never carries it alone: the
   row says "2 errors" beside it, and the hover lists them. */
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
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--stk-border));
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
