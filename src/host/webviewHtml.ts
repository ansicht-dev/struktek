/**
 * The shell and the base stylesheet every Struktek webview starts from.
 *
 * There are two frames — the panel in an editor tab and the sidebar in the
 * activity bar — and they must not drift. The CSP, the nonce and the
 * browser-default rescues below are not per-view decisions, so they live here
 * and each view appends only what is genuinely its own.
 *
 * THE RULE: no literal colour anywhere, and nothing is assumed to be themed
 * just because it is a native control. A webview is a browser frame, so an
 * unstyled `<option>`, placeholder, selection highlight, scrollbar or search
 * clear-button renders with BROWSER defaults — which means white-on-white the
 * moment someone uses a dark theme. Every such element is claimed explicitly
 * below, even where the default happens to look fine in the theme being
 * developed against.
 *
 * High contrast is handled the same way rather than as an afterthought:
 * borders that are `transparent` in normal themes resolve to
 * `--vscode-contrastBorder`, which only HC themes define, so outlines appear
 * exactly where those themes expect them.
 *
 * `src/__tests__/host/webviewHtml.test.ts` enforces this against every view — a
 * hex colour added here or in either view's own styles fails the suite.
 *
 * Script runs under a nonce and `default-src 'none'`: these frames render text
 * the user wrote, and there is no reason for them to reach the network.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface WebviewShell {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  /** Bundle filename under `out/webview/`, e.g. `panel.js`. */
  readonly script: string;
  readonly title: string;
  /** Appended after the base stylesheet, so a view can override it. */
  readonly styles: string;
  /** Load the workbench icon font. Only the frame that draws rows needs it. */
  readonly codicons?: boolean;
  /** Markup for the frame's single root element. */
  readonly body: string;
}

export function buildWebviewHtml(shell: WebviewShell): string {
  const nonce = randomBytes(16).toString('hex');
  const asset = (file: string): vscode.Uri =>
    shell.webview.asWebviewUri(vscode.Uri.joinPath(shell.extensionUri, 'out', 'webview', file));
  const script = asset(shell.script);
  // The font is same-origin under cspSource, so no relaxation beyond font-src
  // is needed — and the stylesheet is only linked where it is actually used.
  const codicons = shell.codicons
    ? '<link rel="stylesheet" href="' + String(asset('codicon.css')) + '">'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${shell.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${shell.webview.cspSource} data:; font-src ${shell.webview.cspSource};">
<title>${shell.title}</title>
${codicons}
<style nonce="${nonce}">
${BASE_STYLES}
${shell.styles}
</style>
</head>
<body>
${shell.body}
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
body {
  /* VS Code injects its own stylesheet into every webview, and it sets
     padding: 0 20px on the body. Resetting the margin is not enough — that
     padding insets everything from both edges, which a sidebar frame drawing
     full-width rows cannot live with. Each frame decides its own spacing. */
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}

/* ── claiming the browser's defaults ─────────────────────── */
/* None of these are styled by VS Code for us. Left alone they fall back to
   user-agent colours, which are built for a white page. */

::selection {
  background: var(--vscode-editor-selectionBackground);
  color: var(--vscode-editor-selectionForeground, inherit);
}
::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }

/* Scrollbars inside our own overflow containers — the frame's own scrollbar is
   themed by VS Code, but nested ones are not. */
* { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
::-webkit-scrollbar-corner { background: transparent; }

/* The clear button in a search field is a dark glyph bitmap by default, i.e.
   invisible on a dark theme. Recoloured via mask so it follows the theme. */
::-webkit-search-cancel-button {
  -webkit-appearance: none; appearance: none;
  height: 12px; width: 12px; cursor: pointer;
  background-color: var(--vscode-icon-foreground, currentColor);
  -webkit-mask: var(--stk-clear-icon) center / contain no-repeat;
  mask: var(--stk-clear-icon) center / contain no-repeat;
}
:root {
  /* Inline SVG so no network request is needed under the CSP. */
  --stk-clear-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 4l8 8M12 4l-8 8' stroke='%23000' stroke-width='1.6' fill='none'/%3E%3C/svg%3E");
}

/* ── controls ───────────────────────────────────────────── */
button {
  font-family: inherit; font-size: inherit;
  /* transparent normally, a real outline under high contrast. */
  border: 1px solid var(--vscode-contrastBorder, transparent);
  border-radius: 4px;
  padding: 5px 12px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
}
/* Secondary buttons have their own token pair — deriving them from the
   foreground colour only coincidentally matches most themes. */
button.stk-ghost {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-contrastBorder, var(--vscode-editorWidget-border, transparent));
}
button.stk-ghost:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}
button:disabled { opacity: .5; cursor: default; }

