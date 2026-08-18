/**
 * Structural pass — tokens to a CST.
 *
 * Two rules do the real work:
 *
 *   1. A `[ ... ]` group containing no placeholder is NOT an optional segment.
 *      It is prose. `[see notes]` in a prompt is overwhelmingly more likely to
 *      be a citation than a segment the author wants collapsed, and requiring
 *      an escape for the common case would be a bad trade.
 *   2. An unmatched bracket degrades to literal text rather than failing the
 *      parse. Half a template is worth more than a diagnostic.
 *
 * The tree keeps spans and the original text so a future visual editor can
 * round-trip a file — edit one field, splice that range, leave every byte of
 * formatting the author chose exactly where it was.
 */

import { lex, type Token } from './lex';
import type { Diagnostic, Node, Span } from './types';

export interface ParseResult {
  readonly nodes: readonly Node[];
  readonly diagnostics: readonly Diagnostic[];
}

export function parse(source: string, baseOffset = 0): ParseResult {
  const { tokens, diagnostics: lexDiagnostics } = lex(source, baseOffset);
  const diagnostics: Diagnostic[] = [...lexDiagnostics];

  interface Frame {
    readonly children: Node[];
    /** Span of the `[` that opened this frame; undefined for the root. */
    readonly open?: Span;
  }
  const stack: Frame[] = [{ children: [] }];
  const top = (): Frame => stack[stack.length - 1]!;

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        top().children.push({ kind: 'text', value: token.value, span: token.span });
        break;

      case 'placeholder':
        top().children.push({ kind: 'placeholder', decl: token.decl, span: token.span });
        break;

      case 'lbracket':
        stack.push({ children: [], open: token.span });
        break;

      case 'rbracket': {
        if (stack.length === 1) {
          // Nothing open — a stray `]` is just a character.
          top().children.push({ kind: 'text', value: ']', span: token.span });
          break;
        }
        const frame = stack.pop()!;
        const span: Span = { start: frame.open!.start, end: token.span.end };
        top().children.push(...closeGroup(frame.children, span));
        break;
      }
    }
  }

  // Unclosed `[` at EOF: give back the literal bracket and splice the contents
  // into the parent, innermost first.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    diagnostics.push({
      code: 'unmatched-bracket',
      message: 'Unmatched `[` — treated as literal text. Escape it as `\\[` to silence this.',
      span: frame.open!,
      severity: 'warning',
    });
    top().children.push({ kind: 'text', value: '[', span: frame.open! });
    top().children.push(...frame.children);
  }

  return { nodes: mergeText(stack[0]!.children), diagnostics };
}

/**
 * Decide what a closed `[ ... ]` group actually is.
 *
 * With a placeholder inside it becomes an optional segment. Without one it was
 * never a segment at all, so the brackets are restored verbatim and the whole
 * thing collapses back to text.
 */
function closeGroup(children: readonly Node[], span: Span): Node[] {
  if (containsPlaceholder(children)) {
    return [{ kind: 'optional', children: mergeText(children), span }];
  }
  // No placeholder anywhere inside means every descendant already flattened to
  // text, so concatenating is lossless.
  const inner = children.map(textOf).join('');
  return [{ kind: 'text', value: `[${inner}]`, span }];
}

function containsPlaceholder(nodes: readonly Node[]): boolean {
  return nodes.some((n) =>
    n.kind === 'placeholder' ? true : n.kind === 'optional' ? containsPlaceholder(n.children) : false,
  );
}

function textOf(node: Node): string {
  return node.kind === 'text' ? node.value : '';
}

/** Fold runs of adjacent text nodes into one, so the tree stays readable. */
function mergeText(nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.kind === 'text' && prev?.kind === 'text') {
      out[out.length - 1] = {
        kind: 'text',
        value: prev.value + node.value,
        span: { start: prev.span.start, end: node.span.end },
      };
      continue;
    }
    out.push(node);
  }
  return out;
}

export type { Token };
