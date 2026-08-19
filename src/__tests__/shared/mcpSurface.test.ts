/**
 * MCP surface spec.
 *
 * These are the pure functions the live host and the offline bridge BOTH call,
 * so pinning them here pins both paths at once. The thing most worth protecting
 * is the argument help: that string is the entire interface an agent reads to
 * decide what to pass, and a field whose options are missing from it is a field
 * the agent will guess at.
 */

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, type BlockLibrary } from '../../core';
import {
  callToolDirect,
  composePayload,
  COMPOSE_TOOL,
  LIST_TEMPLATES_TOOL,
  listTemplatesPayload,
  promptDefinitions,
  promptMessages,
  TOOL_DEFINITIONS,
  type LibraryView,
} from '../../shared/mcpSurface';

const blocks: BlockLibrary = {
  names: new Map([['output-format', ['json-strict', 'prose']]]),
  bodies: new Map([
    [
      'output-format',
      new Map([
        ['json-strict', 'Reply with JSON only.'],
        ['prose', 'Answer in prose.'],
      ]),
    ],
  ]),
};

const SOURCE = [
  '---',
  'name: code-review',
  'description: Review a file',
  '---',
  'Review {{ target: file "path relative to repo root" }} for {{ focus: choice[correctness, security] }}.',
  '[Watch for {{ emphasis }}.]',
  '',
  '{{ format: output-format = prose }}',
].join('\n');

function view(record?: LibraryView['record']): LibraryView {
  const model = loadTemplate(SOURCE, { name: 'code-review', parseYaml, blockTypes: blocks.names });
  return {
    templates: () => [model],
    blocks: () => blocks,
    ...(record ? { record } : {}),
  };
}

describe('listTemplatesPayload', () => {
  it('reports each field with its type, requiredness and allowed values', () => {
    const payload = listTemplatesPayload(view()) as {
      templates: { name: string; fields: Record<string, unknown>[] }[];
    };
    const fields = payload.templates[0]!.fields;
    expect(payload.templates[0]!.name).toBe('code-review');

    expect(fields[0]).toMatchObject({ name: 'target', type: 'file', required: true });
    expect(fields[1]).toMatchObject({
      name: 'focus',
      type: 'choice',
      options: ['correctness', 'security'],
    });
    expect(fields[2]).toMatchObject({ name: 'emphasis', required: false });
    // A block field reports its TYPE name and the instances that exist, which is
    // what an agent needs to pass a legal value.
    expect(fields[3]).toMatchObject({
      name: 'format',
      type: 'output-format',
      default: 'prose',
      options: ['json-strict', 'prose'],
    });
  });
});

describe('composePayload', () => {
  it('renders and reports what was left blank', () => {
    const result = composePayload(view(), 'code-review', {
      target: 'src/auth.ts',
      focus: 'security',
    });
    expect(result.prompt).toBe('Review src/auth.ts for security.\n\nAnswer in prose.');
    expect(result.unfilled).toEqual(['emphasis']);
  });

  it('resolves a block value to the instance body', () => {
    const result = composePayload(view(), 'code-review', {
      target: 'a.ts',
      focus: 'correctness',
      format: 'json-strict',
    });
    expect(result.prompt).toContain('Reply with JSON only.');
  });

  it('names the available templates when asked for one that does not exist', () => {
    const result = composePayload(view(), 'nope', {});
    expect(result.error).toContain('nope');
    expect(result.error).toContain('code-review');
    expect(result.prompt).toBeUndefined();
  });

  it('records the composition when the view can record', () => {
    const record = vi.fn();
    const result = composePayload(view(record), 'code-review', { target: 'a.ts', focus: 'security' });
    // The rendered prompt goes with it: an agent-composed prompt has to be
    // filed in the history the same as one composed by hand, and the payload
    // is the only place the text exists.
    expect(record).toHaveBeenCalledWith(
      'code-review',
      { target: 'a.ts', focus: 'security' },
      result.prompt,
    );
  });

  it('does not record a template that was not found', () => {
    const record = vi.fn();
    composePayload(view(record), 'nope', {});
    expect(record).not.toHaveBeenCalled();
  });
});

describe('promptDefinitions', () => {
  it('maps a template onto an MCP prompt with typed arguments', () => {
    const [prompt] = promptDefinitions(view());
    expect(prompt).toMatchObject({ name: 'code-review', description: 'Review a file' });
    expect(prompt!.arguments.map((a) => a.name)).toEqual(['target', 'focus', 'emphasis', 'format']);
  });

  it('marks a field used only inside an optional segment as not required', () => {
    const [prompt] = promptDefinitions(view());
    const emphasis = prompt!.arguments.find((a) => a.name === 'emphasis');
    expect(emphasis?.required).toBe(false);
  });

  it('does not require a field that has a default', () => {
    // `format` sits outside every optional segment, so the template calls it
    // required — but it is pinned to `prose`, and omitting it is exactly how you
    // select that. Demanding it would make every caller pass a value it was
    // never meant to think about.
    const [prompt] = promptDefinitions(view());
    const format = prompt!.arguments.find((a) => a.name === 'format');
    expect(format?.required).toBe(false);

    const target = prompt!.arguments.find((a) => a.name === 'target');
    expect(target?.required).toBe(true);
  });

  it('puts the allowed values and the default into the argument description', () => {
    const [prompt] = promptDefinitions(view());
    const focus = prompt!.arguments.find((a) => a.name === 'focus');
    expect(focus?.description).toContain('correctness, security');

    const format = prompt!.arguments.find((a) => a.name === 'format');
    expect(format?.description).toContain('json-strict, prose');
    expect(format?.description).toContain('defaults to prose');
  });

  it('keeps the authored description at the front of the help', () => {
    const [prompt] = promptDefinitions(view());
    const target = prompt!.arguments.find((a) => a.name === 'target');
    expect(target?.description.startsWith('path relative to repo root')).toBe(true);
  });
});

describe('promptMessages', () => {
  it('returns the rendered prompt as a single user message', () => {
    const result = promptMessages(view(), 'code-review', { target: 'a.ts', focus: 'security' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content.text).toContain('Review a.ts for security.');
  });

  it('surfaces the error as the message rather than returning nothing', () => {
    const result = promptMessages(view(), 'nope', {});
    expect(result.messages[0]!.content.text).toContain('No template named');
  });
});

describe('callToolDirect', () => {
  it('dispatches the list tool', () => {
    const result = callToolDirect(view(), LIST_TEMPLATES_TOOL, {});
    expect(JSON.parse(result.content[0]!.text)).toHaveProperty('templates');
  });

  it('dispatches the compose tool', () => {
    const result = callToolDirect(view(), COMPOSE_TOOL, {
      template: 'code-review',
      values: { target: 'a.ts', focus: 'security' },
    });
    expect(JSON.parse(result.content[0]!.text).prompt).toContain('Review a.ts');
  });

  it('reports an unknown tool rather than throwing', () => {
    const result = callToolDirect(view(), 'struktek_nonesuch', {});
    expect(JSON.parse(result.content[0]!.text).error).toContain('struktek_nonesuch');
  });

  it('every advertised tool is dispatchable', () => {
    // Guards against a tool being listed in TOOL_DEFINITIONS — which is what the
    // offline bridge advertises — but never wired into the dispatcher.
    for (const tool of TOOL_DEFINITIONS) {
      const result = callToolDirect(view(), tool.name, { template: 'code-review' });
      const error: unknown = JSON.parse(result.content[0]!.text).error;
      expect(typeof error === 'string' ? error : '').not.toMatch(/^Unknown tool/);
    }
  });
});
