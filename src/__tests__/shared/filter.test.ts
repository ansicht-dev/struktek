/**
 * The sidebar and the panel both narrow the same library.
 *
 * They are separate frames over one matcher, so the rules worth pinning are the
 * ones a user would notice differing: what a tag chip means when there are
 * several, and how much of an item free text can reach.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, filterActive, matchesFilter } from '../../shared/filter';

const item = {
  name: 'code-review',
  description: 'Review a file for a specific class of problem',
  note: 'Only point this at code you own',
  tags: ['review', 'quality'],
};

const q = (query: string, tags: string[] = []) => ({ query, tags: new Set(tags) });

describe('matchesFilter', () => {
  it('matches everything while empty', () => {
    expect(filterActive(EMPTY_FILTER)).toBe(false);
    expect(matchesFilter(item, EMPTY_FILTER)).toBe(true);
    expect(matchesFilter({ name: 'anything', tags: [] }, EMPTY_FILTER)).toBe(true);
  });

  it('searches name, description, note and tags alike', () => {
    for (const needle of ['code', 'specific class', 'you own', 'quality']) {
      expect(matchesFilter(item, q(needle)), needle).toBe(true);
    }
    expect(matchesFilter(item, q('refactor'))).toBe(false);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(matchesFilter(item, q('  REVIEW  '))).toBe(true);
  });

  it('searches the free-text field a block uses for its type', () => {
    expect(matchesFilter({ name: 'thorough', tags: [], text: 'Thorough depth' }, q('depth'))).toBe(true);
  });

  it('ORs several tags rather than requiring all of them', () => {
    // Chips that narrowed each other would make two chips almost always show
    // nothing, which is not what a filter row is for.
    expect(matchesFilter(item, q('', ['quality', 'debug']))).toBe(true);
    expect(matchesFilter(item, q('', ['debug']))).toBe(false);
  });

  it('ANDs the query against the tags', () => {
    expect(matchesFilter(item, q('review', ['debug']))).toBe(false);
    expect(matchesFilter(item, q('review', ['quality']))).toBe(true);
  });

  it('counts whitespace-only text as no filter at all', () => {
    expect(filterActive(q('   '))).toBe(false);
    expect(matchesFilter({ name: 'x', tags: [] }, q('   '))).toBe(true);
  });

  it('counts a tag on its own as an active filter', () => {
    expect(filterActive(q('', ['quality']))).toBe(true);
  });
});
