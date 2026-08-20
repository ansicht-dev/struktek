/**
 * The MCP surface: templates exposed as prompts AND as tools.
 *
 * Both, deliberately. MCP prompts are the right primitive — a template maps 1:1
 * onto one, its fields become `arguments[]`, and clients surface them as slash
 * commands like `/mcp__struktek__code-review`. But prompts are invisible to the
 * MODEL: a person can invoke one, and the agent cannot see it to choose. Since
 * the point is also letting an agent compose prompts for its own subagents, the
 * same templates are registered as tools, which models do see.
 *
 * The behaviour lives in exported pure functions, and `createStruktekServer`
 * only wires them onto an SDK server. The bridge's offline mode calls those same
 * functions directly, so "what struktek answers" is defined once whether or not
 * VS Code is running.
 */

import { McpServer, type RegisteredPrompt } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { render, validateValues, type BlockLibrary, type Field, type TemplateModel } from '../core';

export const MCP_SERVER_NAME = 'struktek';

/** What the surface needs from whoever owns the templates. */
export interface LibraryView {
  templates(): readonly TemplateModel[];
  blocks(): BlockLibrary;
  /**
   * Called after a successful compose. Absent offline — nothing to record into.
   *
   * The rendered prompt is passed too, so a host that keeps history can file an
   * agent-composed prompt beside the ones composed by hand. Without it the feed
   * would silently omit the runs an agent made, which are the ones you are
   * least likely to remember making.
   */
  record?(
    template: string,
    values: Readonly<Record<string, string | undefined>>,
    prompt: string,
  ): void;
}

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}
export interface ToolResult {
  readonly content: readonly TextContent[];
}
export interface PromptMessages {
  readonly messages: readonly { readonly role: 'user'; readonly content: TextContent }[];
}
/** Mutable arrays throughout: the SDK's wire types are not readonly. */
export interface PromptDefinition {
  name: string;
  description?: string;
  arguments: { name: string; description: string; required: boolean }[];
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** JSON in a text block — the shape every tool result takes. */
export function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * The values an agent may supply for a field.
 *
 * Reported inline with the field rather than behind a separate lookup: an agent
 * choosing a template needs to know what it may pass in the same breath as
 * discovering that the field exists.
 */
function optionsFor(field: Field, blocks: BlockLibrary): readonly string[] | undefined {
  if (field.type.kind === 'choice') return field.type.options;
  if (field.type.kind === 'blockType') return blocks.names.get(field.type.name) ?? [];
  return undefined;
}

/**
 * Must a caller actually supply this field?
 *
 * Narrower than `Field.required`, which is a fact about the template — whether
 * the field sits outside every optional segment. A field with a pinned default
 * is unconditional in the body yet perfectly fine to omit, because omitting it
 * is what selects the default. Advertising it as required would force every
 * agent to pass a value it was never meant to think about.
 */
function mustBeSupplied(field: Field): boolean {
  return field.required && field.pin === undefined;
}

/**
 * Human-readable argument help.
 *
 * This string IS the interface an agent reads to decide what to pass, so it
 * carries the options and the default rather than restating the field name.
 */
function argumentHelp(field: Field, blocks: BlockLibrary): string {
  const parts: string[] = [];
  if (field.description) parts.push(field.description);
  const options = optionsFor(field, blocks);
  if (options && options.length > 0) parts.push('one of: ' + options.join(', '));
  else if (field.type.kind !== 'text') parts.push('a ' + field.type.kind);
  if (field.pin !== undefined) parts.push('defaults to ' + field.pin);
  if (!field.required) parts.push('optional');
  return parts.join(' — ') || field.name;
}

// ── The behaviour, independent of any server ──────────────────────────────

export function listTemplatesPayload(view: LibraryView): unknown {
  const blocks = view.blocks();
  return {
    templates: view.templates().map((model) => ({
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      fields: model.fields.map((field) => {
        const options = optionsFor(field, blocks);
        return {
          name: field.name,
          type: field.type.kind === 'blockType' ? field.type.name : field.type.kind,
          required: mustBeSupplied(field),
          ...(field.description ? { description: field.description } : {}),
          ...(field.pin !== undefined ? { default: field.pin } : {}),
          ...(options ? { options } : {}),
        };
      }),
    })),
  };
}

export function composePayload(
  view: LibraryView,
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): { readonly prompt?: string; readonly unfilled?: readonly string[]; readonly error?: string } {
  const model = view.templates().find((t) => t.name === template);
  if (!model) {
    return {
      error:
        'No template named "' + template + '". Available: ' +
        (view.templates().map((t) => t.name).join(', ') || '(none)'),
    };
  }
  // A value that is not one of a closed set is a mistake, not a rendering
  // instruction. Refusing it costs the caller one retry; accepting it hands
  // back a prompt that looks finished and asks for the wrong thing.
  const problems = validateValues(model.fields, values, { blockTypes: view.blocks().names });
  if (problems.length > 0) {
    return { error: problems.map((problem) => problem.message).join(' ') };
  }

  const result = render(model.nodes, {
    values,
    fields: model.fields,
    blocks: view.blocks().bodies,
  });
  view.record?.(model.name, values, result.text);
  return { prompt: result.text, unfilled: result.unfilled };
}

export function promptDefinitions(view: LibraryView): PromptDefinition[] {
  const blocks = view.blocks();
  return view.templates().map((model) => ({
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    arguments: model.fields.map((field) => ({
      name: field.name,
      description: argumentHelp(field, blocks),
      required: mustBeSupplied(field),
    })),
  }));
}

export function promptMessages(
  view: LibraryView,
  name: string,
  args: Readonly<Record<string, string | undefined>>,
): PromptMessages {
  const composed = composePayload(view, name, args);
  return {
    messages: [{ role: 'user', content: { type: 'text', text: composed.prompt ?? composed.error ?? '' } }],
  };
}

/**
 * Tool definitions as plain JSON Schema.
 *
 * Written out rather than derived from the zod shapes because the bridge's
 * offline mode answers `tools/list` itself, with no SDK server to ask.
 */
export const LIST_TEMPLATES_TOOL = 'struktek_list_templates';
export const COMPOSE_TOOL = 'struktek_compose';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: LIST_TEMPLATES_TOOL,
    title: 'List prompt templates',
    description:
      "List the user's saved prompt templates with their fields, so you can pick one and " +
      'compose it with struktek_compose. Worth checking before writing a prompt for a subagent — ' +
      'the user has already worked out how they want these prompts phrased.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: COMPOSE_TOOL,
    title: 'Compose a prompt from a template',
    description:
      'Fill a saved template and get back the finished prompt text. Values are keyed by field ' +
      'name. An omitted optional field makes its bracketed segment drop out cleanly; a field ' +
      'with a default uses it when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: 'template name, as returned by struktek_list_templates',
        },
        values: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'field name to value; for choice and block fields pass one of its listed options',
        },
      },
      required: ['template'],
    },
  },
];

