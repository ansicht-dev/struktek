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

import {
  McpServer,
  ResourceTemplate,
  type RegisteredPrompt,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  loadTemplate,
  render,
  validateValues,
  type BlockLibrary,
  type Field,
  type LibraryScope,
  type TemplateModel,
} from '../core';

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
  /**
   * Save a template or a block. Absent offline, and the tools go with it.
   *
   * The bridge reads straight off disk when VS Code is closed, with no watcher
   * to notice a write, no library to reload and no editor to show the result.
   * Rather than write behind all of that, the offline server simply does not
   * offer the tools - a missing tool is a clearer answer than one that half
   * works.
   */
  readonly write?: LibraryWriter;
}

export interface LibraryWriter {
  /**
   * Injected, since `core/` depends on no YAML implementation of its own.
   *
   * Present so a body can be parsed before it is written: the tool promises a
   * broken template is refused, and that promise has to be kept here rather
   * than in whichever host happens to be calling.
   */
  readonly parseYaml: (source: string) => unknown;
  /**
   * Which libraries this host can actually write to, most local first.
   *
   * The tool only offers `scope` as a parameter when there is more than one,
   * so a model working in a window with no folder open is not asked to choose
   * between two places one of which does not exist. Absent means the same as
   * one: a writer that does not distinguish libraries has nothing to choose
   * between, and the argument stays off its schema.
   */
  scopes?(): readonly LibraryScope[];
  saveTemplate(name: string, body: string, scope?: LibraryScope): Promise<void>;
  saveBlock(type: string, instance: string, body: string, scope?: LibraryScope): Promise<void>;
}

export const SAVE_TEMPLATE_TOOL = 'struktek_save_template';
export const SAVE_BLOCK_TOOL = 'struktek_save_block';

/**
 * The answer to a save, including where it landed.
 *
 * `scope` is echoed rather than assumed: the caller may have omitted it, and
 * "saved into the workspace" versus "saved for every project" is the part of
 * the outcome worth reporting back.
 */
export interface SaveResult {
  readonly saved?: string;
  readonly scope?: LibraryScope;
  readonly error?: string;
}

/**
 * What the server tells a client on connect.
 *
 * Tool descriptions are read at the point of use, which is after the model has
 * already decided to look. This is the part that has to arrive first: that
 * there is a library worth checking, and that it belongs to someone.
 */
export const SERVER_INSTRUCTIONS = [
  "Struktek holds the user's own prompt templates. They wrote these deliberately,",
  'so before composing a prompt for a subagent - or writing one from scratch -',
  'call struktek_list_templates and use a template if one fits.',
  '',
  'struktek_compose fills a template and returns the finished text. Pass values',
  'keyed by field name. A field of a "choice" or block type accepts only its',
  'listed options and the call is refused otherwise. Omitting an optional field',
  'makes its bracketed segment drop out cleanly; omitting a field with a default',
  'uses that default. The reply lists any field left "unfilled" - check it before',
  'sending the prompt on.',
  '',
  'Block types are shared vocabulary: a block type is a folder and its values are',
  'files, so a value used by one template can be used by every template with that',
  'field. Prefer an existing block value over inventing new wording for the same',
  'idea.',
  '',
  'Template and block sources are readable as resources under struktek://, which',
  'is where to look before editing one.',
].join('\n');


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
  /**
   * What a client needs to decide whether to ask before running this.
   *
   * Without them every call looks equally consequential, so listing templates
   * gets the same approval prompt as writing one.
   */
  annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
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
      // Only when it is global. A model does not need telling that the
      // workspace's own templates are the workspace's — but it does need to
      // know which ones it would be changing for every other project.
      ...(model.scope === 'global' ? { scope: 'global' } : {}),
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

/**
 * Save a template, refusing a body that does not parse cleanly.
 *
 * The same posture as composing with a bad value: an agent writing a broken
 * template into a library that is not its own is worse than being told no,
 * diagnostics already say exactly what is wrong and where.
 */
