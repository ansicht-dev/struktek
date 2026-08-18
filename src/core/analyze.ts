/**
 * Reconcile a parsed body into the field list every consumer works from.
 *
 * One `Field` per distinct name, however many times it occurs. That is what
 * makes "type once, reference bare everywhere else" work: the author annotates
 * the occurrence where it reads best, and the rest are plain `{{ name }}`.
 *
 * Two annotations disagreeing is an ERROR, not last-wins. Silently picking one
 * would mean the composer prompts for a type the template body does not
 * actually use, and the author would have no way to see why.
 *
 * The output feeds three places at once: the QuickPick composer's form, the MCP
 * prompt `arguments[]` array, and the editor's diagnostics. One definition of
 * what a template asks for, so they cannot drift.
 */

import type { ParseResult } from './parse';
import {
  PRIMITIVE_TYPES,
  type Diagnostic,
  type Field,
  type FieldType,
  type Frontmatter,
  type FrontmatterArg,
  type Node,
  type PlaceholderDecl,
  type Span,
  type TemplateModel,
} from './types';

export interface AnalyzeOptions {
  /** Falls back to the filename stem when frontmatter omits `name`. */
  readonly name: string;
  readonly frontmatter?: Frontmatter;
  /**
   * Block type name to its instance names. Supply it to get unknown-type and
   * unknown-pin checking; omit it when only the shape matters (e.g. a fast
   * pass while typing, before the library has been scanned).
   */
  readonly blockTypes?: ReadonlyMap<string, readonly string[]>;
}

interface Accumulator {
  readonly name: string;
  first: Span;
  typeDecl?: { readonly decl: PlaceholderDecl; readonly span: Span };
  description?: string;
  pin?: string;
  required: boolean;
}

export function analyze(parsed: ParseResult, opts: AnalyzeOptions): TemplateModel {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const acc = new Map<string, Accumulator>();

  walk(parsed.nodes, 0, (decl, depth) => {
    if (decl.name.length === 0) return; // already reported by the lexer
    const existing = acc.get(decl.name);
    if (!existing) {
      acc.set(decl.name, {
        name: decl.name,
        first: decl.span,
        ...(decl.typeName ? { typeDecl: { decl, span: decl.span } } : {}),
        ...(decl.description ? { description: decl.description } : {}),
        ...(decl.pin ? { pin: decl.pin } : {}),
        // Outside any optional segment the field must be filled for the prompt
        // to make sense; inside one, leaving it blank is a supported outcome.
        required: depth === 0,
      });
      return;
    }
    if (depth === 0) existing.required = true;
    if (decl.description && existing.description === undefined) existing.description = decl.description;
    if (decl.pin && existing.pin === undefined) existing.pin = decl.pin;
    if (!decl.typeName) return;
    if (!existing.typeDecl) {
      existing.typeDecl = { decl, span: decl.span };
      return;
    }
    if (!sameType(existing.typeDecl.decl, decl)) {
      diagnostics.push({
        code: 'conflicting-type',
        message:
          'Field "' + decl.name + '" is annotated as "' + describeType(existing.typeDecl.decl) +
          '" here and "' + describeType(decl) + '" there — annotate it once.',
        span: decl.span,
        severity: 'error',
      });
    }
  });

  const fields: Field[] = [];
  for (const entry of acc.values()) {
    const override = frontmatterArg(opts.frontmatter, entry.name);
    const type = resolveType(entry, override, opts, diagnostics);
    const description = override?.description ?? entry.description;
    const pin = override?.default ?? entry.pin;
    if (pin !== undefined) validatePin(entry.name, pin, type, entry.first, opts, diagnostics);
    fields.push({
      name: entry.name,
      type,
      ...(description ? { description } : {}),
      ...(pin !== undefined ? { pin } : {}),
      required: entry.required,
      span: entry.typeDecl?.span ?? entry.first,
    });
  }

  const name = opts.frontmatter?.name ?? opts.name;
  const description = opts.frontmatter?.description;
  return {
    name,
    ...(description ? { description } : {}),
    tags: opts.frontmatter?.tags ?? [],
    fields,
    nodes: parsed.nodes,
    diagnostics,
  };
}

