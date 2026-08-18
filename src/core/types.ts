/**
 * The struktek template vocabulary — shared by every consumer of `core/`.
 *
 * A template is a markdown file whose body carries three constructs and nothing
 * else: `{{ field }}` placeholders, `[ ... ]` optional segments, and literal
 * text. Everything downstream (the QuickPick composer, the MCP server, a future
 * visual editor) is a pure function of the model defined here.
 *
 * This module — and the rest of `core/` — imports NOTHING. No `vscode`, no
 * `node:fs`. The extension host, the standalone MCP bridge, and a browser
 * webview all run the same parser, so filesystem access is always injected.
 */

/** Half-open offset range into the source the span was produced from. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Field types that need no user configuration. */
export type PrimitiveTypeName = 'text' | 'block' | 'number' | 'file';

/**
 * A resolved field type.
 *
 * `choice` yields one of its literal options — a bare word. `blockType` names a
 * user-defined directory under `blocks/`; its value is an *instance* name and it
 * renders as that instance file's entire body. That difference is invisible at
 * the call site by design: `{{ format }}` reads the same either way.
 */
export type FieldType =
  | { readonly kind: 'text' }
  | { readonly kind: 'block' }
  | { readonly kind: 'number' }
  | { readonly kind: 'file' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | { readonly kind: 'blockType'; readonly name: string };

export const PRIMITIVE_TYPES: ReadonlySet<string> = new Set<PrimitiveTypeName>([
  'text',
  'block',
  'number',
  'file',
]);

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticCode =
  | 'unterminated-placeholder'
  | 'empty-placeholder-name'
  | 'conflicting-type'
  | 'unknown-type'
  | 'unknown-instance'
  | 'unmatched-bracket'
  | 'empty-choice';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly span: Span;
  readonly severity: DiagnosticSeverity;
}

/**
 * One `{{ ... }}` occurrence exactly as written.
 *
 * Deliberately unresolved: the lexer records what the author typed, and
 * `analyze()` reconciles repeated occurrences, applies frontmatter overrides,
 * and decides what the type actually is. Keeping the two apart is what lets a
 * field be annotated once and referenced bare everywhere else.
 */
export interface PlaceholderDecl {
  readonly name: string;
  readonly typeName?: string;
  /** Members of `choice[a, b, c]`, in source order. */
  readonly typeArgs?: readonly string[];
  readonly description?: string;
  /** The `= value` pin: pre-filled, still overridable. */
  readonly pin?: string;
  readonly span: Span;
  readonly nameSpan: Span;
}

/** A parsed body. `optional` nodes nest. */
export type Node =
  | { readonly kind: 'text'; readonly value: string; readonly span: Span }
  | { readonly kind: 'placeholder'; readonly decl: PlaceholderDecl; readonly span: Span }
  | { readonly kind: 'optional'; readonly children: readonly Node[]; readonly span: Span };

/** A reconciled field: one entry per distinct name, however many times it occurs. */
export interface Field {
  readonly name: string;
  readonly type: FieldType;
  readonly description?: string;
  readonly pin?: string;
  /**
   * False when every occurrence sits inside an optional segment. Maps straight
   * onto the MCP prompt-argument `required` flag.
   */
  readonly required: boolean;
  /** The occurrence that carried the type annotation, else the first one. */
  readonly span: Span;
}

/** Frontmatter overrides. Optional — a template needs none of this. */
export interface FrontmatterArg {
  readonly type?: string;
  readonly description?: string;
  readonly default?: string;
}

export interface Frontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly args?: Readonly<Record<string, FrontmatterArg | string>>;
}

/** The analysed template — what the composer, the MCP server, and the UI consume. */
export interface TemplateModel {
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly Field[];
  readonly nodes: readonly Node[];
  readonly diagnostics: readonly Diagnostic[];
}
