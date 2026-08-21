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
  toolDefinitionsFor,
  saveBlockPayload,
  saveTemplatePayload,
  SAVE_BLOCK_TOOL,
  SAVE_TEMPLATE_TOOL,
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

  it('every tool a view advertises is dispatchable by that view', () => {
    // Guards against a tool being advertised — which is what the offline bridge
    // does with this list — but never wired into the dispatcher.
    for (const tool of toolDefinitionsFor(view())) {
      const result = callToolDirect(view(), tool.name, { template: 'code-review' });
      const error: unknown = JSON.parse(result.content[0]!.text).error;
      expect(typeof error === 'string' ? error : '').not.toMatch(/^Unknown tool/);
    }
  });
});

describe('what a view is allowed to advertise', () => {
  const writer = { saveTemplate: async () => undefined, saveBlock: async () => undefined };
  const writable = (): LibraryView => ({ ...view(), write: writer });

  it('offers only the read-only pair when nothing can write', () => {
    // With VS Code closed there is nothing watching for a write, so a save tool
    // would be listed and unrunnable — worse than absent.
    expect(toolDefinitionsFor(view()).map((tool) => tool.name)).toEqual([
      LIST_TEMPLATES_TOOL,
      COMPOSE_TOOL,
    ]);
  });

  it('adds the save tools once a writer is supplied', () => {
    expect(toolDefinitionsFor(writable()).map((tool) => tool.name)).toContain(SAVE_TEMPLATE_TOOL);
    expect(toolDefinitionsFor(writable()).map((tool) => tool.name)).toContain(SAVE_BLOCK_TOOL);
  });

  it('marks reading safe and writing not, so a client can tell them apart', () => {
    const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(byName.get(LIST_TEMPLATES_TOOL)?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get(COMPOSE_TOOL)?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get(SAVE_TEMPLATE_TOOL)?.annotations?.readOnlyHint).toBe(false);
    // Saving replaces by name rather than removing anything.
    expect(byName.get(SAVE_TEMPLATE_TOOL)?.annotations?.destructiveHint).toBe(false);
    expect(byName.get(SAVE_TEMPLATE_TOOL)?.annotations?.idempotentHint).toBe(true);
  });
});

describe('saving', () => {
  it('refuses when nothing can write, and says why', async () => {
    const result = await saveTemplatePayload(view(), 'scratch', 'body');
    expect(result.saved).toBeUndefined();
    expect(result.error).toContain('VS Code is not running');
  });

  it('writes the body through and answers with the resource uri', async () => {
    const saved: string[] = [];
    const writable: LibraryView = {
      ...view(),
      write: {
        saveTemplate: async (name, body) => {
          saved.push(name + ':' + body);
        },
        saveBlock: async () => undefined,
      },
    };
    const result = await saveTemplatePayload(writable, 'scratch', 'Hello {{ who }}');
    expect(saved).toEqual(['scratch:Hello {{ who }}']);
    expect(result.saved).toBe('struktek://template/scratch');
  });

  it('refuses a name that is not a usable filename', async () => {
    const writable: LibraryView = {
      ...view(),
      write: { saveTemplate: async () => undefined, saveBlock: async () => undefined },
    };
    for (const name of ['', '  ', 'has space', '../escape']) {
      const result = await saveTemplatePayload(writable, name, 'body');
      expect(result.saved, name).toBeUndefined();
      expect(result.error, name).toBeTruthy();
    }
  });

  it('checks both halves of a block name', async () => {
    const writable: LibraryView = {
      ...view(),
      write: { saveTemplate: async () => undefined, saveBlock: async () => undefined },
    };
    expect((await saveBlockPayload(writable, 'depth', '../escape', 'b')).error).toBeTruthy();
    expect((await saveBlockPayload(writable, 'has space', 'quick', 'b')).error).toBeTruthy();
    expect((await saveBlockPayload(writable, 'depth', 'quick', 'b')).saved).toBe(
      'struktek://block/depth/quick',
    );
  });
});

describe('composePayload value checking', () => {
  it('refuses a choice that is not one of the options', () => {
    // Previously this rendered verbatim: `focus=bananas` came back as a
    // finished-looking prompt asking for bananas.
    const result = composePayload(view(), 'code-review', { target: 'a.ts', focus: 'bananas' });
    expect(result.prompt).toBeUndefined();
    expect(result.error).toContain('bananas');
    expect(result.error).toContain('correctness');
  });

  it('refuses a block value that is not an instance of its type', () => {
    // Previously this rendered as nothing, leaving the sentence around it
    // dangling, and said so only through an entry in `unfilled`.
    const result = composePayload(view(), 'code-review', {
      target: 'a.ts',
      focus: 'security',
      format: 'yaml',
    });
    expect(result.prompt).toBeUndefined();
    expect(result.error).toContain('yaml');
    expect(result.error).toContain('json-strict, prose');
  });

  it('does not record a composition it refused', () => {
    const record = vi.fn();
    composePayload(view(record), 'code-review', { target: 'a.ts', focus: 'bananas' });
    expect(record).not.toHaveBeenCalled();
  });

  it('still composes when every value is legal', () => {
    const result = composePayload(view(), 'code-review', { target: 'a.ts', focus: 'security' });
    expect(result.error).toBeUndefined();
    expect(result.prompt).toContain('security');
  });
});

