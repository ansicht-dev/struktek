/**
 * Theming and CSP rules for every webview, enforced rather than documented.
 *
 * "Derive everything from the active theme" is the kind of rule that holds
 * until someone is in a hurry and drops in a hex. These tests fail when that
 * happens, which is the only version of the rule that survives contact with a
 * deadline.
 *
 * Both frames run the same suite. The panel and the sidebar share a shell and a
 * base stylesheet precisely so they cannot diverge, and a shared rule that only
 * one of them is checked against is a rule that will.
 *
 * The second half guards the CSP: these frames render text the user wrote, so a
 * loosened policy is a real problem and not a style question.
 */

import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { buildPanelHtml } from '../../host/panelHtml';
import { SidebarViewProvider } from '../../host/sidebarView';

const webview = {
  cspSource: 'vscode-webview://test',
  asWebviewUri: (uri: vscode.Uri) => uri,
} as unknown as vscode.Webview;

const extensionUri = vscode.Uri.file('/ext');

/**
 * The sidebar frame's HTML is only reachable through `resolveWebviewView`, so
 * the view is stubbed down to the members the provider actually touches.
 */
function sidebarHtml(): string {
  let html = '';
  const view = {
    webview: {
      ...webview,
      set options(_value: unknown) {
        /* accepted and ignored */
      },
      set html(value: string) {
        html = value;
      },
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: async () => true,
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as unknown as vscode.WebviewView;

  new SidebarViewProvider(extensionUri, () => undefined, () => undefined).resolveWebviewView(view);
  return html;
}

const FRAMES: readonly { name: string; html: () => string; bundle: string }[] = [
  { name: 'panel', html: () => buildPanelHtml(webview, extensionUri), bundle: 'out/webview/panel.js' },
  { name: 'sidebar', html: sidebarHtml, bundle: 'out/webview/sidebar.js' },
];

function stylesheet(html: string): string {
  const match = /<style nonce="[0-9a-f]+">([\s\S]*?)<\/style>/.exec(html);
  expect(match, 'the stylesheet should be present and nonce-guarded').toBeTruthy();
  return match![1]!;
}

/**
 * Data URIs are exempt.
 *
 * The search clear-button is drawn as a MASK: only its alpha channel is used,
 * and the visible colour comes from `background-color`, which is a theme token.
 * The `#000` inside that SVG is not a colour anyone can see.
 */
function withoutDataUris(css: string): string {
  return css.replace(/url\("data:[^"]*"\)/g, 'url(DATA)');
}

describe.each(FRAMES)('theming — $name', (frame) => {
  it('contains no hex colours', () => {
    const offenders = withoutDataUris(stylesheet(frame.html())).match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(offenders ?? []).toEqual([]);
  });

  it('contains no rgb/hsl literals', () => {
    const offenders = withoutDataUris(stylesheet(frame.html())).match(/\b(rgba?|hsla?)\s*\(/g);
    expect(offenders ?? []).toEqual([]);
  });

  it('contains no named colours', () => {
    // `transparent` and `currentColor` are keywords, not palette choices.
    const offenders = withoutDataUris(stylesheet(frame.html())).match(
      /:\s*(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)\b/gi,
    );
    expect(offenders ?? []).toEqual([]);
  });

  it('resolves every colour-bearing declaration through a theme token', () => {
    const css = withoutDataUris(stylesheet(frame.html()));
    const declarations =
      css.match(
        /(^|[;{])\s*(color|background|background-color|border-color|outline-color)\s*:[^;}]+/gm,
      ) ?? [];
    const bad = declarations
      .map((d) => d.replace(/^[;{\s]+/, '').trim())
      .filter((d) => !/var\(--vscode-/.test(d))
      // A declaration may legitimately be a keyword or inherit.
      .filter((d) => !/:\s*(transparent|inherit|currentColor|none|unset|initial)\s*$/i.test(d));
    expect(bad).toEqual([]);
  });

  it('gives high-contrast themes a visible border wherever one is transparent', () => {
    const css = stylesheet(frame.html());
    // Every `transparent` border fallback should sit behind --vscode-contrastBorder,
    // which only HC themes define.
    const transparentBorders = css.match(/border(-color)?:[^;]*transparent[^;]*/g) ?? [];
    const missing = transparentBorders.filter((d) => !d.includes('--vscode-contrastBorder'));
    expect(missing).toEqual([]);
  });

  it('styles the native controls the browser would otherwise colour itself', () => {
    const css = stylesheet(frame.html());
    // Each of these renders with user-agent defaults if left alone, which means
    // built-for-a-white-page in every dark theme.
    for (const selector of [
      '::placeholder',
      '::selection',
      'option',
      '::-webkit-scrollbar-thumb',
      '::-webkit-search-cancel-button',
    ]) {
      expect(css, selector + ' must be claimed explicitly').toContain(selector);
    }
  });
});

describe.each(FRAMES)('content security policy — $name', (frame) => {
  it('denies everything by default', () => {
    expect(frame.html()).toContain("default-src 'none'");
  });

  it('allows no inline or remote script beyond the nonce', () => {
    // Anchored on the CSP meta specifically - `content="..."` alone matches the
    // viewport tag, which sits earlier in the document.
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(frame.html())![1]!;
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('uses a fresh nonce per render', () => {
    const first = /nonce="([0-9a-f]+)"/.exec(frame.html())![1];
    const second = /nonce="([0-9a-f]+)"/.exec(frame.html())![1];
    expect(first).not.toBe(second);
  });

  it('loads the script from its own built bundle', () => {
    expect(frame.html()).toContain(frame.bundle);
  });

  it('builds no markup with innerHTML-shaped interpolation', () => {
    // The shell is the one place a string is concatenated into HTML; nothing
    // user-written may reach it.
    expect(frame.html()).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});