input, textarea {
  font-family: inherit; font-size: inherit; width: 100%;
  padding: 5px 8px; border-radius: 4px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
}
/* A select is NOT an input: VS Code themes them from separate tokens, and the
   popup list is drawn by the browser from the element's own colours. */
select {
  font-family: inherit; font-size: inherit; width: 100%;
  padding: 5px 8px; border-radius: 4px;
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-contrastBorder, transparent));
}
/* The one that bites: unstyled options render white-on-white in dark themes. */
option {
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background, var(--vscode-input-background)));
}
input:focus, select:focus, textarea:focus {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
}
textarea { resize: vertical; min-height: 68px; line-height: 1.5; }

/* An icon is a fixed glyph, never a thing for a flex row to squeeze. */
.codicon { flex: 0 0 auto; }

/* ── toolbar buttons ──────────────────────────── */
/* The funnel and the sort button, shared because both frames now put the same
   pair at the end of a search box. Sized for the sidebar; the panel's search
   row, whose input is taller, scales them in its own stylesheet. */
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

/* ── menus ──────────────────────────────────────────────────────────── */
/*
 * Drawn to match the workbench's own context menu, because a webview cannot
 * open the real one. Menu tokens throughout — they are a separate family from
 * the list and editor colours, and using list tokens here would look close in
 * one theme and wrong in the next.
 *
 * Fixed positioning, so it escapes the pane's clipped overflow and can hang
 * below a button near the bottom edge.
 */
/*
 * Metrics lifted from the workbench's own menu stylesheet rather than
 * approximated, because approximating is exactly what makes a drawn menu feel
 * drawn. VS Code injects these at runtime from its menu widget; the numbers
 * below are that rule set, read out of the shipped build:
 *
 *   .monaco-menu                     font-size 13px, min-width 160px,
 *                                    1px menu.border, cornerRadius-large
 *   .monaco-menu .action-menu-item   height 24px, margin 0 4px,
 *                                    cornerRadius-medium
 *   .monaco-menu .action-label       padding 0 1em, font-size 12px,
 *                                    line-height 1
 *   .menu-item-check                 absolute, width 1em, full height
 *   .monaco-menu-container           shadow, fade-in 0.083s linear
 *
 * The load-bearing one is the ITEM: 24px tall with a 4px side margin and a
 * rounded corner, so the highlight is an inset pill rather than a full-bleed
 * band. A full-width highlight is the single thing that reads most wrong.
 */
.stk-menu {
  position: fixed; z-index: 20;
  /* 200px, not the workbench's 160: its menus are mostly one word, and ours
     carry a tick column, a label and a chevron on the same row. Capped at the
     frame's own width, because a min-width WINS against a smaller max-width -
     stated flat, it would overhang a sidebar dragged narrower than the menu. */
  min-width: min(200px, calc(100vw - 8px)); max-width: calc(100vw - 8px);
  max-height: 60vh; overflow-y: auto;
  padding: 4px 0;
  font-size: 13px;
  border-radius: var(--vscode-cornerRadius-large, 5px);
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  /*
   * The outline. VS Code writes this as a bare menu.border, which many themes
   * leave unset - it relies on the shadow to draw the edge instead. Both were
   * resolving to nothing here, which is why the menu had no edge at all, so
   * the fallback walks on to borders every theme does define rather than
   * giving up at transparent.
   */
  border: 1px solid var(--vscode-menu-border,
    var(--vscode-editorWidget-border,
      var(--vscode-widget-border,
        var(--vscode-contrastBorder, transparent))));
  box-shadow: var(--vscode-shadow-lg, 0 2px 8px var(--vscode-widget-shadow, transparent));
  /* The workbench's own easing and duration, so a menu opening here and a menu
     opening in the editor do not arrive at different speeds. */
  animation: stk-menu-in .083s linear;
}
@keyframes stk-menu-in { from { opacity: 0; } to { opacity: 1; } }

