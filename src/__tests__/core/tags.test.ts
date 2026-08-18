/**
 * Tags spec.
 *
 * Tags exist to make a growing library navigable, so the parsing is
 * deliberately forgiving: both YAML forms people actually type are accepted,
 * and case is normalised so `Review` and `review` cannot become two entries in
 * the same filter list.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate } from '../../core';

function tagsOf(frontmatter: string): readonly string[] {
  const source = ['---', frontmatter, '---', 'Body {{ x }}'].join('\n');
  return loadTemplate(source, { name: 'demo', parseYaml }).tags;
}

describe('tags', () => {
  it('reads a YAML list', () => {
    expect(tagsOf('tags: [review, quality]')).toEqual(['review', 'quality']);
  });

  it('reads a block list', () => {
    expect(tagsOf('tags:\n  - review\n  - quality')).toEqual(['review', 'quality']);
  });

  it('reads a comma-separated string', () => {
    expect(tagsOf('tags: review, quality')).toEqual(['review', 'quality']);
  });

  it('lowercases so one tag cannot split into two', () => {
    expect(tagsOf('tags: [Review, REVIEW, review]')).toEqual(['review']);
  });

  it('drops blanks and trims', () => {
    expect(tagsOf('tags: "  review ,, quality  "')).toEqual(['review', 'quality']);
  });

  it('is an empty list when absent, never undefined', () => {
    // Every consumer iterates this; an optional array would make each of them
    // guard for no reason.
    expect(tagsOf('name: demo')).toEqual([]);
    expect(loadTemplate('No frontmatter {{ x }}', { name: 'demo', parseYaml }).tags).toEqual([]);
  });

  it('ignores a non-list, non-string value rather than failing the template', () => {
    expect(tagsOf('tags: 42')).toEqual([]);
  });

  it('coexists with the other frontmatter keys', () => {
    const model = loadTemplate(
      ['---', 'name: reviewer', 'description: Reviews things', 'tags: [review]', '---', '{{ x }}'].join('\n'),
      { name: 'ignored', parseYaml },
    );
    expect(model.name).toBe('reviewer');
    expect(model.description).toBe('Reviews things');
    expect(model.tags).toEqual(['review']);
  });
});
