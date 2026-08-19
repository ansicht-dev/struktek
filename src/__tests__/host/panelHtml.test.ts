/**
 * Theming and CSP rules for the panel, enforced rather than documented.
 *
 * "Derive everything from the active theme" is the kind of rule that holds
 * until someone is in a hurry and drops in a hex. These tests fail when that
 * happens, which is the only version of the rule that survives contact with a
 * deadline.
 *
 * The second half guards the CSP: this frame renders text the user wrote, so a
 * loosened policy is a real problem and not a style question.
 */

import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { buildPanelHtml } from '../../host/panelHtml';

const webview = {
  cspSource: 'vscode-webview://test',
  asWebviewUri: (uri: vscode.Uri) => uri,
} as unknown as vscode.Webview;

const extensionUri = vscode.Uri.file('/ext');

function html(): string {
  return buildPanelHtml(webview, extensionUri);
}

function stylesheet(): string {
  const match = /<style nonce="[0-9a-f]+">([\s\S]*?)<\/style>/.exec(html());
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

describe('theming', () => {
  it('contains no hex colours', () => {
    const offenders = withoutDataUris(stylesheet()).match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(offenders ?? []).toEqual([]);
  });

  it('contains no rgb/hsl literals', () => {
    const offenders = withoutDataUris(stylesheet()).match(/\b(rgba?|hsla?)\s*\(/g);
    expect(offenders ?? []).toEqual([]);
  });

  it('contains no named colours', () => {
    // `transparent` and `currentColor` are keywords, not palette choices.
    const offenders = withoutDataUris(stylesheet()).match(
      /:\s*(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple)\b/gi,
    );
    expect(offenders ?? []).toEqual([]);
  });

  it('resolves every colour-bearing declaration through a theme token', () => {
    const css = withoutDataUris(stylesheet());
    const declarations = css.match(/(^|[;{])\s*(color|background|background-color|border-color|outline-color)\s*:[^;}]+/gm) ?? [];
    const bad = declarations
      .map((d) => d.replace(/^[;{\s]+/, '').trim())
      .filter((d) => !/var\(--vscode-/.test(d))
      // A declaration may legitimately be a keyword or inherit.
      .filter((d) => !/:\s*(transparent|inherit|currentColor|none|unset|initial)\s*$/i.test(d));
    expect(bad).toEqual([]);
  });

  it('gives high-contrast themes a visible border wherever one is transparent', () => {
    const css = stylesheet();
    // Every `transparent` border fallback should sit behind --vscode-contrastBorder,
    // which only HC themes define.
    const transparentBorders = css.match(/border(-color)?:[^;]*transparent[^;]*/g) ?? [];
    const missing = transparentBorders.filter((d) => !d.includes('--vscode-contrastBorder'));
    expect(missing).toEqual([]);
  });

  it('styles the native controls the browser would otherwise colour itself', () => {
    const css = stylesheet();
    // Each of these renders with user-agent defaults if left alone, which means
    // built-for-a-white-page in every dark theme.
    for (const selector of ['::placeholder', '::selection', 'option', '::-webkit-scrollbar-thumb', '::-webkit-search-cancel-button']) {
      expect(css, selector + ' must be claimed explicitly').toContain(selector);
    }
  });
});

describe('content security policy', () => {
  it('denies everything by default', () => {
    expect(html()).toContain("default-src 'none'");
  });

  it('allows no inline or remote script beyond the nonce', () => {
    // Anchored on the CSP meta specifically - `content="..."` alone matches the
    // viewport tag, which sits earlier in the document.
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html())![1]!;
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]+'/);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('uses a fresh nonce per render', () => {
    const first = /nonce="([0-9a-f]+)"/.exec(html())![1];
    const second = /nonce="([0-9a-f]+)"/.exec(html())![1];
    expect(first).not.toBe(second);
  });

  it('loads the script from the built webview bundle', () => {
    expect(html()).toContain('out/webview/panel.js');
  });
});