export async function saveTemplatePayload(
  view: LibraryView,
  name: string,
  body: string,
  scope?: string,
): Promise<SaveResult> {
  if (!view.write) return { error: notWritable };
  const bad = badName(name);
  if (bad) return { error: bad };
  const target = coerceScope(view, scope);
  if ('error' in target) return target;

  // Errors only. A warning is a judgement call the author is allowed to make -
  // "[see notes]" is prose, not a mistake - but an unknown type or a field
  // annotated two ways is broken however it got there.
  const model = loadTemplate(body, {
    name,
    parseYaml: view.write.parseYaml,
    blockTypes: view.blocks().names,
  });
  const errors = model.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return {
      error:
        'Nothing was written. ' + errors.map((d) => d.message).join(' '),
    };
  }

  try {
    await view.write.saveTemplate(name, body, target.scope);
  } catch (err) {
    return { error: 'Could not save "' + name + '": ' + String(err) };
  }
  return { saved: 'struktek://template/' + name, scope: target.scope };
}

export async function saveBlockPayload(
  view: LibraryView,
  type: string,
  instance: string,
  body: string,
  scope?: string,
): Promise<SaveResult> {
  if (!view.write) return { error: notWritable };
  const bad = badName(type) ?? badName(instance);
  if (bad) return { error: bad };
  const target = coerceScope(view, scope);
  if ('error' in target) return target;

  try {
    await view.write.saveBlock(type, instance, body, target.scope);
  } catch (err) {
    return { error: 'Could not save "' + type + '/' + instance + '": ' + String(err) };
  }
  return { saved: 'struktek://block/' + type + '/' + instance, scope: target.scope };
}

/**
 * Resolve the requested scope, refusing one this host cannot write to.
 *
 * Refused rather than silently redirected: "global" and "workspace" mean
 * different things to everyone who later reads the file, and a model told its
 * template is global when it landed in one project would go on to rely on
 * that. Omitted is not a refusal — it means the host's own default.
 */
function coerceScope(
  view: LibraryView,
  scope: string | undefined,
): { readonly scope?: LibraryScope } | { readonly error: string } {
  if (scope === undefined) return {};
  const available = view.write?.scopes?.() ?? [];
  if (!available.includes(scope as LibraryScope)) {
    return {
      error:
        '"' + scope + '" is not a library this workspace can write to. Available: ' +
        (available.join(', ') || '(none)') + '. Omit "scope" to use the default.',
    };
  }
  return { scope: scope as LibraryScope };
}

const notWritable =
  'The library is read-only right now - VS Code is not running, so there is nothing watching for the change. Open the workspace in VS Code and try again.';

/** A name is also a filename, so the same rule the UI enforces applies here. */
function badName(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'A name is required.';
  if (!/^[A-Za-z0-9_.\-]+$/.test(trimmed)) {
    return '"' + value + '" is not a usable name - letters, digits, dot, dash and underscore only.';
  }
  return undefined;
}

export interface ResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType: string;
}

export interface ResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export const RESOURCE_SCHEME = 'struktek://';

/**
 * Everything readable, as one flat list.
 *
 * Shared rather than inlined into the registration, because the bridge serves
 * these itself when VS Code is closed - the same reason `callToolDirect`
 * exists beside the registered tools.
 */
export function resourceEntries(view: LibraryView): ResourceEntry[] {
  const entries: ResourceEntry[] = view.templates().map((model) => ({
    uri: RESOURCE_SCHEME + 'template/' + model.name,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    mimeType: 'text/markdown',
  }));

  const blocks = view.blocks();
  for (const [type, instances] of blocks.names) {
    for (const instance of instances) {
      // The sidebar falls back to the body when a block carries no header, and
      // a listing that instead repeats a generic blurb would describe the same
      // block two different ways.
      const description =
        blocks.meta.get(type)?.get(instance)?.description ??
        firstLine(blocks.bodies.get(type)?.get(instance));
      entries.push({
        uri: RESOURCE_SCHEME + 'block/' + type + '/' + instance,
        name: type + '/' + instance,
        ...(description ? { description } : {}),
        mimeType: 'text/markdown',
      });
    }
  }
  return entries;
}

