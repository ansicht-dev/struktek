/**
 * Field-reconciliation spec.
 *
 * "Type once, reference bare everywhere else" is the rule this file protects,
 * along with its counterpart: two annotations disagreeing is an error rather
 * than last-wins, because a silent winner would have the composer prompting for
 * a type the body does not use.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { parse } from '../../core/parse';
import type { Frontmatter } from '../../core/types';

const model = (
  source: string,
  opts: { frontmatter?: Frontmatter; blockTypes?: ReadonlyMap<string, readonly string[]> } = {},
) =>
  analyze(parse(source), {
    name: 'fixture',
    ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}),
    ...(opts.blockTypes ? { blockTypes: opts.blockTypes } : {}),
  });

const blockTypes = new Map<string, readonly string[]>([
  ['output-format', ['json-strict', 'markdown-table']],
]);

describe('analyze', () => {
  it('defaults an unannotated field to text', () => {
    const { fields } = model('Hello {{ name }}');
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'name', type: { kind: 'text' }, required: true });
  });

  it('collapses repeated occurrences into one field', () => {
    const { fields } = model('{{ a: number }} and {{ a }} again {{ a }}');
    expect(fields).toHaveLength(1);
    expect(fields[0]?.type).toEqual({ kind: 'number' });
  });

  it('accepts the annotation on any occurrence, not just the first', () => {
    const { fields, diagnostics } = model('{{ a }} then {{ a: file }}');
    expect(diagnostics).toHaveLength(0);
    expect(fields[0]?.type).toEqual({ kind: 'file' });
  });

  it('errors when two occurrences disagree on the type', () => {
    const { diagnostics } = model('{{ a: text }} versus {{ a: number }}');
    expect(diagnostics.map((d) => d.code)).toContain('conflicting-type');
  });

  it('does not treat an identical repeated annotation as a conflict', () => {
    const { diagnostics } = model('{{ a: choice[x, y] }} and {{ a: choice[x, y] }}');
    expect(diagnostics).toHaveLength(0);
  });

  it('marks a field appearing only inside a segment as optional', () => {
    const { fields } = model('{{ a }} [and {{ b }}]');
    expect(fields.find((f) => f.name === 'a')?.required).toBe(true);
    expect(fields.find((f) => f.name === 'b')?.required).toBe(false);
  });

  it('promotes a field to required when any occurrence is unconditional', () => {
    const { fields } = model('[maybe {{ a }}] but definitely {{ a }}');
    expect(fields[0]?.required).toBe(true);
  });

  it('resolves an unknown type name to a block type when the library is unscanned', () => {
    const { fields, diagnostics } = model('{{ f: output-format }}');
    expect(fields[0]?.type).toEqual({ kind: 'blockType', name: 'output-format' });
    expect(diagnostics).toHaveLength(0);
  });

  it('errors on an unknown type once the library has been scanned', () => {
    const { diagnostics } = model('{{ f: nonesuch }}', { blockTypes });
    expect(diagnostics.map((d) => d.code)).toContain('unknown-type');
  });

  it('accepts a pin naming a real block instance', () => {
    const { fields, diagnostics } = model('{{ f: output-format = json-strict }}', { blockTypes });
    expect(diagnostics).toHaveLength(0);
    expect(fields[0]?.pin).toBe('json-strict');
  });

  it('errors on a pin that names no instance of the block type', () => {
    const { diagnostics } = model('{{ f: output-format = nope }}', { blockTypes });
    expect(diagnostics.map((d) => d.code)).toContain('unknown-instance');
  });

  it('errors on a pin outside the choice options', () => {
    const { diagnostics } = model('{{ f: choice[a, b] = c }}');
    expect(diagnostics.map((d) => d.code)).toContain('unknown-instance');
  });

  it('lets frontmatter supply a type the body did not annotate', () => {
    const { fields } = model('{{ f }}', { frontmatter: { args: { f: 'choice[a, b]' } } });
    expect(fields[0]?.type).toEqual({ kind: 'choice', options: ['a', 'b'] });
  });

  it('lets frontmatter override an inline type', () => {
    const { fields } = model('{{ f: text }}', {
      frontmatter: { args: { f: { type: 'number', description: 'how many' } } },
    });
    expect(fields[0]).toMatchObject({ type: { kind: 'number' }, description: 'how many' });
  });

  it('takes the template name from frontmatter over the filename', () => {
    expect(model('body', { frontmatter: { name: 'from-frontmatter' } }).name).toBe('from-frontmatter');
    expect(model('body').name).toBe('fixture');
  });

  it('keeps fields in first-occurrence order', () => {
    const { fields } = model('{{ c }} {{ a }} {{ b }} {{ a }}');
    expect(fields.map((f) => f.name)).toEqual(['c', 'a', 'b']);
  });
});