describe('saving a template that would not parse', () => {
  const writable = (saved: string[]): LibraryView => ({
    ...view(),
    write: {
      parseYaml,
      saveTemplate: async (name, body) => {
        saved.push(name + ':' + body);
      },
      saveBlock: async () => undefined,
    },
  });

  it('refuses an unknown block type and writes nothing', async () => {
    // The tool description promises this; without it an agent could file a
    // broken template into someone's library and only find out much later.
    const saved: string[] = [];
    const result = await saveTemplatePayload(
      writable(saved),
      'probe',
      'Check {{ target: file }} using {{ depth: dpeth }}.',
    );
    expect(result.saved).toBeUndefined();
    expect(result.error).toContain('Nothing was written');
    expect(result.error).toContain('dpeth');
    expect(saved).toEqual([]);
  });

  it('refuses a field annotated two different ways', async () => {
    const saved: string[] = [];
    const result = await saveTemplatePayload(
      writable(saved),
      'probe',
      '{{ a: number }} and {{ a: file }}',
    );
    expect(result.error).toContain('Nothing was written');
    expect(saved).toEqual([]);
  });

  it('allows a warning through, since that is the author to judge', async () => {
    // An unmatched bracket degrades to literal text on purpose - `[see notes]`
    // is prose, and refusing it would make the rule wrong rather than strict.
    const saved: string[] = [];
    const result = await saveTemplatePayload(writable(saved), 'probe', 'see [ notes {{ a }}');
    expect(result.error).toBeUndefined();
    expect(saved).toHaveLength(1);
  });
});

/**
 * Where a save lands.
 *
 * The scope argument is the model's only way to reach the global library, and
 * the asymmetry matters: writing into the workspace touches one project,
 * writing globally touches every project the user opens. So the argument only
 * appears when there is genuinely a choice, the default is the cautious side,
 * and a scope this host cannot write to is refused rather than redirected.
 */
describe('choosing which library a save goes to', () => {
  const twoScoped = (record: { scope?: string }[] = []): LibraryView => ({
    ...view(),
    write: {
      parseYaml,
      scopes: () => ['workspace', 'global'],
      saveTemplate: async (_name, _body, scope) => {
        record.push({ ...(scope ? { scope } : {}) });
      },
      saveBlock: async (_type, _instance, _body, scope) => {
        record.push({ ...(scope ? { scope } : {}) });
      },
    },
  });

  const oneScoped = (): LibraryView => ({
    ...view(),
    write: {
      parseYaml,
      scopes: () => ['workspace'],
      saveTemplate: async () => undefined,
      saveBlock: async () => undefined,
    },
  });

  const scopeSchema = (tool: string, library: LibraryView): Record<string, unknown> | undefined => {
    const found = toolDefinitionsFor(library).find((candidate) => candidate.name === tool);
    return found?.inputSchema.properties['scope'] as Record<string, unknown> | undefined;
  };

  it('offers the argument on both save tools when there are two libraries', () => {
    for (const tool of [SAVE_TEMPLATE_TOOL, SAVE_BLOCK_TOOL]) {
      expect(scopeSchema(tool, twoScoped())?.['enum'], tool).toEqual(['workspace', 'global']);
    }
  });

  it('leaves the argument off entirely when there is only one library', () => {
    // An enum with one member invites a model to reason about a decision that
    // has already been made for it.
    for (const tool of [SAVE_TEMPLATE_TOOL, SAVE_BLOCK_TOOL]) {
      expect(scopeSchema(tool, oneScoped()), tool).toBeUndefined();
    }
  });

  it('leaves it off for a writer that does not distinguish libraries at all', () => {
    const legacy: LibraryView = {
      ...view(),
      write: { parseYaml, saveTemplate: async () => undefined, saveBlock: async () => undefined },
    };
    expect(scopeSchema(SAVE_TEMPLATE_TOOL, legacy)).toBeUndefined();
  });

  it('passes an omitted scope straight through as the host default', async () => {
    const record: { scope?: string }[] = [];
    const result = await saveTemplatePayload(twoScoped(record), 'scratch', 'Hello {{ who }}');
    expect(result.error).toBeUndefined();
    expect(record).toEqual([{}]);
    expect(result.scope).toBeUndefined();
  });

  it('passes a requested scope through and echoes it back', async () => {
    const record: { scope?: string }[] = [];
    const result = await saveTemplatePayload(
      twoScoped(record),
      'scratch',
      'Hello {{ who }}',
      'global',
    );
    expect(record).toEqual([{ scope: 'global' }]);
    expect(result.scope).toBe('global');
  });

  it('does the same for a block', async () => {
    const record: { scope?: string }[] = [];
    const result = await saveBlockPayload(twoScoped(record), 'tone', 'blunt', 'Be blunt.', 'global');
    expect(record).toEqual([{ scope: 'global' }]);
    expect(result.saved).toBe('struktek://block/tone/blunt');
    expect(result.scope).toBe('global');
  });

  it('refuses a scope this host cannot write to, rather than redirecting', async () => {
    // Silently writing it somewhere else would leave the model believing its
    // template is global when it landed in one project.
    const record: { scope?: string }[] = [];
    const result = await saveTemplatePayload(oneScoped(), 'scratch', 'Hello {{ who }}', 'global');
    expect(result.saved).toBeUndefined();
    expect(result.error).toContain('global');
    expect(record).toEqual([]);
  });

  it('refuses a scope that is not a scope', async () => {
    const result = await saveTemplatePayload(twoScoped(), 'scratch', 'Hello', 'everywhere');
    expect(result.error).toContain('everywhere');
  });
});
