/**
 * Template body lexer — source text to a flat token stream.
 *
 * The load-bearing rule lives here: `{{ ... }}` is scanned to completion BEFORE
 * anything looks at `[` / `]`. Without that ordering the bracket in
 * `{{ focus: choice[a, b] }}` reads as an optional-segment bracket and the
 * grammar tears itself apart. Placeholders come out of this pass as opaque
 * tokens; the structural pass in `parse.ts` only ever asks whether one is empty.
 *
 * Scanning inside `{{ }}` is string-aware for the same class of reason: a
 * description is free text, and a template *about* templating will contain
 * `}}`. Quoted regions are skipped whole, with `\"` escaping a quote.
 */

import type { Diagnostic, PlaceholderDecl, Span } from './types';

export type Token =
  | { readonly kind: 'text'; readonly value: string; readonly span: Span }
  | { readonly kind: 'placeholder'; readonly decl: PlaceholderDecl; readonly span: Span }
  | { readonly kind: 'lbracket'; readonly span: Span }
  | { readonly kind: 'rbracket'; readonly span: Span };

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Characters a backslash may escape into a literal.
 *
 * Literal `[` in prose is far more common than literal `{{`, which is why an
 * unmatched bracket degrades to text rather than erroring — escaping is for
 * the case where a bracket pair really would have been read as a segment.
 */
const ESCAPABLE: ReadonlySet<string> = new Set(['{', '}', '[', ']', '\\']);

const NAME_CHAR = /[A-Za-z0-9_.\-/]/;

export function lex(source: string, baseOffset = 0): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];

  const at = (i: number): string => source[i] ?? '';
  const span = (start: number, end: number): Span => ({
    start: start + baseOffset,
    end: end + baseOffset,
  });

  // Text is accumulated rather than sliced, because escapes mean the emitted
  // value and the source range are different lengths.
  let text = '';
  let textStart = 0;
  const pushText = (end: number): void => {
    if (text.length === 0) return;
    tokens.push({ kind: 'text', value: text, span: span(textStart, end) });
    text = '';
  };
  const addText = (ch: string, at_: number): void => {
    if (text.length === 0) textStart = at_;
    text += ch;
  };

  let i = 0;
  while (i < source.length) {
    const ch = at(i);

    if (ch === '\\' && ESCAPABLE.has(at(i + 1))) {
      addText(at(i + 1), i);
      i += 2;
      continue;
    }

    if (ch === '{' && at(i + 1) === '{') {
      const close = findPlaceholderEnd(source, i);
      if (close === -1) {
        // Unterminated: report it, then treat the rest as ordinary prose so the
        // author still sees a usable preview instead of a blank panel.
        diagnostics.push({
          code: 'unterminated-placeholder',
          message: 'Unterminated `{{` — expected a matching `}}`.',
          span: span(i, source.length),
          severity: 'error',
        });
        addText(ch, i);
        i += 1;
        continue;
      }
      pushText(i);
      const inner = source.slice(i + 2, close);
      const whole = span(i, close + 2);
      const decl = parseDecl(inner, i + 2, whole, baseOffset, diagnostics);
      tokens.push({ kind: 'placeholder', decl, span: whole });
      i = close + 2;
      continue;
    }

    if (ch === '[' || ch === ']') {
      pushText(i);
      tokens.push({ kind: ch === '[' ? 'lbracket' : 'rbracket', span: span(i, i + 1) });
      i += 1;
      continue;
    }

    addText(ch, i);
    i += 1;
  }
  pushText(source.length);

  return { tokens, diagnostics };
}

/**
 * Index of the `}}` closing the placeholder opened at `open`, or -1.
 *
 * Quoted regions are skipped whole — this is what lets a description contain
 * `}}` without terminating the token early.
 */
function findPlaceholderEnd(source: string, open: number): number {
  let i = open + 2;
  let inString = false;
  while (i < source.length) {
    const c = source[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (c === '}' && source[i + 1] === '}') return i;
    i += 1;
  }
  return -1;
}

/**
 * Parse the inside of a placeholder: `name [: type[opts]] [= pin] ["description"]`.
 *
 * `= pin` and `"description"` are accepted in either order after the type,
 * because insisting on one is a rule authors would have to remember for no gain.
 */
function parseDecl(
  inner: string,
  innerOffset: number,
  whole: Span,
  baseOffset: number,
  diagnostics: Diagnostic[],
): PlaceholderDecl {
  let i = 0;
  const at = (k: number): string => inner[k] ?? '';
  const skipWs = (): void => {
    while (i < inner.length && /\s/.test(at(i))) i += 1;
  };
  const readName = (): string => {
    const start = i;
    while (i < inner.length && NAME_CHAR.test(at(i))) i += 1;
    return inner.slice(start, i);
  };
  const readQuoted = (): string => {
    i += 1; // opening quote
    let out = '';
    while (i < inner.length && at(i) !== '"') {
      if (at(i) === '\\' && i + 1 < inner.length) {
        out += at(i + 1);
        i += 2;
        continue;
      }
      out += at(i);
      i += 1;
    }
    i += 1; // closing quote
    return out;
  };

  skipWs();
  const nameStart = i;
  const name = readName();
  const nameSpan: Span = {
    start: innerOffset + nameStart + baseOffset,
    end: innerOffset + i + baseOffset,
  };

  if (name.length === 0) {
    diagnostics.push({
      code: 'empty-placeholder-name',
      message: 'Placeholder has no field name.',
      span: whole,
      severity: 'error',
    });
  }

  let typeName: string | undefined;
  let typeArgs: string[] | undefined;
  let description: string | undefined;
  let pin: string | undefined;

  skipWs();
  if (at(i) === ':') {
    i += 1;
    skipWs();
    typeName = readName();
    skipWs();
    if (at(i) === '[') {
      const argsStart = i;
      i += 1;
      const start = i;
      while (i < inner.length && at(i) !== ']') i += 1;
      const raw = inner.slice(start, i);
      i += 1; // closing bracket
      typeArgs = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (typeArgs.length === 0) {
        diagnostics.push({
          code: 'empty-choice',
          message: `\`${typeName}[...]\` lists no options.`,
          span: {
            start: innerOffset + argsStart + baseOffset,
            end: innerOffset + i + baseOffset,
          },
          severity: 'error',
        });
      }
    }
  }

  // `= pin` and `"description"` in either order, at most once each.
  for (;;) {
    skipWs();
    const c = at(i);
    if (c === '=' && pin === undefined) {
      i += 1;
      skipWs();
      pin = at(i) === '"' ? readQuoted() : readName();
      continue;
    }
    if (c === '"' && description === undefined) {
      description = readQuoted();
      continue;
    }
    break;
  }

  return {
    name,
    ...(typeName ? { typeName } : {}),
    ...(typeArgs ? { typeArgs } : {}),
    ...(description ? { description } : {}),
    ...(pin ? { pin } : {}),
    span: whole,
    nameSpan,
  };
}
