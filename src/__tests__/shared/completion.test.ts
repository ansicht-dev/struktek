/**
 * What the cursor is asking for, as a table.
 *
 * The provider that consumes this decides which names to offer; everything
 * subtle lives here — knowing when a placeholder is finished, when the cursor
 * is inside a description rather than in syntax, and which field an annotation
 * belongs to.
 */

import { describe, expect, it } from 'vitest';
import { completionContext } from '../../shared/completion';

describe('completionContext', () => {
  it('offers nothing in ordinary prose', () => {
    expect(completionContext('Review the file ').kind).toBe('none');
    expect(completionContext('').kind).toBe('none');
  });

  it('offers nothing before a type has been asked for', () => {
    // A bare `{{ name` may stay bare; suggesting a type there would push one on
    // an author who did not want one.
    expect(completionContext('Review {{ target').kind).toBe('none');
  });

  it('asks for a type after the colon', () => {
    expect(completionContext('Review {{ target: ')).toEqual({
      kind: 'type',
      field: 'target',
      prefix: '',
    });
  });

  it('carries what has been typed of the type', () => {
    expect(completionContext('Review {{ target: fi')).toMatchObject({
      kind: 'type',
      prefix: 'fi',
    });
  });

  it('stops once the placeholder is closed', () => {
    expect(completionContext('Review {{ target: file }} for ').kind).toBe('none');
  });

  it('stops inside a description, which is prose and not syntax', () => {
    expect(completionContext('{{ target: file "the path to ').kind).toBe('none');
    // Closed again — the cursor is back in syntax.
    expect(completionContext('{{ target: file "the path" = ').kind).toBe('value');
  });

  it('asks for a value after the equals, and knows the declared type', () => {
    expect(completionContext('Go {{ depth: depth = ')).toEqual({
      kind: 'value',
      field: 'depth',
      typeName: 'depth',
      prefix: '',
    });
  });

  it('asks for a value with no declared type when the field was typed elsewhere', () => {
    // `{{ depth = quick }}` is legal when another occurrence carries the type,
    // so the provider has to resolve it from the model instead.
    const context = completionContext('Go {{ depth = ');
    expect(context.kind).toBe('value');
    expect(context.field).toBe('depth');
    expect(context.typeName).toBeUndefined();
  });

  it('reads choice[a, b] as the type choice', () => {
    expect(completionContext('{{ focus: choice[a, b] = ')).toMatchObject({
      kind: 'value',
      typeName: 'choice',
    });
  });

  it('offers nothing inside a finished option list', () => {
    // The options are the author's to invent; there is nothing to suggest.
    expect(completionContext('{{ focus: choice[a, b]').kind).toBe('none');
  });

  it('still offers types while the option list is being opened', () => {
    expect(completionContext('{{ focus: choice[a, ').kind).toBe('type');
  });

  it('ignores a malformed field name rather than guessing', () => {
    expect(completionContext('{{ not a name: ').field).toBeUndefined();
  });

  it('reads the nearest placeholder when several are on one line', () => {
    expect(completionContext('{{ a: text }} and {{ b: ')).toMatchObject({
      kind: 'type',
      field: 'b',
    });
  });
});
