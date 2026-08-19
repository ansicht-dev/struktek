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
  margin: 0;
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

/* ── shared idioms ──────────────────────────────────────── */
.stk-chip {
  display: inline-block; padding: 1px 8px; border-radius: 10px;
  font-size: .82em; line-height: 1.7;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-contrastBorder, transparent); cursor: pointer;
}
.stk-chip[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
.stk-chip.stk-static { cursor: default; }
.stk-tags { display: flex; gap: 5px; flex-wrap: wrap; }
`;
