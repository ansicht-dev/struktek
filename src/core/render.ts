/**
 * Render a parsed template against a (possibly incomplete) set of values.
 *
 * Partial input is the NORMAL case, not an error path. The composer previews
 * while half the fields are still blank, and a future authoring UI previews with
 * sample values. So this never throws on a missing value — it reports what was
 * left unfilled and which segments collapsed, and lets the caller decide whether
 * that matters.
 *
 * Reporting `collapsed` spans rather than just returning the string is what lets
 * a UI grey the dropped regions out. Text silently vanishing is indistinguishable
 * from a bug.
 */

import type { Field, Node, Span } from './types';

export interface RenderOptions {
  readonly values: Readonly<Record<string, string | undefined>>;
  /** Field types, so a block-typed value resolves to its instance body. */
  readonly fields: readonly Field[];
  /** Block type name to instance name to body text. */
  readonly blocks?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface RenderResult {
  readonly text: string;
  /** Optional segments that dropped out, for greying out in a preview. */
  readonly collapsed: readonly Span[];
  /** Field names that resolved to nothing, in first-occurrence order. */
  readonly unfilled: readonly string[];
}

/**
 * Output is built as text runs separated by explicit gaps rather than as one
 * string with a sentinel character spliced in. A sentinel would have to be a
 * character no prompt could contain, and then be regex-patched back out; a gap
 * carries the same information structurally and cannot collide with content.
 */
type Part = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'gap' };

export function render(nodes: readonly Node[], opts: RenderOptions): RenderResult {
  const byName = new Map(opts.fields.map((f) => [f.name, f]));
  const parts: Part[] = [];
  const collapsed: Span[] = [];
  const unfilled: string[] = [];
  const seenUnfilled = new Set<string>();

  const markUnfilled = (name: string): void => {
    if (seenUnfilled.has(name)) return;
    seenUnfilled.add(name);
    unfilled.push(name);
  };

  const resolve = (name: string): string => {
    const field = byName.get(name);
    const raw = (opts.values[name] ?? field?.pin ?? '').trim();
    if (raw.length === 0) {
      markUnfilled(name);
      return '';
    }
    if (field?.type.kind !== 'blockType') return raw;
    // A block-typed value is an INSTANCE NAME; what renders is that file's body.
    const body = opts.blocks?.get(field.type.name)?.get(raw);
    if (body === undefined) {
      markUnfilled(name);
      return '';
    }
    return body.trim();
  };

  const walk = (list: readonly Node[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case 'text':
          parts.push({ kind: 'text', value: node.value });
          break;
        case 'placeholder':
          parts.push({ kind: 'text', value: resolve(node.decl.name) });
          break;
        case 'optional':
          // The segment survives if ANY placeholder in it has a value; the
          // blank ones inside simply render as nothing.
          if (segmentHasValue(node, resolve)) walk(node.children);
          else {
            collapsed.push(node.span);
            parts.push({ kind: 'gap' });
          }
          break;
      }
    }
  };
  walk(nodes);

  // Trimmed at both ends because a prompt never wants leading or trailing
  // whitespace, and both are easy to end up with: a segment that collapses at
  // the very start or end, or a blank placeholder inside a segment that
  // survived on the strength of a different field.
  return { text: assemble(parts).trim(), collapsed, unfilled };
}

/**
 * Does this segment have at least one filled placeholder?
 *
 * `resolve` is reused rather than reimplemented so "filled" means exactly the
 * same thing here as it does when rendering — including a block whose instance
 * file is missing, which is empty in both places.
 */
function segmentHasValue(node: Node, resolve: (name: string) => string): boolean {
  if (node.kind === 'placeholder') return resolve(node.decl.name).length > 0;
  if (node.kind === 'optional') return node.children.some((c) => segmentHasValue(c, resolve));
  return false;
}

/** Concatenate the runs, closing the hole at every gap. */
function assemble(parts: readonly Part[]): string {
  let out = '';
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.kind === 'text') {
      out += part.value;
      i += 1;
      continue;
    }
    // Consecutive gaps close as one — two adjacent collapsed segments should
    // not eat two spaces.
    while (i < parts.length && parts[i]!.kind === 'gap') i += 1;
    let following = '';
    while (i < parts.length && parts[i]!.kind === 'text') {
      following += (parts[i] as { kind: 'text'; value: string }).value;
      i += 1;
    }
    out = bridge(out, following);
  }
  return out;
}

/**
 * Rejoin the text either side of a collapsed segment.
 *
 * Two cases matter. A segment sitting inline between words leaves padding on
 * both sides that has to fold back into the single space that separated them
 * before the segment existed. A segment that owned a whole line should take the
 * line break with it rather than leaving a blank line behind.
 */
function bridge(left: string, right: string): string {
  const trimmedLeft = left.replace(/[ \t]+$/, '');
  const hadLeftPadding = trimmedLeft.length !== left.length;
  const trimmedRight = right.replace(/^[ \t]+/, '');
  const hadRightPadding = trimmedRight.length !== right.length;

  if (/\n$/.test(trimmedLeft)) {
    const leadingNewline = /^\r?\n/.exec(trimmedRight);
    if (leadingNewline) {
      const rest = trimmedRight.slice(leadingNewline[0].length);
      // The segment owned its own line, so its line break goes with it. When
      // blank lines surrounded it, dropping just the one still leaves a wider
      // gap than the author used anywhere else — cap it at a single blank line.
      const leftBreaks = /(\r?\n)+$/.exec(trimmedLeft)?.[0] ?? '';
      const rightBreaks = /^(\r?\n)+/.exec(rest)?.[0] ?? '';
      const total = (leftBreaks + rightBreaks).split('\n').length - 1;
      if (total <= 2) return trimmedLeft + rest;
      return trimmedLeft.slice(0, trimmedLeft.length - leftBreaks.length) + '\n\n' + rest.slice(rightBreaks.length);
    }
  }
  if (trimmedRight.length === 0) return trimmedLeft;
  // Punctuation that closes the preceding word takes no space in front of it.
  // `Greet {{who}} [in {{language}}].` must not render as `Greet Ada .` — the
  // space was separating the name from the segment, not from the full stop.
  if (/^[.,;:!?)\]}]/.test(trimmedRight)) return trimmedLeft + trimmedRight;
  if (hadLeftPadding || hadRightPadding) return trimmedLeft + ' ' + trimmedRight;
  return trimmedLeft + trimmedRight;
}
