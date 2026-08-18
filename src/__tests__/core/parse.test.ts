/**
 * Structural-pass spec.
 *
 * The two rules worth pinning: brackets with no placeholder inside are prose,
 * not a segment; and an unmatched bracket degrades to text instead of failing
 * the parse. Both exist because a prompt is prose first and a template second.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../../core/parse';
import type { Node } from '../../core/types';

const kinds = (nodes: readonly Node[]) => nodes.map((n) => n.kind);

describe('parse', () => {
  it('makes a bracket group with a placeholder into an optional segment', () => {
    const { nodes } = parse('meet {{who}} [at {{time}}] today');
    expect(kinds(nodes)).toEqual(['text', 'placeholder', 'text', 'optional', 'text']);
  });

  it('treats a bracket group with no placeholder as literal prose', () => {
    const { nodes } = parse('review the code [see notes] carefully');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'text',
      value: 'review the code [see notes] carefully',
    });
  });

  it('nests optional segments', () => {
    const { nodes } = parse('a [b {{x}} [c {{y}}] d] e');
    const outer = nodes.find((n) => n.kind === 'optional');
    if (outer?.kind !== 'optional') throw new Error('expected an outer segment');
    expect(outer.children.some((c) => c.kind === 'optional')).toBe(true);
  });

  it('keeps an inner placeholder-free group literal inside a real segment', () => {
    const { nodes } = parse('[fix {{bug}} (see [notes])]');
    const segment = nodes.find((n) => n.kind === 'optional');
    if (segment?.kind !== 'optional') throw new Error('expected a segment');
    const text = segment.children.filter((c) => c.kind === 'text').map((c) => (c as { value: string }).value);
    expect(text.join('')).toContain('[notes]');
  });

  it('degrades an unmatched opening bracket to text and warns', () => {
    const { nodes, diagnostics } = parse('a [b {{x}} c');
    expect(diagnostics.map((d) => d.code)).toContain('unmatched-bracket');
    expect(nodes.some((n) => n.kind === 'optional')).toBe(false);
    expect(nodes.filter((n) => n.kind === 'text').map((n) => (n as { value: string }).value).join('')).toContain('[');
  });

  it('degrades a stray closing bracket to text', () => {
    const { nodes } = parse('a] b');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'text', value: 'a] b' });
  });

  it('merges adjacent text runs so the tree stays readable', () => {
    const { nodes } = parse('plain \\[escaped\\] text');
    expect(nodes).toHaveLength(1);
  });

  it('spans cover the whole segment including its brackets', () => {
    const source = 'ab[{{x}}]cd';
    const { nodes } = parse(source);
    const segment = nodes.find((n) => n.kind === 'optional');
    expect(segment?.span).toEqual({ start: 2, end: 9 });
    expect(source.slice(2, 9)).toBe('[{{x}}]');
  });
});