/** Enough of the body to say what a block does, when nothing else says it. */
function firstLine(body: string | undefined): string | undefined {
  const line = (body ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
  if (line.length === 0) return undefined;
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

/** The file as written, or undefined when the uri names nothing we have. */
export function readResource(view: LibraryView, uri: string): ResourceContents | undefined {
  if (!uri.startsWith(RESOURCE_SCHEME)) return undefined;
  const parts = uri.slice(RESOURCE_SCHEME.length).split('/');

  if (parts[0] === 'template' && parts.length === 2) {
    const model = view.templates().find((candidate) => candidate.name === parts[1]);
    if (model?.source === undefined) return undefined;
    return { uri, mimeType: 'text/markdown', text: model.source };
  }

  if (parts[0] === 'block' && parts.length === 3) {
    const blocks = view.blocks();
    const type = parts[1]!;
    const instance = parts[2]!;
    // Fall back to the rendered body: a reader that kept no raw source is
    // still better served with what the block actually says.
    const text =
      blocks.sources.get(type)?.get(instance) ?? blocks.bodies.get(type)?.get(instance);
    if (text === undefined) return undefined;
    return { uri, mimeType: 'text/markdown', text };
  }

  return undefined;
}

/**
 * Templates and blocks as readable resources.
 *
 * `struktek_list_templates` answers what a template ASKS FOR; it never shows
 * what a template SAYS. An agent asked to improve one, or to write a new one in
 * the same voice, needs the source - and reconstructing it from the field list
 * would be a guess.
 *
 * Read-only and safe to expose everywhere, so these are registered whether or
 * not the caller can write.
 */
function registerResources(server: McpServer, getLibrary: () => LibraryView): void {
  const listFor = (prefix: string) => () => ({
    resources: resourceEntries(getLibrary()).filter((entry) =>
      entry.uri.startsWith(RESOURCE_SCHEME + prefix),
    ),
  });

  const read = (uri: URL) => {
    const contents = readResource(getLibrary(), uri.href);
    if (!contents) throw new Error('No such struktek resource: ' + uri.href);
    return { contents: [contents] };
  };

  server.registerResource(
    'template',
    new ResourceTemplate(RESOURCE_SCHEME + 'template/{name}', { list: listFor('template/') }),
    {
      title: 'Prompt template source',
      description:
        'The template file as written, frontmatter included. Read this before editing one.',
      mimeType: 'text/markdown',
    },
    read,
  );

  server.registerResource(
    'block',
    new ResourceTemplate(RESOURCE_SCHEME + "block/{type}/{instance}", {
      list: listFor('block/'),
    }),
    {
      title: 'Block value source',
      description:
        "One value of a block type, as written. Its body is what gets substituted; any " +
        "frontmatter only describes it.",
      mimeType: 'text/markdown',
    },
    read,
  );
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
    name: SAVE_TEMPLATE_TOOL,
    title: 'Save a prompt template',
    description:
      'Create or replace a template in the user library. The body is a markdown file in struktek format: {{ field }} placeholders, [ ... ] segments that drop out when empty, and optional --- frontmatter. Refused if the body would not parse cleanly, so read the existing source from struktek://template/<name> before replacing one.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'template name; replaces an existing template of the same name',
        },
        body: { type: 'string', description: 'the whole file, frontmatter included' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: SAVE_BLOCK_TOOL,
    title: 'Save a block value',
    description:
      'Create or replace one value of a block type. A block type is a folder and its values are files, so this adds vocabulary every template with that field can use. The body is substituted wherever that value is picked; optional --- frontmatter describes it and is never rendered.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'block type name; created if it does not exist yet',
        },
        instance: { type: 'string', description: 'the value name within that type' },
        body: { type: 'string', description: 'the whole file, frontmatter included' },
      },
      required: ['type', 'instance', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: LIST_TEMPLATES_TOOL,
    title: 'List prompt templates',
    description:
      "List the user's saved prompt templates with their fields, so you can pick one and " +
      'compose it with struktek_compose. Worth checking before writing a prompt for a subagent — ' +
      'the user has already worked out how they want these prompts phrased.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
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
    // Read-only in the sense the hint is for: it never changes what the library
    // contains. It does append to the usage history, which is bookkeeping the
    // user asked for by calling it - and a client that made you approve every
    // compose would make the tool not worth having.
    annotations: { readOnlyHint: true },
  },
];

