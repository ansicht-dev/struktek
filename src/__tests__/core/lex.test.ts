/**
 * Lexer spec.
 *
 * The cases that matter are the collisions: a `[` inside `choice[...]` must not
 * reach the bracket pass, and a `}}` inside a description must not terminate the
 * placeholder. Both are things a real prompt will contain — the second one is
 * guaranteed the moment you write a template about templating.
 */

import { describe, expect, it } from 'vitest';
import { lex } from '../../core/lex';

const placeholders = (source: string) =>
  lex(source).tokens.filter((t) => t.kind === 'placeholder');

describe('lex', () => {
  it('reads a bare placeholder as text-typed', () => {
    const [token] = placeholders('Hello {{ name }}');
    expect(token?.kind).toBe('placeholder');
    if (token?.kind !== 'placeholder') return;
    expect(token.decl.name).toBe('name');
    expect(token.decl.typeName).toBeUndefined();
  });

  it('reads name, type, pin and description together', () => {
    const [token] = placeholders('{{ format: output-format = json-strict "how to reply" }}');
    if (token?.kind !== 'placeholder') throw new Error('expected a placeholder');
    expect(token.decl.name).toBe('format');
    expect(token.decl.typeName).toBe('output-format');
    expect(token.decl.pin).toBe('json-strict');
    expect(token.decl.description).toBe('how to reply');
  });

  it('accepts the pin and the description in either order', () => {
    const [a] = placeholders('{{ f: t = x "d" }}');
    const [b] = placeholders('{{ f: t "d" = x }}');
    if (a?.kind !== 'placeholder' || b?.kind !== 'placeholder') throw new Error('expected placeholders');
    expect(a.decl).toMatchObject({ pin: 'x', description: 'd' });
    expect(b.decl).toMatchObject({ pin: 'x', description: 'd' });
  });

  it('keeps choice options inside the placeholder, away from the bracket pass', () => {
    const { tokens } = lex('{{ focus: choice[correctness, perf, security] }}');
    expect(tokens.filter((t) => t.kind === 'lbracket')).toHaveLength(0);
    const [token] = tokens.filter((t) => t.kind === 'placeholder');
    if (token?.kind !== 'placeholder') throw new Error('expected a placeholder');
    expect(token.decl.typeName).toBe('choice');
    expect(token.decl.typeArgs).toEqual(['correctness', 'perf', 'security']);
  });

  it('does not let a "}}" inside a description close the placeholder', () => {
    const { tokens } = lex('{{ x "close it with }} at the end" }} tail');
    const [token] = tokens.filter((t) => t.kind === 'placeholder');
    if (token?.kind !== 'placeholder') throw new Error('expected a placeholder');
    expect(token.decl.description).toBe('close it with }} at the end');
    expect(tokens[tokens.length - 1]).toMatchObject({ kind: 'text', value: ' tail' });
  });

  it('honours a backslash-escaped quote inside a description', () => {
    const [token] = placeholders('{{ x "say \\"hi\\" back" }}');
    if (token?.kind !== 'placeholder') throw new Error('expected a placeholder');
    expect(token.decl.description).toBe('say "hi" back');
  });

  it('emits bracket tokens for segment brackets', () => {
    const kinds = lex('a [b] c').tokens.map((t) => t.kind);
    expect(kinds).toEqual(['text', 'lbracket', 'text', 'rbracket', 'text']);
  });

  it('turns escaped delimiters into literal text', () => {
    const { tokens } = lex('\\[not a segment\\] and \\{\\{not a field\\}\\}');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      kind: 'text',
      value: '[not a segment] and {{not a field}}',
    });
  });

  it('reports an unterminated placeholder and keeps the text usable', () => {
    const { tokens, diagnostics } = lex('start {{ oops');
    expect(diagnostics[0]?.code).toBe('unterminated-placeholder');
    expect(tokens.every((t) => t.kind === 'text')).toBe(true);
  });

  it('reports a placeholder with no field name', () => {
    const { diagnostics } = lex('{{ }}');
    expect(diagnostics[0]?.code).toBe('empty-placeholder-name');
  });

  it('reports an empty choice list', () => {
    const { diagnostics } = lex('{{ f: choice[] }}');
    expect(diagnostics.map((d) => d.code)).toContain('empty-choice');
  });

  it('offsets spans by baseOffset so they point into the original file', () => {
    const [token] = lex('{{ a }}', 100).tokens;
    expect(token?.span).toEqual({ start: 100, end: 107 });
  });
});