/** Dispatch a tool call without an SDK server — used by the offline bridge. */
export function callToolDirect(
  view: LibraryView,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolResult {
  if (name === 'struktek_list_templates') return json(listTemplatesPayload(view));
  if (name === 'struktek_compose') {
    const template = typeof args['template'] === 'string' ? args['template'] : '';
    const rawValues = args['values'];
    const values =
      typeof rawValues === 'object' && rawValues !== null
        ? (rawValues as Record<string, string>)
        : {};
    return json(composePayload(view, template, values));
  }
  return json({ error: 'Unknown tool: ' + name });
}

// ── The SDK server, for the live extension host ───────────────────────────

export interface StruktekServer {
  readonly server: McpServer;
  /** Re-sync prompt registrations after the library changed on disk. */
  refreshPrompts(): void;
}

export function createStruktekServer(getLibrary: () => LibraryView, version: string): StruktekServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });

  /**
   * Registration goes through a deliberately loose signature.
   *
   * The SDK infers a handler's argument type from its zod shape, and a `record`
   * value overruns TypeScript's instantiation budget (TS2589). The shapes below
   * are still the real schemas the client receives — only compile-time
   * inference is opted out of, and each handler declares its own types instead.
   */
  type Shape = Record<string, z.ZodTypeAny>;
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title?: string; description?: string; inputSchema?: Shape },
    callback: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => void;

  const definitionOf = (name: string): ToolDefinition => {
    const found = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!found) throw new Error('No tool definition for ' + name);
    return found;
  };
  const listDefinition = definitionOf(LIST_TEMPLATES_TOOL);
  const composeDefinition = definitionOf(COMPOSE_TOOL);

  registerTool(
    listDefinition.name,
    { title: listDefinition.title, description: listDefinition.description, inputSchema: {} },
    async () => json(listTemplatesPayload(getLibrary())),
  );

  registerTool(
    composeDefinition.name,
    {
      title: composeDefinition.title,
      description: composeDefinition.description,
      inputSchema: {
        template: z.string().describe('template name, as returned by struktek_list_templates'),
        values: z
          .record(z.string())
          .optional()
          .describe('field name to value; for choice and block fields pass one of its listed options'),
      },
    },
    async (args) => callToolDirect(getLibrary(), composeDefinition.name, args),
  );

  type PromptArgs = Record<string, string | undefined>;
  interface LoosePrompt {
    update(updates: {
      name?: string | null;
      description?: string;
      argsSchema?: Shape;
      callback?: (args: PromptArgs) => PromptMessages;
    }): void;
  }
  const registerPrompt = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: { description?: string; argsSchema?: Shape },
    callback: (args: PromptArgs) => PromptMessages,
  ) => RegisteredPrompt;

  const registered = new Map<string, RegisteredPrompt>();

  const refreshPrompts = (): void => {
    const view = getLibrary();
    const blocks = view.blocks();
    const live = new Set<string>();

    for (const model of view.templates()) {
      live.add(model.name);
      // MCP prompt arguments are always strings; a field's real type shows up in
      // the description, which is what the client renders as help.
      const argsSchema: Shape = {};
      for (const field of model.fields) {
        const help = argumentHelp(field, blocks);
        argsSchema[field.name] = mustBeSupplied(field)
          ? z.string().describe(help)
          : z.string().optional().describe(help);
      }
      const callback = (args: PromptArgs): PromptMessages =>
        promptMessages(getLibrary(), model.name, args ?? {});

      const existing = registered.get(model.name) as LoosePrompt | undefined;
      if (existing) {
        // Updated in place so a client already holding this prompt keeps
        // working — the body or its fields may have changed under it.
        existing.update({
          ...(model.description ? { description: model.description } : {}),
          argsSchema,
          callback,
        });
        continue;
      }
      registered.set(
        model.name,
        registerPrompt(
          model.name,
          { ...(model.description ? { description: model.description } : {}), argsSchema },
          callback,
        ),
      );
    }

    for (const [name, prompt] of registered) {
      if (live.has(name)) continue;
      // `name: null` is the SDK's removal signal.
      (prompt as unknown as LoosePrompt).update({ name: null });
      registered.delete(name);
    }
  };

  refreshPrompts();

  return { server, refreshPrompts };
}
