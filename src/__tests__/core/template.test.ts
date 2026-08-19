/**
 * End-to-end format spec: a template file in, a model out.
 *
 * Also pins the frontmatter contract — optional, and forgiving. A typo in an
 * optional header must not take the author's prompt away from them, so
 * malformed frontmatter degrades to "no frontmatter" rather than failing.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, splitFrontmatter } from '../../core/template';
import { render } from '../../core/render';

const blockTypes = new Map<string, readonly string[]>([
  ['output-format', ['json-strict', 'markdown-table']],
]);
const blocks = new Map([['output-format', new Map([['json-strict', 'Return JSON.']])]]);

const load = (source: string) => loadTemplate(source, { name: 'fixture', parseYaml, blockTypes });

const CODE_REVIEW = [
  '---',
  'name: code-review',
  'description: Review a file for a specific class of problem',
  '---',
  'Review {{ target: file "path relative to repo root" }} for {{ focus: choice[correctness, perf, security] }}.',
  '[Pay particular attention to {{ emphasis }}.]',
  '',
  '{{ format: output-format = json-strict }}',
].join('\n');

describe('splitFrontmatter', () => {
  it('reports a body offset that keeps spans pointing at the original file', () => {
    const source = '---\nname: x\n---\nbody {{ a }}';
    const split = splitFrontmatter(source, parseYaml);
    expect(split.body).toBe('body {{ a }}');
    expect(source.slice(split.bodyOffset)).toBe(split.body);
  });

  it('leaves a body with no frontmatter untouched', () => {
    const split = splitFrontmatter('just a body', parseYaml);
    expect(split.frontmatter).toBeUndefined();
    expect(split.bodyOffset).toBe(0);
  });

  it('does not mistake a horizontal rule mid-body for frontmatter', () => {
    const split = splitFrontmatter('intro\n\n---\n\nmore', parseYaml);
    expect(split.frontmatter).toBeUndefined();
    expect(split.bodyOffset).toBe(0);
  });
});

describe('loadTemplate', () => {
  it('models the worked example end to end', () => {
    const model = load(CODE_REVIEW);
    expect(model.diagnostics).toHaveLength(0);
    expect(model.name).toBe('code-review');
    expect(model.description).toBe('Review a file for a specific class of problem');
    expect(model.fields.map((f) => f.name)).toEqual(['target', 'focus', 'emphasis', 'format']);

    const target = model.fields[0]!;
    expect(target.type).toEqual({ kind: 'file' });
    expect(target.description).toBe('path relative to repo root');
    expect(target.required).toBe(true);

    expect(model.fields[1]?.type).toEqual({
      kind: 'choice',
      options: ['correctness', 'perf', 'security'],
    });
    // Only referenced inside the optional segment, so an agent need not pass it.
    expect(model.fields[2]?.required).toBe(false);
    expect(model.fields[3]).toMatchObject({
      type: { kind: 'blockType', name: 'output-format' },
      pin: 'json-strict',
    });
  });

  it('renders the worked example with the optional segment dropped', () => {
    const model = load(CODE_REVIEW);
    const { text } = render(model.nodes, {
      values: { target: 'src/auth.ts', focus: 'security' },
      fields: model.fields,
      blocks,
    });
    expect(text).toBe('Review src/auth.ts for security.\n\nReturn JSON.');
  });

  it('renders the worked example with the optional segment kept', () => {
    const model = load(CODE_REVIEW);
    const { text } = render(model.nodes, {
      values: { target: 'src/auth.ts', focus: 'security', emphasis: 'token handling' },
      fields: model.fields,
      blocks,
    });
    expect(text).toBe(
      'Review src/auth.ts for security.\nPay particular attention to token handling.\n\nReturn JSON.',
    );
  });

  it('spans point into the original file, past the frontmatter', () => {
    const model = load(CODE_REVIEW);
    const target = model.fields[0]!;
    expect(CODE_REVIEW.slice(target.span.start, target.span.end)).toBe(
      '{{ target: file "path relative to repo root" }}',
    );
  });

  it('reads argument metadata from frontmatter', () => {
    const source = [
      '---',
      'args:',
      '  depth:',
      '    type: choice[quick, thorough]',
      '    description: how hard to look',
      '    default: quick',
      '---',
      'Look {{ depth }}.',
    ].join('\n');
    const model = load(source);
    expect(model.fields[0]).toMatchObject({
      name: 'depth',
      type: { kind: 'choice', options: ['quick', 'thorough'] },
      description: 'how hard to look',
      pin: 'quick',
    });
  });

  it('accepts the string shorthand for an argument type', () => {
    const model = load('---\nargs:\n  n: number\n---\n{{ n }}');
    expect(model.fields[0]?.type).toEqual({ kind: 'number' });
  });

  it('degrades malformed frontmatter to no frontmatter rather than failing', () => {
    const model = load('---\nargs: [not, a, map]\n---\nbody {{ a }}');
    expect(model.name).toBe('fixture');
    expect(model.fields.map((f) => f.name)).toEqual(['a']);
  });
});

describe('note', () => {
  it('reaches the model without reaching the prompt', () => {
    const model = load('---\nnote: Only use this on files you own\n---\nReview {{ target }}');
    expect(model.note).toBe('Only use this on files you own');
    // The whole point of `note`: it is commentary for whoever picks the
    // template, and must never leak into what the agent is sent.
    const text = render(model.nodes, { values: { target: 'a.ts' }, fields: model.fields }).text;
    expect(text).toBe('Review a.ts');
  });

  it('is absent rather than empty when not given', () => {
    expect(load('body {{ a }}').note).toBeUndefined();
    expect(load('---\nname: x\n---\nbody {{ a }}').note).toBeUndefined();
  });

  it('is enough on its own to count as frontmatter', () => {
    // `coerceFrontmatter` returns undefined when every key it honours is
    // missing; a header carrying only a note must still survive that check.
    expect(splitFrontmatter('---\nnote: careful\n---\nbody', parseYaml).frontmatter).toEqual({
      note: 'careful',
    });
  });
});
