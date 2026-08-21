/**
 * The composer — pick a template, fill its fields, hand the result to an agent.
 *
 * A QuickPick chain rather than a panel, deliberately. This is the thing used
 * twenty times a day, so it has to be reachable from the keyboard and finish in
 * a few keystrokes; a webview form would look better and be slower to drive.
 * The live-preview playground is worth building once real use has shown which
 * fields actually need one.
 *
 * Every step sets `ignoreFocusOut` so a stray click does not discard a
 * half-filled prompt.
 */

import * as vscode from 'vscode';
import { render, type Field, type TemplateModel } from '../core';
import type { Library, TemplateEntry } from './library';
import { log } from './log';
import { seedLibrary } from './seed';
import type { Stats } from './stats';
import { blockRefs, type History } from './history';

/** Distinguishes "the user pressed Escape" from "this optional field is blank". */
const CANCELLED = Symbol('cancelled');
type Answer = string | undefined | typeof CANCELLED;

/**
 * @param preselected Skip the picker and compose this template directly — how
 * the tree view's rows invoke the command. An unknown name falls back to the
 * picker rather than failing, since the library may have changed underneath.
 */
export async function composeCommand(
  library: Library,
  stats: Stats,
  history: History,
  preselected?: string,
): Promise<void> {
  const entry = (preselected ? library.get(preselected) : undefined) ?? (await pickTemplate(library, stats));
  if (!entry) return;

  const values = await collectValues(entry.model, library, stats);
  if (!values) return;

  const result = render(entry.model.nodes, {
    values,
    fields: entry.model.fields,
    blocks: library.blocks.bodies,
  });

  stats.record(entry.model.name, values);
  const blocks = blockRefs(entry.model.fields, values);
  await deliver(result.text, entry.model, result.unfilled, (via) => {
    history.record(entry.model.name, values, result.text, via, blocks);
  });
}

