/**
 * The panel's HTML shell and its stylesheet.
 *
 * All styling lives here rather than in the webview modules, which only ever
 * set `className`. No literal colour is written where a theme token exists, so
 * the panel follows the user's theme — including high contrast — without a
 * second palette to maintain.
 *
 * Script runs under a nonce and `default-src 'none'`: this frame renders text
 * the user wrote, and there is no reason for it to reach the network.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function buildPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'panel.js'),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<title>Struktek</title>
<style nonce="${nonce}">
${STYLES}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#root { max-width: 1180px; margin: 0 auto; padding: 20px 24px 48px; }

/* ── chrome ─────────────────────────────────────────────── */
.stk-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.stk-title { font-size: 1.45em; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.stk-sub { color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
.stk-spacer { flex: 1; }

button {
  font-family: inherit; font-size: inherit;
  border: 1px solid transparent; border-radius: 4px;
  padding: 5px 12px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button.stk-ghost {
  background: transparent; color: var(--vscode-foreground);
  border-color: var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
}
button.stk-ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
button:disabled { opacity: .5; cursor: default; }

input, select, textarea {
  font-family: inherit; font-size: inherit; width: 100%;
  padding: 5px 8px; border-radius: 4px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
}
input:focus, select:focus, textarea:focus {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
}
textarea { resize: vertical; min-height: 68px; line-height: 1.5; }

/* ── library ────────────────────────────────────────────── */
.stk-filters { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.stk-filters input { flex: 1; min-width: 200px; }

.stk-chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  font-size: .82em; line-height: 1.7;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border: 1px solid transparent; cursor: pointer;
}
.stk-chip[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
.stk-chip.stk-static { cursor: default; }

.stk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: 12px; }
.stk-card {
  text-align: left; width: 100%;
  padding: 13px 15px; border-radius: 6px; cursor: pointer;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, transparent);
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
.stk-tags { display: flex; gap: 5px; flex-wrap: wrap; }

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
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
}
.stk-pane-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; font-size: .85em;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
}
.stk-preview {
  margin: 0; padding: 14px;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, .92em);
  line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  max-height: 52vh; overflow: auto;
}
/* A value the user supplied, so they can see their input land in the prose. */
.stk-slot { border-radius: 2px; background: color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent); }
.stk-empty-slot { color: var(--vscode-descriptionForeground); font-style: italic; }
.stk-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 11px 12px; border-top: 1px solid var(--vscode-editorWidget-border, transparent); }

/* ── history ────────────────────────────────────────────── */
.stk-section { margin-top: 30px; }
.stk-section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.stk-h2 { font-size: 1.05em; font-weight: 600; margin: 0; }

.stk-run {
  border-radius: 5px; margin-bottom: 7px;
  border: 1px solid var(--vscode-editorWidget-border, transparent);
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
