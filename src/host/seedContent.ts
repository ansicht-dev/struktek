import { BLOCKS_DIR, TEMPLATES_DIR } from './paths';

/**
 * Starter-library CONTENT.
 *
 * Separated from the code that writes it so the shipped templates can be run
 * through the parser in a unit test. A starter library that does not parse is a
 * worse first impression than an empty one, and it is exactly the kind of thing
 * that rots silently when the format gains a rule.
 *
 * No `vscode` import here — this is data.
 */

export interface SeedFile {
  readonly path: readonly string[];
  readonly body: string;
}

export const TEMPLATES: readonly SeedFile[] = [
  {
    path: [TEMPLATES_DIR, 'code-review.md'],
    body: [
      '---',
      'name: code-review',
      'description: Review a file for a specific class of problem',
      'tags: [review, quality]',
      '---',
      'Review {{ target: file "path to the file under review" }} for {{ focus: choice[correctness, performance, security, readability] }}.',
      '',
      'Go {{ depth: depth = thorough }}',
      '',
      '[Pay particular attention to {{ emphasis "anything specific to watch for" }}.]',
      '',
      '{{ format: output-format = prose }}',
      '',
    ].join('\n'),
  },
  {
    path: [TEMPLATES_DIR, 'explain.md'],
    body: [
      '---',
      'name: explain',
      'description: Explain code or a concept at a chosen level',
      'tags: [understand]',
      '---',
      'Explain {{ subject "what to explain — a file, symbol, or concept" }} to {{ audience: choice[a new teammate, someone outside engineering, my future self] }}.',
      '',
      '[Focus on {{ angle "a particular aspect, e.g. why it is built this way" }}.]',
      '',
      'Assume no prior knowledge of this codebase. Prefer concrete examples over abstractions.',
      '',
      '{{ format: output-format = prose }}',
      '',
    ].join('\n'),
  },
  {
    path: [TEMPLATES_DIR, 'debug.md'],
    body: [
      '---',
      'name: debug',
      'description: Investigate a failure from a symptom',
      'tags: [fix, debug]',
      '---',
      'Something is wrong: {{ symptom: block "what you observe going wrong" }}',
      '',
      '[It started after {{ trigger "a change, deploy, or upgrade" }}.]',
      '[Reproduce with: {{ repro }}]',
      '',
      'Find the root cause before proposing a fix. Tell me what you ruled out and why.',
      'If you cannot reproduce it from what I have given you, say what you need.',
      '',
      'Go {{ depth: depth = thorough }}',
      '',
    ].join('\n'),
  },
  {
    path: [TEMPLATES_DIR, 'refactor.md'],
    body: [
      '---',
      'name: refactor',
      'description: Restructure code without changing behaviour',
      'tags: [change, quality]',
      '---',
      'Refactor {{ target: file }} to {{ goal "the property you want, e.g. remove the duplicated parsing" }}.',
      '',
      'Behaviour must not change. Keep the public surface stable unless I say otherwise.',
      '[Constraint: {{ constraint }}]',
      '',
      'Show me the plan before you touch anything.',
      '',
    ].join('\n'),
  },
];

export const BLOCKS: readonly SeedFile[] = [
  {
    path: [BLOCKS_DIR, 'output-format', 'prose.md'],
    body: [
      '---',
      'title: Prose',
      'description: Flowing paragraphs, no bullets',
      'tags: [writing]',
      '---',
      'Answer in prose. No bullet lists unless the content is genuinely a list.',
      '',
    ].join('\n'),
  },
  {
    path: [BLOCKS_DIR, 'output-format', 'json-strict.md'],
    body: [
      '---',
      'title: Strict JSON',
      'description: Machine-readable, nothing else',
      'tags: [machine]',
      '---',
      'Reply with JSON only — no prose, no code fence, no commentary.',
      'If a value is unknown use null rather than omitting the key.',
      '',
    ].join('\n'),
  },
  {
    path: [BLOCKS_DIR, 'output-format', 'markdown-table.md'],
    body: [
      '---',
      'title: Markdown table',
      'description: One row per item, scannable',
      'tags: [writing]',
      '---',
      'Reply as a markdown table. Put the most important column first.',
      'Keep cells short enough to scan; move detail into a note under the table.',
      '',
    ].join('\n'),
  },
  {
    path: [BLOCKS_DIR, 'depth', 'quick.md'],
    body: [
      '---',
      'title: Quick',
      'description: A first pass, cheap and shallow',
      'tags: [fast]',
      '---',
      'shallow — flag anything obvious and stop. Do not read beyond what you need.',
      '',
    ].join('\n'),
  },
  {
    path: [BLOCKS_DIR, 'depth', 'thorough.md'],
    body: [
      '---',
      'title: Thorough',
      'description: Follow the call sites and the edge cases',
      'tags: [careful]',
      '---',
      'deep — read the surrounding code, follow the call sites, and check the edge cases.',
      'Say explicitly what you did not look at.',
      '',
    ].join('\n'),
  },
];

/** The body a brand-new template starts from. */
export function newTemplateBody(name: string): string {
  return [
    '---',
    'name: ' + name,
    'description: ',
    'tags: []',
    'note: ',
    '---',
    'Write the prompt here. Mark the parts that change with {{ field }}.',
    '',
    'Give a field a type when it helps: {{ target: file }}, {{ tone: choice[terse, warm] }},',
    'or a block type of your own: {{ format: output-format }}.',
    '',
    '[Wrap anything conditional in brackets - this line vanishes when {{ extra }} is blank.]',
    '',
  ].join('\n');
}

/**
 * The body a brand-new block instance starts from.
 *
 * The header is optional everywhere else, but a new file gets one so the
 * feature is visible the moment you make a block rather than only in the docs.
 * Everything below the fence is what actually lands in the prompt.
 */
export function newBlockBody(type: string, name: string): string {
  return [
    '---',
    'title: ' + name,
    'description: ',
    'tags: []',
    'note: ',
    '---',
    'Write what this ' + type + ' actually says. The whole body below the',
    'fence is substituted wherever a {{ field: ' + type + ' }} picks it.',
    '',
  ].join('\n');
}
