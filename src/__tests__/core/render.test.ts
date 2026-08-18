/**
 * Render spec.
 *
 * Partial values are the normal case, so most of this file is about what
 * happens when a field is blank: which segments drop out, and — the fiddly part
 * — that the hole they leave closes cleanly. A collapsed segment that leaves a
 * double space or a stray blank line makes the output look broken, which is
 * worse than not having optional segments at all.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { parse } from '../../core/parse';
import { render } from '../../core/render';

const blockTypes = new Map<string, readonly string[]>([['output-format', ['json-strict']]]);
const blocks = new Map([['output-format', new Map([['json-strict', 'Return JSON.']])]]);

const build = (source: string) => {
  const model = analyze(parse(source), { name: 't', blockTypes });
  return { nodes: model.nodes, fields: model.fields };
};

const run = (source: string, values: Record<string, string | undefined>) => {
  const { nodes, fields } = build(source);
  return render(nodes, { values, fields, blocks });
};

describe('render', () => {
  it('substitutes filled placeholders', () => {
    expect(run('Hello {{ name }}!', { name: 'world' }).text).toBe('Hello world!');
  });

  it('keeps a fully-filled template byte-for-byte as authored', () => {
    const source = 'a  {{ x }}  b\n\n\nc';
    expect(run(source, { x: 'X' }).text).toBe('a  X  b\n\n\nc');
  });

  it('renders a segment when its field is filled', () => {
    expect(run('meet {{ who }} [at {{ time }}] today', { who: 'Bob', time: '5pm' }).text).toBe(
      'meet Bob at 5pm today',
    );
  });

  it('closes the gap when an inline segment collapses', () => {
    expect(run('meet {{ who }} [at {{ time }}] today', { who: 'Bob' }).text).toBe('meet Bob today');
  });

  it('takes the line with it when a segment owned the whole line', () => {
    const source = 'Line one.\n[note {{ x }}]\nLine two.';
    expect(run(source, {}).text).toBe('Line one.\nLine two.');
  });

  it('preserves a deliberate blank line around a collapsed segment', () => {
    const source = 'Intro.\n[note {{ x }}]\n\nOutro.';
    expect(run(source, {}).text).toBe('Intro.\n\nOutro.');
  });

  it('does not open a wider gap than the author used, when blank lines surround the segment', () => {
    // A block-level segment between two blank lines: dropping only its own line
    // break would leave three newlines where the template never has more than two.
    const source = 'Intro.\n\n[note {{ x }}]\n\nOutro.';
    expect(run(source, {}).text).toBe('Intro.\n\nOutro.');
  });

  it('collapses two adjacent segments as a single gap', () => {
    expect(run('a [{{ x }}] [{{ y }}] b', {}).text).toBe('a b');
  });

  it('keeps a segment alive when any one of its fields is filled', () => {
    // The blank field inside leaves the prose around it alone — `and` stays.
    // Splitting that into its own segment is the author's call, not ours.
    const source = '[for {{ a }} and {{ b }}]';
    expect(run(source, { a: 'X' }).text).toBe('for X and');
  });

  it('does not push punctuation away from the word it follows', () => {
    expect(run('Greet {{ who }} [in {{ lang }}].', { who: 'Ada' }).text).toBe('Greet Ada.');
    expect(run('Ask {{ who }} [about {{ topic }}], then stop.', { who: 'Bo' }).text).toBe(
      'Ask Bo, then stop.',
    );
  });

  it('leaves no leading or trailing whitespace behind', () => {
    expect(run('[{{ a }}] middle [{{ b }}]', {}).text).toBe('middle');
    expect(run('[{{ a }}] tail', {}).text).toBe('tail');
  });

  it('drops a segment only when every field inside is empty', () => {
    expect(run('[for {{ a }} and {{ b }}]', {}).text).toBe('');
  });

  it('collapses a nested segment independently of its parent', () => {
    const source = 'x [outer {{ a }} [inner {{ b }}]] y';
    expect(run(source, { a: 'A' }).text).toBe('x outer A y');
  });

  it('renders a block field as the instance body, not the instance name', () => {
    const { text } = run('Reply.\n\n{{ format: output-format }}', { format: 'json-strict' });
    expect(text).toBe('Reply.\n\nReturn JSON.');
  });

  it('treats a block instance that does not exist as unfilled', () => {
    const result = run('{{ format: output-format }}', { format: 'ghost' });
    expect(result.text).toBe('');
    expect(result.unfilled).toEqual(['format']);
  });

  it('falls back to the pin when no value is supplied', () => {
    expect(run('{{ format: output-format = json-strict }}', {}).text).toBe('Return JSON.');
  });

  it('lets an explicit value override the pin', () => {
    expect(run('{{ tone: choice[terse, warm] = terse }}', { tone: 'warm' }).text).toBe('warm');
  });

  it('reports unfilled fields in first-occurrence order', () => {
    const result = run('{{ b }} {{ a }} {{ b }}', {});
    expect(result.unfilled).toEqual(['b', 'a']);
  });

  it('reports the span of each collapsed segment', () => {
    const source = 'a [{{ x }}] b';
    const result = run(source, {});
    expect(result.collapsed).toHaveLength(1);
    const span = result.collapsed[0]!;
    expect(source.slice(span.start, span.end)).toBe('[{{ x }}]');
  });

  it('treats a whitespace-only value as empty', () => {
    expect(run('a [b {{ x }}] c', { x: '   ' }).text).toBe('a c');
  });
});
