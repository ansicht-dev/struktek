/**
 * Template files, as the editor sees them.
 *
 * The parser already produced everything an editor needs and nothing was using
 * it: `analyze()` returns diagnostics carrying real offsets into the file, and
 * until now the only place they surfaced was a hover in the sidebar. A squiggle
 * on the wrong character is the whole point of keeping those spans.
 *
 * Everything here runs against the document's CURRENT text rather than the
 * library's last scan, so a mistake is reported as it is typed rather than 250
 * milliseconds after it is saved. Block type names still come from the library,
 * since those live in other files.
 *
 * Scoped by path rather than by a file extension: templates stay ordinary
 * Markdown, so the providers ask whether a document sits under the configured
 * library before saying anything about it. That also means a custom
 * `struktek.libraryPath` gets the same treatment as the default.
 */

import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, PRIMITIVE_TYPES, type Node, type TemplateModel } from '../core';
import { completionContext } from '../shared/completion';
import { TEMPLATES_DIR, type Library } from './library';

/**
 * Token types we emit, in legend order.
 *
 * Standard types, so every theme already colours them — a custom type would
 * need a theme to opt in, which no theme will.
 */
const TOKEN_TYPES = ['operator', 'variable', 'type'] as const;
const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES]);

/** Selector is broad; `templateOf` is what actually decides. */
const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'markdown' },
  { scheme: 'file', language: 'plaintext' },
];

export function registerTemplateEditor(getLibrary: () => Library | undefined): vscode.Disposable {
  const diagnostics = vscode.languages.createDiagnosticCollection('struktek');

  /** Parse the buffer, or return undefined when this is not a template. */
  const templateOf = (document: vscode.TextDocument): TemplateModel | undefined => {
    const library = getLibrary();
    if (!library) return undefined;
    const templates = vscode.Uri.joinPath(library.root, TEMPLATES_DIR).path;
    if (!document.uri.path.startsWith(templates + '/')) return undefined;
    try {
      return loadTemplate(document.getText(), {
        name: stem(document.uri.path),
        parseYaml,
        blockTypes: library.blocks.names,
      });
    } catch {
      // A YAML header mid-edit is routinely unparseable; that is not worth a
      // diagnostic of its own, and the next keystroke usually fixes it.
      return undefined;
    }
  };

  const publish = (document: vscode.TextDocument): void => {
    const model = templateOf(document);
    if (!model) {
      diagnostics.delete(document.uri);
      return;
    }
    diagnostics.set(
      document.uri,
      model.diagnostics.map((diagnostic) => {
        const entry = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(diagnostic.span.start),
            document.positionAt(diagnostic.span.end),
          ),
          diagnostic.message,
          diagnostic.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning,
        );
        entry.source = 'struktek';
        entry.code = diagnostic.code;
        return entry;
      }),
    );
  };

  const refreshAll = (): void => {
    for (const document of vscode.workspace.textDocuments) publish(document);
  };
  refreshAll();

  const subscriptions: vscode.Disposable[] = [
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(publish),
    vscode.workspace.onDidChangeTextDocument((event) => publish(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),

    vscode.languages.registerDocumentSemanticTokensProvider(
      SELECTOR,
      {
        provideDocumentSemanticTokens: (document) => {
          const model = templateOf(document);
          if (!model) return undefined;
          return buildTokens(document, model.nodes);
        },
      },
      LEGEND,
    ),

    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems: (document, position) => {
          const model = templateOf(document);
          const library = getLibrary();
          if (!model || !library) return undefined;
          return complete(model, library, document.getText(new vscode.Range(lineStart(position), position)));
        },
      },
      ':',
      '=',
      ' ',
    ),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover: (document, position) => {
        const model = templateOf(document);
        if (!model) return undefined;
        const offset = document.offsetAt(position);
        const field = model.fields.find(
          (candidate) => offset >= candidate.span.start && offset <= candidate.span.end,
        );
        if (!field) return undefined;
        const lines = ['**' + field.name + '** — `' + describe(field.type) + '`'];
        if (field.description) lines.push('', field.description);
        if (field.pin !== undefined) lines.push('', 'Defaults to `' + field.pin + '`.');
        if (!field.required) lines.push('', '_Optional — every use sits inside a `[ ]` segment._');
        return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')));
      },
    }),
  ];

  return vscode.Disposable.from(...subscriptions, { dispose: refreshAll });
}