/** Dispatch a tool call without an SDK server — used by the offline bridge. */
/**
 * The tools this view can actually run.
 *
 * `TOOL_DEFINITIONS` is every tool that exists; a caller that cannot write
 * must not advertise the ones that write. Offline the bridge reads straight
 * off disk, and a tool listed but unrunnable is worse than one absent.
 */
export function toolDefinitionsFor(view: LibraryView): ToolDefinition[] {
  const writes = new Set([SAVE_TEMPLATE_TOOL, SAVE_BLOCK_TOOL]);
  return TOOL_DEFINITIONS.filter((tool) => view.write || !writes.has(tool.name)).map((tool) =>
    writes.has(tool.name) ? withScopeArgument(tool, view) : tool,
  );
}

/**
 * Add the `scope` parameter, but only where there is a choice to make.
 *
 * A window with one writable library gets the tool exactly as it was. Offering
 * an enum with a single member would invite a model to reason about a decision
 * that has already been made for it, and every token spent on that is a token
 * not spent on the template.
 */
function withScopeArgument(tool: ToolDefinition, view: LibraryView): ToolDefinition {
  const scopes = view.write?.scopes?.() ?? [];
  if (scopes.length < 2) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        scope: {
          type: 'string',
          enum: [...scopes],
          description: SCOPE_ARGUMENT_HELP,
        },
      },
    },
  };
}

/**
 * What a model needs to pick a scope, in the only place it will read it.
 *
 * The asymmetry is the whole message: writing into the workspace affects one
 * project, writing globally affects every one of them, and the default is the
 * cautious side.
 */
export const SCOPE_ARGUMENT_HELP =
  'which library to write to. "workspace" (the default) is this project only. ' +
  '"global" is the user\'s home library, visible from every project they open — ' +
  'use it only when the template is genuinely not about this codebase, or when ' +
  'the user asked for it.';

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
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    { instructions: SERVER_INSTRUCTIONS },
  );

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

  registerResources(server, getLibrary);

  // Registered only when the caller can actually write. Offline the bridge
  // reads straight off disk, and a tool that cannot do what it says is worse
  // than one that is not offered.
  if (getLibrary().write) {
    /**
     * The scope argument, or nothing, matching what the tool listing advertises.
     *
     * Read once at registration because the SDK schema is fixed for the life of
     * the server, and the set of writable libraries only changes when the
     * workspace does — which replaces the server anyway.
     */
    const scopes = getLibrary().write?.scopes?.() ?? [];
    const scopeSchema: Shape =
      scopes.length < 2
        ? {}
        : {
            scope: z
              .enum(scopes as unknown as [string, ...string[]])
              .optional()
              .describe(SCOPE_ARGUMENT_HELP),
          };
    const scopeArg = (args: Record<string, unknown>): string | undefined =>
      typeof args['scope'] === 'string' ? args['scope'] : undefined;

    const saveTemplate = definitionOf(SAVE_TEMPLATE_TOOL);
    registerTool(
      saveTemplate.name,
      {
        title: saveTemplate.title,
        description: saveTemplate.description,
        inputSchema: {
          name: z.string().describe('template name; replaces an existing one of the same name'),
          body: z.string().describe('the whole file, frontmatter included'),
          ...scopeSchema,
        },
      },
      async (args) =>
        json(
          await saveTemplatePayload(
            getLibrary(),
            String(args["name"] ?? ""),
            String(args["body"] ?? ""),
            scopeArg(args),
          ),
        ),
    );

    const saveBlock = definitionOf(SAVE_BLOCK_TOOL);
    registerTool(
      saveBlock.name,
      {
        title: saveBlock.title,
        description: saveBlock.description,
        inputSchema: {
          type: z.string().describe('block type name; created if it does not exist yet'),
          instance: z.string().describe('the value name within that type'),
          body: z.string().describe('the whole file, frontmatter included'),
          ...scopeSchema,
        },
      },
      async (args) =>
        json(
          await saveBlockPayload(
            getLibrary(),
            String(args["type"] ?? ""),
            String(args["instance"] ?? ""),
            String(args["body"] ?? ""),
            scopeArg(args),
          ),
        ),
    );
  }

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
