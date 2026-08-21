/**
 * Report-a-problem spec.
 *
 * The whole feature is a link, which is exactly why it is worth pinning: a
 * wrong one opens a form that looks fine and is the wrong form, or a page that
 * 404s, and nobody reports a broken "report an issue" button — they just give
 * up. So the two things that can silently rot are checked here: that the
 * manifest's npm-shaped repository URL becomes a page, and that each door
 * names its own template.
 *
 * The field names are the other half of the contract. They have to match the
 * `id`s in `.github/ISSUE_TEMPLATE/*.yml` or GitHub prefills nothing, so the
 * templates themselves are read off disk rather than restated here.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { issueUrl, repositoryUrl, type IssueKind } from '../../host/report';

const CONTEXT = { version: '0.1.0', editor: 'VSCodium 1.99.0', platform: 'win32 x64' };

describe('the repository a build reports to', () => {
  it('strips the npm shape off the manifest URL', () => {
    expect(repositoryUrl({ repository: { url: 'git+https://github.com/ansicht-dev/struktek.git' } }))
      .toBe('https://github.com/ansicht-dev/struktek');
  });

  it('takes a plain string, and a trailing slash off it', () => {
    expect(repositoryUrl({ repository: 'https://github.com/someone/fork/' }))
      .toBe('https://github.com/someone/fork');
  });

  /** A shorthand or an ssh remote is not something openExternal can use. */
  it('refuses anything that is not a page', () => {
    expect(repositoryUrl({ repository: 'git@github.com:ansicht-dev/struktek.git' })).toBeUndefined();
    expect(repositoryUrl({ repository: 'ansicht-dev/struktek' })).toBeUndefined();
    expect(repositoryUrl({})).toBeUndefined();
    expect(repositoryUrl(undefined)).toBeUndefined();
  });

  /** The real manifest, so a rename of the repo cannot pass unnoticed. */
  it('resolves the manifest this extension actually ships', () => {
    expect(repositoryUrl(manifest())).toMatch(/^https:\/\/github\.com\/.+\/.+$/);
  });
});

describe('the link each door opens', () => {
  it('names its own template and carries what we already know', () => {
    const url = new URL(issueUrl('https://github.com/a/b', 'bug_report', CONTEXT));
    expect(url.pathname).toBe('/a/b/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('0.1.0');
    expect(url.searchParams.get('editor')).toBe('VSCodium 1.99.0');
    expect(url.searchParams.get('platform')).toBe('win32 x64');
  });

  it('sends a feature request to the other form', () => {
    const url = new URL(issueUrl('https://github.com/a/b', 'feature_request', CONTEXT));
    expect(url.searchParams.get('template')).toBe('feature_request.yml');
  });

  it('escapes a value rather than ending the query with it', () => {
    const url = new URL(
      issueUrl('https://github.com/a/b', 'bug_report', { ...CONTEXT, editor: 'Code & Co #2' }),
    );
    expect(url.searchParams.get('editor')).toBe('Code & Co #2');
  });
});

/**
 * Prefilling only works while these names agree, and nothing at runtime says
 * when they stop: GitHub ignores a parameter it does not recognise and shows
 * an empty field, which reads as the reporter having skipped it.
 */
describe('the form on the other end', () => {
  it.each<IssueKind>(['bug_report', 'feature_request'])('%s declares the fields we fill', (kind) => {
    const form = readFileSync(
      path.join(__dirname, '../../../.github/ISSUE_TEMPLATE/' + kind + '.yml'),
      'utf8',
    );
    const url = new URL(issueUrl('https://github.com/a/b', kind, CONTEXT));
    for (const [field] of url.searchParams) {
      if (field === 'template') continue;
      expect(form, kind + ' has no field with id ' + field).toContain('id: ' + field);
    }
  });
});

function manifest(): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
}
