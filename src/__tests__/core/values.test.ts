/**
 * The check that was missing everywhere a value arrives from outside.
 *
 * A person picks from a dropdown and cannot get this wrong. An agent types the
 * value, and until this existed a typo produced either a dangling sentence or,
 * worse, a plausible prompt asking for something nobody wanted.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, validateValues } from '../../core';

const blockTypes = new Map([
  ['depth', ['quick', 'thorough']],
  ['output-format', ['prose', 'json-strict']],
]);

const model = loadTemplate(
  [
    'Review {{ target: file }} for {{ focus: choice[correctness, security] }}.',
    'Go {{ depth: depth = thorough }}',
    '[Note {{ emphasis }}.]',
    '{{ format: output-format = prose }}',
    'Count: {{ n: number }}',
  ].join('\n'),
  { name: 'fixture', parseYaml, blockTypes },
);

const check = (values: Record<string, string | undefined>) =>
  validateValues(model.fields, values, { blockTypes });

describe('validateValues', () => {
  it('accepts a complete, legal set', () => {
    expect(
      check({
        target: 'a.ts',
        focus: 'security',
        depth: 'quick',
        emphasis: 'anything',
        format: 'prose',
        n: '3',
      }),
    ).toEqual([]);
  });

  it('rejects a choice that is not one of the options, and says which are', () => {
    // This was the quiet one: `focus=bananas` rendered verbatim and produced a
    // perfectly plausible prompt asking for the wrong thing.
    const problems = check({ focus: 'bananas' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('focus');
    expect(problems[0]?.value).toBe('bananas');
    expect(problems[0]?.message).toContain('correctness, security');
  });

  it('rejects a block value that is not an instance of its type', () => {
    const problems = check({ depth: 'exhaustive' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('not a value of "depth"');
    expect(problems[0]?.message).toContain('quick, thorough');
  });

  it('reports every bad value rather than stopping at the first', () => {
    expect(check({ focus: 'bananas', depth: 'exhaustive' }).map((p) => p.field)).toEqual([
      'focus',
      'depth',
    ]);
  });

  it('leaves omitted and blank values alone', () => {
    // Omitting is legal - the field may be optional, or its pin fills in, and
    // a pin was already validated when the template was analysed.
    expect(check({})).toEqual([]);
    expect(check({ focus: '', depth: undefined })).toEqual([]);
    expect(check({ focus: '   ' })).toEqual([]);
  });

  it('ignores surrounding whitespace when matching', () => {
    expect(check({ focus: '  security  ' })).toEqual([]);
  });

  it('says nothing about the open types', () => {
    // text, block, file and number take whatever the caller meant; guessing at
    // what a number should look like would reject input someone had a reason for.
    expect(check({ target: 'anything at all', emphasis: '???', n: 'not a number' })).toEqual([]);
  });

  it('passes block values when no library has been scanned', () => {
    // Nothing to check against is not the same as the value being wrong.
    expect(validateValues(model.fields, { depth: 'exhaustive' })).toEqual([]);
  });

  it('names a type that exists but holds nothing yet', () => {
    const empty = new Map([['depth', []], ['output-format', ['prose']]]);
    const problems = validateValues(model.fields, { depth: 'quick' }, { blockTypes: empty });
    expect(problems[0]?.message).toContain('(none defined yet)');
  });
});
