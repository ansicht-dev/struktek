/**
 * The panel's HTML shell and the styles only it uses.
 *
 * The shell, the CSP and every rescue of a browser default live in
 * `webviewHtml.ts`, shared with the sidebar's search frame. What is left here
 * is the panel's own layout: the library grid, the compose split, the history
 * feed. All of it still obeys the rule stated there — no literal colour, ever.
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
    styles: STYLES,
    body: '<div id="root"></div>',
  });
}

const STYLES = `
#root { max-width: 1180px; margin: 0 auto; padding: 20px 24px 48px; }

/* ── chrome ─────────────────────────────────────────────── */
.stk-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.stk-title { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.stk-sub { color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
.stk-spacer { flex: 1; }

/* ── library ────────────────────────────────────────────── */
.stk-filters { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.stk-filters input { flex: 1; min-width: 200px; }


.stk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 12px; }
.stk-card {
  text-align: left; width: 100%;
  padding: 13px 15px; border-radius: 6px; cursor: pointer;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  color: var(--vscode-foreground);
  display: flex; flex-direction: column; gap: 7px;
}
.stk-card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.stk-card-top { display: flex; align-items: baseline; gap: 8px; }
.stk-card-name { font-weight: 600; }
.stk-card-desc {
  color: var(--vscode-descriptionForeground); font-size: .92em; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.stk-card-meta {
  display: flex; gap: 10px; flex-wrap: wrap;
  font-size: .84em; color: var(--vscode-descriptionForeground);
}

/* Colour marks ordered state only, and never alone - the warning carries text. */
.stk-warn { color: var(--vscode-editorWarning-foreground); }
.stk-err { color: var(--vscode-editorError-foreground); }

/* ── compose ────────────────────────────────────────────── */
.stk-split { display: grid; grid-template-columns: minmax(280px, 4fr) minmax(300px, 5fr); gap: 20px; align-items: start; }
@media (max-width: 860px) { .stk-split { grid-template-columns: 1fr; } }

.stk-field { margin-bottom: 13px; }
.stk-label { display: flex; align-items: baseline; gap: 7px; margin-bottom: 4px; }
.stk-name { font-weight: 600; font-size: .95em; }
.stk-type {
  font-family: var(--vscode-editor-font-family); font-size: .8em;
  color: var(--vscode-descriptionForeground);
}
.stk-opt { font-size: .8em; color: var(--vscode-descriptionForeground); font-style: italic; }
.stk-hint { color: var(--vscode-descriptionForeground); font-size: .86em; margin: 3px 0 0; }

.stk-pane {
  position: sticky; top: 20px;
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
  margin: 0; padding: 14px;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, .92em);
  line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  max-height: 52vh; overflow: auto;
}
.stk-empty-slot { color: var(--vscode-descriptionForeground); font-style: italic; }
.stk-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 11px 12px; border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent)); }

/* ── history ────────────────────────────────────────────── */
.stk-section { margin-top: 30px; }
.stk-section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.stk-h2 { font-size: 1.05em; font-weight: 600; margin: 0; }

.stk-run {
  border-radius: 5px; margin-bottom: 7px;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, transparent));
  background: var(--vscode-editorWidget-background);
}
.stk-run-head {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 12px; cursor: pointer; text-align: left;
  background: transparent; border: none; color: var(--vscode-foreground);
}
.stk-run-head:hover { background: var(--vscode-list-hoverBackground); }
.stk-when { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: .86em; }
.stk-run-line {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--vscode-descriptionForeground); font-size: .9em;
}
.stk-run-body { padding: 0 12px 12px; }
.stk-run-body pre {
  margin: 0 0 9px; padding: 11px; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  font-family: var(--vscode-editor-font-family); font-size: .88em;
  white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto;
}

.stk-blank {
  text-align: center; padding: 54px 20px;
  color: var(--vscode-descriptionForeground);
}
.stk-blank p { margin: 0 0 14px; }
`;
