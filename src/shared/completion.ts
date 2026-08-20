/**
 * Where the cursor is inside a placeholder, and what it wants next.
 *
 * Kept apart from the editor integration and free of imports so the rule can be
 * tested as a table rather than through a live extension host. The provider
 * that uses it decides *what* to offer; this only decides *whether* something
 * should be offered and of which kind.
 *
 * Everything is answered from the text before the cursor. A placeholder being
 * typed has no closing braces yet, so looking forward would mean guessing where
 * it ends — and guessing wrong on every keystroke.
 */

export type CompletionKind =
  /** After `{{ name :` — the field's type. */
  | 'type'
  /** After `= ` — a default, which for a block type is one of its instances. */
  | 'value'
  | 'none';

export interface CompletionContext {
  readonly kind: CompletionKind;
  /** The field being annotated, when the name has been typed. */
  readonly field?: string;
  /** The type as written, when the cursor is past the `:`. */
  readonly typeName?: string;
  /** What has been typed of the thing being completed. */
  readonly prefix: string;
}

const NONE: CompletionContext = { kind: 'none', prefix: '' };

/**
 * Read the cursor's position within an unclosed `{{ ... `.
 *
 * `choice[a, b]` is deliberately treated as finished once its `]` is there:
 * offering type names again inside the option list would be noise, and the
 * options themselves are the author's to invent.
 */
export function completionContext(textBeforeCursor: string): CompletionContext {
  const open = textBeforeCursor.lastIndexOf('{{');
  if (open === -1) return NONE;

  const fragment = textBeforeCursor.slice(open + 2);
  // A `}}` after the last `{{` means that placeholder is closed and the cursor
  // is in ordinary prose.
  if (fragment.includes('}}')) return NONE;
  // A description runs to its closing quote; nothing is being completed inside
  // one, and its contents must not be read as syntax.
  if (countUnescapedQuotes(fragment) % 2 === 1) return NONE;

  const equals = fragment.lastIndexOf('=');
  const colon = fragment.indexOf(':');

  if (equals !== -1) {
    const beforeEquals = fragment.slice(0, equals);
    const declared = colon === -1 ? undefined : beforeEquals.slice(colon + 1).trim();
    return {
      kind: 'value',
      ...(fieldName(beforeEquals, colon) ? { field: fieldName(beforeEquals, colon)! } : {}),
      ...(declared ? { typeName: stripArgs(declared) } : {}),
      prefix: fragment.slice(equals + 1).trim(),
    };
  }

  if (colon !== -1) {
    const typed = fragment.slice(colon + 1);
    // Past a completed `choice[...]` there is nothing left to suggest.
    if (typed.includes(']')) return NONE;
    return {
      kind: 'type',
      ...(fieldName(fragment, colon) ? { field: fieldName(fragment, colon)! } : {}),
      prefix: typed.trim(),
    };
  }

  return NONE;
}

function fieldName(fragment: string, colon: number): string | undefined {
  const raw = (colon === -1 ? fragment : fragment.slice(0, colon)).trim();
  return /^[A-Za-z0-9_.\-/]+$/.test(raw) ? raw : undefined;
}

/** `choice[a, b]` names the type `choice`. */
function stripArgs(type: string): string {
  const bracket = type.indexOf('[');
  return (bracket === -1 ? type : type.slice(0, bracket)).trim();
}

function countUnescapedQuotes(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') count++;
  }
  return count;
}