.stk-menu-item {
  position: relative;
  display: flex; align-items: center;
  height: 24px; margin: 0 4px; padding: 0;
  width: calc(100% - 8px);
  border: none; border-radius: var(--vscode-cornerRadius-medium, 4px);
  background: transparent; color: inherit;
  text-align: left; cursor: pointer;
}
/*
 * Hover and keyboard focus are the SAME state in a menu - there is no separate
 * selected row, and a menu with two highlights reads as two cursors.
 *
 * Saying so in the stylesheet is not enough to make it true: opening a menu
 * puts focus on the ticked row, and if the pointer is resting somewhere else
 * that second row lights up too. So the POINTER MOVES FOCUS, in menu.ts, and
 * these selectors then describe one row rather than two.
 *
 * A submenu's parent is the exception, and deliberately: it stays lit while
 * its child is open, which reads as the trail you came down rather than as a
 * second cursor.
 */
.stk-menu-item:hover,
.stk-menu-item:focus,
.stk-menu-item:focus-visible,
.stk-menu-item[aria-expanded="true"] {
  outline: none;
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
}
/*
 * The tick column: a fixed 22px, absolutely placed, with the label indented
 * past it by exactly the same amount.
 *
 * It was 1em wide, holding a codicon that is 16px whatever the font is - so
 * the tick overflowed its column and sat on the first letter of the label,
 * which was 1em (12px) from the left edge. Two lengths in two different fonts
 * were being asked to agree; the fix is to state the column in pixels once and
 * measure the label from it.
 */
.stk-menu-check {
  position: absolute; left: 0; top: 0; width: 22px; height: 100%;
  display: flex; align-items: center; justify-content: center;
}
.stk-menu-check .codicon { font-size: 14px; }
.stk-menu-label {
  flex: 1 1 auto; padding: 0 8px 0 22px; font-size: 12px; line-height: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Dimmed like the workbench's own submenu chevron: it is an affordance, not a
   thing to read. */
.stk-menu-more { flex: 0 0 auto; margin-left: auto; padding-right: 6px; opacity: .8; }
.stk-menu-more.codicon { font-size: 14px; }
/* Greyed but still readable, and never highlighted - a section with nothing in
   it says so rather than vanishing, which would leave you wondering whether
   you had missed it. */
.stk-menu-disabled { color: var(--vscode-disabledForeground, inherit); opacity: .6; cursor: default; }
.stk-menu-disabled:hover, .stk-menu-disabled:focus { background: transparent; color: var(--vscode-disabledForeground, inherit); }
.stk-menu-sep {
  height: 0; margin: 4px 0;
  border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-disabledForeground));
}

/* ── shared idioms ──────────────────────────────────────── */
.stk-chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  font-size: .82em; line-height: 1.7;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-contrastBorder, transparent); cursor: pointer;
}
.stk-chip[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
.stk-chip.stk-static { cursor: default; }
/* The global badge: a chip with its icon, reading as provenance rather than as
   a tag you could click off. The icon is decoration — the word carries it. */
.stk-chip.stk-scope { display: inline-flex; align-items: center; gap: 4px; }
.stk-chip.stk-scope .codicon { font-size: 12px; }
.stk-tags { display: flex; gap: 5px; flex-wrap: wrap; }
`;
