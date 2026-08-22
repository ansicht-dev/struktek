/**
 * The panel's HTML shell and the styles only it uses.
 *
 * The shell, the CSP and every rescue of a browser default live in
 * `webviewHtml.ts`, shared with the sidebar. What is left here
 * is the panel's own layout: the compose split and the history feed. All of
 * it still obeys the rule stated there — no literal colour, ever.
 *
 * All styling lives here; the webview modules only ever set `className`.
 */

import * as vscode from 'vscode';
import { buildWebviewHtml } from './webviewHtml';

export function buildPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return buildWebviewHtml({
    webview,
    extensionUri,
    script: 'panel.js',
    title: 'Struktek',
    codicons: true,
    styles: STYLES,
    body: '<div id="root"></div>',
  });
}

const STYLES = `
#root { max-width: 1180px; margin: 0 auto; padding: 20px 24px 48px; }

/* ── navigation ─────────────────────────────────────────── */
.stk-nav {
  display: flex; gap: 2px; margin-bottom: 18px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
}
.stk-nav-item {
  background: transparent; color: var(--vscode-descriptionForeground);
  border: none; border-bottom: 1px solid transparent;
  border-radius: 0; padding: 7px 14px;
}
.stk-nav-item:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground);
}
/* The active tab is marked by weight and a rule, not by colour alone. */
.stk-nav-item.stk-nav-on {
  color: var(--vscode-foreground); font-weight: 600;
  border-bottom-color: var(--vscode-focusBorder);
}

/* ── chrome ─────────────────────────────────────────────── */
.stk-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.stk-title { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.stk-sub { color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
.stk-spacer { flex: 1; }

/* The history feed's search row: the box, then the funnel and the sort button.
   It no longer wraps, because it no longer holds a chip per template — those
   moved into the funnel's menu, and what is left is a fixed three things. */
.stk-filters { display: flex; gap: 6px; align-items: stretch; margin-bottom: 14px; }
.stk-filters input { flex: 1 1 auto; min-width: 0; }
/* Square with the search box beside it, and on its own corner radius. */
.stk-filters .stk-funnel { width: 26px; }

/* ── actions ────────────────────────────────────────────── */
/* Secondary actions are icon-only with a tooltip, the way workbench toolbars
   are. Only the button that sends the prompt somewhere keeps a label. */
.stk-icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border-radius: 5px;
  background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-contrastBorder, transparent);
}
.stk-icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.stk-primary { display: inline-flex; align-items: center; gap: 6px; }

/* The template name doubles as the switcher, so it has to look pressable
   without becoming a button-shaped box around a heading. */
.stk-switch {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 6px; border-radius: 4px;
  background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-contrastBorder, transparent);
}
.stk-switch:hover { background: var(--vscode-toolbar-hoverBackground); }
.stk-link {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 6px; border-radius: 4px; font-size: .86em;
  background: transparent; color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-contrastBorder, transparent);
}
.stk-link:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.stk-head { margin-bottom: 14px; }
.stk-head .stk-bar { margin-bottom: 0; }
.stk-status { font-variant-numeric: tabular-nums; }

/* Colour marks ordered state only, and never alone - the warning carries text. */
.stk-warn { color: var(--vscode-editorWarning-foreground); }
.stk-err { color: var(--vscode-editorError-foreground); }

/* ── compose ────────────────────────────────────────────── */
/* Flex rather than a grid, because the divider sets the left pane's basis as
   you drag it and a grid template would have to be rewritten instead. */
.stk-split { display: flex; align-items: stretch; min-height: 0; }
.stk-pane-left { flex: 0 0 auto; min-width: 0; overflow: hidden; }
.stk-pane-right { flex: 1 1 0; min-width: 0; }

.stk-divider {
  flex: 0 0 auto; width: 11px; cursor: col-resize;
  /* A hair-line rule centred in a grabbable strip: the target is wide enough
     to hit, the line is thin enough not to read as a border. */
  background:
    linear-gradient(to right, transparent 5px, var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent)) 5px 6px, transparent 6px);
}
.stk-divider:hover, .stk-divider:active {
  background:
    linear-gradient(to right, transparent 5px, var(--vscode-focusBorder) 5px 6px, transparent 6px);
}

/* Optional fields fold away; the disclosure is a row, not a heading. */
.stk-fold { margin: 4px 0 13px; }
.stk-fold > summary {
  cursor: pointer; list-style: none; user-select: none;
  padding: 3px 0; font-size: .86em; color: var(--vscode-descriptionForeground);
}
.stk-fold > summary:hover { color: var(--vscode-foreground); }
.stk-fold > summary::-webkit-details-marker { display: none; }
.stk-fold > summary::before { content: '\\25b8 '; }
.stk-fold[open] > summary::before { content: '\\25be '; }

/*
 * A field reads the way a row in the settings editor does: the name, then the
 * control, then the line explaining it - and the control does not stretch to
 * whatever width the pane happens to have been dragged to. A text box the
 * width of a monitor is the other thing that stops a form looking like part of
 * an editor.
 */
.stk-field { margin-bottom: 14px; max-width: 560px; }
.stk-label { display: flex; align-items: baseline; gap: 7px; margin-bottom: 4px; }
.stk-name { font-weight: 600; }
.stk-type {
  font-family: var(--vscode-editor-font-family); font-size: .85em;
  color: var(--vscode-descriptionForeground);
}
.stk-opt { font-size: .85em; color: var(--vscode-descriptionForeground); font-style: italic; }
.stk-hint { color: var(--vscode-descriptionForeground); font-size: .9em; margin: 4px 0 0; }

.stk-pane {
  display: flex; flex-direction: column;
  border-radius: 6px; overflow: hidden;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
}
.stk-pane-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; font-size: .85em;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
}
.stk-preview {
  flex: 1 1 auto;
  margin: 0; padding: 14px;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, .92em);
  line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  min-height: 220px; max-height: 62vh; overflow: auto;
}
.stk-empty-slot { color: var(--vscode-descriptionForeground); font-style: italic; }
.stk-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 11px 12px; border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent)); }

/* ── history feed ───────────────────────────────────────── */
.stk-feed { display: flex; flex-direction: column; gap: 10px; }
.stk-run-card {
  display: flex; flex-direction: column; gap: 9px;
  padding: 12px 14px; border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
}
.stk-run-top { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
.stk-run-name { font-weight: 600; }
/*
 * The card is the click target, so the card carries the affordance: the
 * cursor, and a border that picks up the accent as you come over it.
 *
 * The background deliberately does NOT change. A feed is a column of cards on
 * a page, and lighting one of them up as the pointer crosses is a lot of
 * movement for "you are over this"; the border says it without the page
 * flickering under the mouse. The excerpt inside is now plain text and takes
 * no highlight of its own - it was a button, and a pressable-looking panel
 * inside a pressable card was one surface too many.
 */
.stk-run-card { cursor: pointer; }
.stk-run-card:hover { border-color: var(--vscode-focusBorder); }
.stk-run-card:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
}
.stk-excerpt {
  margin: 0;
  padding: 10px 12px; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-contrastBorder, transparent);
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family); font-size: .88em; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
}
.stk-ref { display: flex; gap: 5px; flex-wrap: wrap; }
/* Not wrapped: the row is two actions, a gap, and the one destructive action
   pushed to the far edge — where it cannot be hit on the way to Copy. */
.stk-run-actions { display: flex; gap: 8px; align-items: center; }
/* Red only on approach. A trash can that is red at rest makes every card in
   the feed look like a warning, on a screen that is nothing but cards. */
.stk-run-actions .stk-icon-button:hover .codicon-trash { color: var(--vscode-editorError-foreground); }

/* The feed keeps a tabular timestamp; everything else here was the composer
   repeating the same rows, which the history screen now owns alone. */
.stk-when { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: .86em; }


/* ── one run, in full ───────────────────────────────────── */
/*
 * A real <dialog>, so the browser owns Escape, the focus trap and the inert
 * page behind it. What is claimed here is only its LOOK, which the browser
 * draws for a white page: a black border, a white background, and 1em of
 * padding no theme asked for.
 *
 * "display" is set on "[open]" and not on the element, because a closed dialog
 * is hidden by a UA rule that an author "display" would beat - stated flat, it
 * would leave every dialog on screen from the moment it was built.
 */
.stk-dialog {
  padding: 0; margin: auto;
  width: min(920px, calc(100vw - 64px));
  max-width: calc(100vw - 32px); max-height: calc(100vh - 80px);
  overflow: hidden;
  border-radius: 8px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  box-shadow: 0 8px 30px var(--vscode-widget-shadow, transparent);
}
.stk-dialog[open] { display: flex; flex-direction: column; }
/* The scrim is the editor's own background, thinned. Themes ship no token for
   one, and mixing the colour the page is already made of is the version that
   cannot clash with a theme. The flat declaration first is the fallback for an
   engine without color-mix, where an opaque sheet is still a correct modal. */
.stk-dialog::backdrop { background: var(--vscode-editor-background); }
.stk-dialog::backdrop { background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); }

.stk-dialog-head {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 13px 14px 11px;
}
.stk-dialog-title { font-size: 1.15em; font-weight: 600; margin: 0; }
.stk-dialog .stk-ref { padding: 0 14px 12px; }
/* Field values as a two-column list: the names are short and want to line up,
   the values are the user's own text and take whatever room is left. */
.stk-dialog-values {
  display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 14px; margin: 0; padding: 0 14px 13px;
  font-size: .88em;
}
.stk-dialog-values dt { color: var(--vscode-descriptionForeground); }
.stk-dialog-values dd {
  margin: 0; font-family: var(--vscode-editor-font-family);
  overflow-wrap: anywhere;
}
/* The point of the dialog: the whole prompt, selectable, scrolling on its own
   so the header and the actions stay put however long it is. */
.stk-dialog-prompt {
  flex: 1 1 auto; overflow: auto; margin: 0;
  /* min-height: 0, not a floor - a flex child needs it before it will scroll
     at all, and a floor would leave dead space under a one-line prompt. */
  padding: 14px; min-height: 0;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, .92em);
  line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  user-select: text;
}
.stk-dialog-actions { display: flex; align-items: center; gap: 8px; padding: 11px 14px; }
.stk-dialog-actions .stk-icon-button:hover .codicon-trash { color: var(--vscode-editorError-foreground); }

.stk-blank {
  text-align: center; padding: 54px 20px;
  color: var(--vscode-descriptionForeground);
}
.stk-blank p { margin: 0 0 14px; }
`;