/**
 * Colour the parts of a placeholder differently.
 *
 * The lexer records the whole placeholder and, separately, its name, so the
 * annotation is whatever sits between the name and the closing braces. Four
 * tokens is enough to read one at a glance without the parser having to hand
 * out a span per component: both pairs of braces are punctuation, the name is
 * the field, and the middle is the annotation.
 *
 * The closer is only split off when it is actually there — an unterminated
 * placeholder ends wherever the lexer gave up, and trimming two characters off
 * that would miscolour the last two characters of the annotation.
 */
function buildTokens(
  document: vscode.TextDocument,
  nodes: readonly Node[],
): vscode.SemanticTokens {
  const text = document.getText();
  const spans: { start: number; end: number; type: number }[] = [];

  const walk = (list: readonly Node[]): void => {
    for (const node of list) {
      if (node.kind === 'placeholder') {
        const { span, nameSpan } = node.decl;
        const closed = text.slice(span.end - 2, span.end) === '}}';
        const annotationEnd = closed ? span.end - 2 : span.end;
        spans.push({ start: span.start, end: nameSpan.start, type: 0 });
        spans.push({ start: nameSpan.start, end: nameSpan.end, type: 1 });
        spans.push({ start: nameSpan.end, end: annotationEnd, type: 2 });
        if (closed) spans.push({ start: annotationEnd, end: span.end, type: 0 });
      } else if (node.kind === 'optional') {
        // Just the brackets: the segment's contents are tokens in their own
        // right, and semantic tokens may not overlap.
        spans.push({ start: node.span.start, end: node.span.start + 1, type: 0 });
        spans.push({ start: node.span.end - 1, end: node.span.end, type: 0 });
        walk(node.children);
      }
    }
  };
  walk(nodes);

  const builder = new vscode.SemanticTokensBuilder(LEGEND);
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.end <= span.start) continue;
    const start = document.positionAt(span.start);
    const end = document.positionAt(span.end);
    // A token cannot straddle a line; a description long enough to wrap is
    // simply left uncoloured rather than reported wrong.
    if (start.line !== end.line) continue;
    builder.push(start.line, start.character, end.character - start.character, span.type);
  }
  return builder.build();
}

function complete(
  model: TemplateModel,
  library: Library,
  textBeforeCursor: string,
): vscode.CompletionItem[] | undefined {
  const context = completionContext(textBeforeCursor);
  if (context.kind === 'none') return undefined;

  if (context.kind === 'type') {
    const items = [...PRIMITIVE_TYPES].map((name) =>
      item(name, vscode.CompletionItemKind.Keyword, 'built-in'),
    );
    items.push(choiceItem());
    for (const [type, instances] of library.blocks.names) {
      items.push(item(type, vscode.CompletionItemKind.Enum, plural(instances.length, 'value')));
    }
    return items;
  }

  // A default. What is legal depends on the field's type, which may have been
  // annotated on a different occurrence than the one being edited.
  const type =
    context.typeName ?? typeNameOf(model, context.field);
  if (!type) return undefined;

  const instances = library.blocks.names.get(type);
  if (instances) {
    return instances.map((instance) =>
      item(instance, vscode.CompletionItemKind.EnumMember, type),
    );
  }

  const field = model.fields.find((candidate) => candidate.name === context.field);
  if (field?.type.kind === 'choice') {
    return field.type.options.map((option) =>
      item(option, vscode.CompletionItemKind.EnumMember, 'choice'),
    );
  }
  return undefined;
}

function typeNameOf(model: TemplateModel, field: string | undefined): string | undefined {
  const found = model.fields.find((candidate) => candidate.name === field);
  if (!found) return undefined;
  return found.type.kind === 'blockType' ? found.type.name : found.type.kind;
}

function item(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
  const entry = new vscode.CompletionItem(label, kind);
  entry.detail = detail;
  return entry;
}

/** `choice` is the one type that is useless without its options. */
function choiceItem(): vscode.CompletionItem {
  const entry = new vscode.CompletionItem('choice', vscode.CompletionItemKind.Keyword);
  entry.detail = 'built-in';
  entry.insertText = new vscode.SnippetString('choice[${1:first}, ${2:second}]');
  return entry;
}

function describe(type: TemplateModel['fields'][number]['type']): string {
  if (type.kind === 'choice') return 'choice[' + type.options.join(', ') + ']';
  if (type.kind === 'blockType') return type.name;
  return type.kind;
}

function plural(count: number, noun: string): string {
  return String(count) + ' ' + noun + (count === 1 ? '' : 's');
}

function lineStart(position: vscode.Position): vscode.Position {
  return new vscode.Position(position.line, 0);
}

function stem(path: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}