async function pickTemplate(library: Library, stats: Stats): Promise<TemplateEntry | undefined> {
  if (library.list().length === 0) {
    // Seeding is offered rather than done on activation: writing files into
    // someone's repo uninvited is not a first impression worth making.
    const seed = 'Create Starter Templates';
    const blank = 'New Blank Template';
    const choice = await vscode.window.showInformationMessage(
      'No templates yet. Struktek looks in ' + vscode.workspace.asRelativePath(library.root) + '/templates.',
      seed,
      blank,
    );
    if (choice === seed) {
      await seedLibrary(library.root);
      await library.reload();
    } else if (choice === blank) {
      await vscode.commands.executeCommand('struktek.newTemplate');
      return undefined;
    } else {
      return undefined;
    }
  }
  const entries = library.list();
  if (entries.length === 0) return undefined;

  // Most-used first: the picker should reflect what you actually reach for.
  const ordered = stats.order(entries.map((e) => e.model.name));
  const items = ordered.map((name) => {
    const entry = library.get(name)!;
    const errors = entry.model.diagnostics.filter((d) => d.severity === 'error').length;
    return {
      label: name,
      // No use count: the ordering above already IS the use count, and
      // printing it as well says the same thing twice.
      description: [
        // Only global is marked. The workspace library is the unremarkable
        // case, and a badge on every row would say nothing.
        entry.scope === 'global' ? '$(globe) global' : undefined,
        errors > 0 ? '$(error) ' + String(errors) : undefined,
      ]
        .filter(Boolean)
        .join('  '),
      detail: entry.model.description,
      entry,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Struktek — Compose Prompt',
    placeHolder: 'Pick a template',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked?.entry;
}

/** Walk the fields in order. Returns undefined if the user cancelled. */
async function collectValues(
  model: TemplateModel,
  library: Library,
  stats: Stats,
): Promise<Record<string, string | undefined> | undefined> {
  const values: Record<string, string | undefined> = {};
  const total = model.fields.length;

  for (let index = 0; index < total; index++) {
    const field = model.fields[index]!;
    const title =
      'Struktek — ' + model.name + '  (' + String(index + 1) + '/' + String(total) + ')';
    const answer = await promptField(field, title, model.name, library, stats);
    if (answer === CANCELLED) return undefined;
    values[field.name] = answer;
  }
  return values;
}

async function promptField(
  field: Field,
  title: string,
  template: string,
  library: Library,
  stats: Stats,
): Promise<Answer> {
  // Last-used beats the template's pin: the pin is the author's starting point,
  // the sticky value is what this user actually keeps choosing.
  const preset = stats.sticky(template, field.name) ?? field.pin;

  switch (field.type.kind) {
    case 'choice':
      return pickOne(field, title, [...field.type.options], preset);

    case 'blockType': {
      const instances = library.blocks.names.get(field.type.name) ?? [];
      if (instances.length === 0) {
        void vscode.window.showWarningMessage(
          'Block type "' + field.type.name + '" has no instances yet — add a file to blocks/' +
            field.type.name + '/.',
        );
        return undefined;
      }
      const bodies = library.blocks.bodies.get(field.type.name);
      return pickOne(field, title, [...instances], preset, (instance) =>
        firstLine(bodies?.get(instance) ?? ''),
      );
    }

    case 'file':
      return pickFile(field, title, preset);

    case 'number':
      return askText(field, title, preset, (value) =>
        value.length === 0 || /^-?\d+(\.\d+)?$/.test(value.trim())
          ? undefined
          : 'Enter a number.',
      );

    case 'block':
    case 'text':
    default:
      return askText(field, title, preset);
  }
}

async function pickOne(
  field: Field,
  title: string,
  options: readonly string[],
  preset: string | undefined,
  describe?: (option: string) => string,
): Promise<Answer> {
  interface Item extends vscode.QuickPickItem {
    readonly value: string | undefined;
  }
  const items: Item[] = options.map((option) => ({
    label: option,
    description: option === preset ? '$(check) last used' : undefined,
    detail: describe?.(option),
    value: option,
  }));
  // Sorting the preset to the top means the common case is Enter, not arrow keys.
  if (preset) items.sort((a, b) => Number(b.value === preset) - Number(a.value === preset));
  if (!field.required) items.push({ label: '$(circle-slash) Skip', value: undefined });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: promptFor(field),
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked === undefined ? CANCELLED : picked.value;
}

async function askText(
  field: Field,
  title: string,
  preset: string | undefined,
  validate?: (value: string) => string | undefined,
): Promise<Answer> {
  const value = await vscode.window.showInputBox({
    title,
    prompt: promptFor(field),
    value: preset ?? '',
    placeHolder: field.required ? undefined : 'optional — leave blank to omit',
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (field.required && input.trim().length === 0) return 'This field is required.';
      return validate?.(input);
    },
  });
  if (value === undefined) return CANCELLED;
  return value.trim().length === 0 ? undefined : value;
}

/**
 * A file field offers the workspace, with the active editor's file first.
 *
 * Nine times out of ten the file you mean is the one you are looking at, so it
 * should cost no keystrokes.
 */
async function pickFile(field: Field, title: string, preset: string | undefined): Promise<Answer> {
  interface Item extends vscode.QuickPickItem {
    readonly value: string | undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const found = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist}/**', 2000);

  const paths = found.map((uri) => vscode.workspace.asRelativePath(uri));
  const activePath = active ? vscode.workspace.asRelativePath(active) : undefined;
  const ordered = [
    ...(activePath ? [activePath] : []),
    ...(preset && preset !== activePath ? [preset] : []),
    ...paths.filter((p) => p !== activePath && p !== preset),
  ];

  const items: Item[] = ordered.map((path) => ({
    label: path,
    description:
      path === activePath ? '$(file) active editor' : path === preset ? '$(check) last used' : undefined,
    value: path,
  }));
  if (!field.required) items.push({ label: '$(circle-slash) Skip', value: undefined });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: promptFor(field),
    ignoreFocusOut: true,
  });
  return picked === undefined ? CANCELLED : picked.value;
}

function promptFor(field: Field): string {
  const suffix = field.required ? '' : '  (optional)';
  return (field.description ?? field.name) + suffix;
}

function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}

/** Final step: where should the composed prompt go? */
async function deliver(
  text: string,
  model: TemplateModel,
  unfilled: readonly string[],
  /** Called with where it went, once the user has actually chosen. */
  onDelivered: (via: string) => void,
): Promise<void> {
  interface Action extends vscode.QuickPickItem {
    readonly via: string;
    readonly run: () => Promise<void>;
  }

  const actions: Action[] = [
    {
      label: '$(comment-discussion) Send to Chat',
      description: 'prefill the chat box without submitting',
      via: 'chat',
      run: () => sendToChat(text),
    },
    {
      label: '$(clippy) Copy to Clipboard',
      via: 'clipboard',
      run: async () => {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage('Struktek: prompt copied.');
      },
    },
    {
      label: '$(edit) Insert at Cursor',
      via: 'insert',
      run: async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage('Struktek: no active editor to insert into.');
          return;
        }
        await editor.edit((builder) => builder.replace(editor.selection, text));
      },
    },
    {
      label: '$(go-to-file) Open in Editor',
      description: 'review or tweak before sending',
      via: 'editor',
      run: async () => {
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    },
  ];

  const picked = await vscode.window.showQuickPick(actions, {
    title: 'Struktek — ' + model.name,
    placeHolder:
      unfilled.length > 0
        ? String(unfilled.length) + ' field(s) left blank — ' + preview(text)
        : preview(text),
    ignoreFocusOut: true,
  });
  if (!picked) return;
  // Recorded only once a destination is chosen: a prompt you abandoned at the
  // delivery step is not one you generated.
  onDelivered(picked.via);
  await picked.run();
}

/**
 * Push the prompt into the chat input WITHOUT submitting it.
 *
 * `isPartialQuery` is the whole point: struktek composes a prompt for you to
 * look at, not one to fire blind. If the command is unavailable — an older VS
 * Code, or no chat extension installed — fall back to the clipboard rather than
 * losing the prompt.
 */
async function sendToChat(text: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: text,
      isPartialQuery: true,
    });
  } catch (err) {
    log.warn('Chat open failed — falling back to the clipboard', { error: String(err) });
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(
      'Struktek: no chat view available — prompt copied to the clipboard instead.',
    );
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? flat.slice(0, 97) + '...' : flat;
}