/** Depth counts enclosing optional segments; 0 means the field is unconditional. */
function walk(
  nodes: readonly Node[],
  depth: number,
  visit: (decl: PlaceholderDecl, depth: number) => void,
): void {
  for (const node of nodes) {
    if (node.kind === 'placeholder') visit(node.decl, depth);
    else if (node.kind === 'optional') walk(node.children, depth + 1, visit);
  }
}

function sameType(a: PlaceholderDecl, b: PlaceholderDecl): boolean {
  if (a.typeName !== b.typeName) return false;
  const x = a.typeArgs ?? [];
  const y = b.typeArgs ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function describeType(decl: PlaceholderDecl): string {
  const args = decl.typeArgs;
  return args && args.length > 0
    ? (decl.typeName ?? 'text') + '[' + args.join(', ') + ']'
    : (decl.typeName ?? 'text');
}

function frontmatterArg(fm: Frontmatter | undefined, name: string): FrontmatterArg | undefined {
  const raw = fm?.args?.[name];
  if (raw === undefined) return undefined;
  // `args: { focus: choice[a, b] }` is shorthand for `{ type: "choice[a, b]" }`.
  return typeof raw === 'string' ? { type: raw } : raw;
}

function resolveType(
  entry: Accumulator,
  override: FrontmatterArg | undefined,
  opts: AnalyzeOptions,
  diagnostics: Diagnostic[],
): FieldType {
  const parsed = override?.type
    ? splitTypeExpr(override.type)
    : { typeName: entry.typeDecl?.decl.typeName, typeArgs: entry.typeDecl?.decl.typeArgs };
  const typeName = parsed.typeName;
  const typeArgs = parsed.typeArgs;

  if (!typeName) return { kind: 'text' };

  if (typeName === 'choice') {
    const options = typeArgs ?? [];
    return options.length > 0 ? { kind: 'choice', options } : { kind: 'text' };
  }

  if (PRIMITIVE_TYPES.has(typeName)) {
    return { kind: typeName as 'text' | 'block' | 'number' | 'file' };
  }

  // Anything else names a directory under `blocks/`. Only report it as unknown
  // when the library has actually been scanned — an unscanned library must not
  // paint every block field red.
  if (opts.blockTypes && !opts.blockTypes.has(typeName)) {
    diagnostics.push({
      code: 'unknown-type',
      message:
        'Unknown type "' + typeName + '" for field "' + entry.name + '". ' +
        'Create blocks/' + typeName + '/ and put an instance in it, or use a built-in type.',
      span: entry.typeDecl?.span ?? entry.first,
      severity: 'error',
    });
    return { kind: 'text' };
  }
  return { kind: 'blockType', name: typeName };
}

/** Parse a frontmatter type string such as `choice[a, b]` into name + args. */
function splitTypeExpr(expr: string): { typeName?: string; typeArgs?: string[] } {
  const match = /^\s*([A-Za-z0-9_.\-/]+)\s*(?:\[(.*)\])?\s*$/.exec(expr);
  if (!match) return {};
  const typeName = match[1]!;
  const rawArgs = match[2];
  if (rawArgs === undefined) return { typeName };
  return {
    typeName,
    typeArgs: rawArgs
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

function validatePin(
  field: string,
  pin: string,
  type: FieldType,
  span: Span,
  opts: AnalyzeOptions,
  diagnostics: Diagnostic[],
): void {
  if (type.kind === 'choice' && !type.options.includes(pin)) {
    diagnostics.push({
      code: 'unknown-instance',
      message: 'Default "' + pin + '" for "' + field + '" is not one of: ' + type.options.join(', ') + '.',
      span,
      severity: 'error',
    });
    return;
  }
  if (type.kind === 'blockType' && opts.blockTypes) {
    const instances = opts.blockTypes.get(type.name) ?? [];
    if (!instances.includes(pin)) {
      diagnostics.push({
        code: 'unknown-instance',
        message:
          'Default "' + pin + '" for "' + field + '" is not an instance of "' + type.name + '". ' +
          'Available: ' + (instances.length > 0 ? instances.join(', ') : '(none yet)') + '.',
        span,
        severity: 'error',
      });
    }
  }
}
