/**
 * One ordering, used by every surface that lists the library.
 *
 * Beside `filter.ts` and for the same reason: the rule has to be written once
 * or two surfaces will eventually disagree about something small and
 * unreportable — where an overridden row goes, what breaks a tie.
 *
 * An order is a FIELD and a DIRECTION rather than one flat list of six, because
 * that is the shape the menu has: three things to sort by, each with two ways
 * round. Splitting them means the menu is generated from the model instead of
 * repeating it, and a fourth field costs one entry here.
 *
 * The interesting decision is what is NOT here. `uses` orders the list and is
 * never rendered: a count beside every template is a number you read past on
 * every pass, while the order it produces is something you use without reading
 * anything at all. Keeping it as a key and not a label is the whole point.
 *
 * No imports: this runs in the extension host and in two webview frames.
 */

/** What to sort by. `relevance` is the use count — see the note above. */
export type SortField = 'relevance' | 'name' | 'date';

/**
 * Which way round, always in terms of the UNDERLYING value.
 *
 * So `desc` on `relevance` is most-used-first, `desc` on `date` is
 * newest-first, and `asc` on `name` is A to Z. The wording each combination
 * gets is the frame's business; the meaning is fixed here.
 */
export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  readonly field: SortField;
  readonly direction: SortDirection;
}

export const SORT_FIELDS: readonly SortField[] = ['relevance', 'name', 'date'];

/**
 * Most-used first.
 *
 * A library you have been using for a while sorts itself into what you
 * actually reach for, which is the ordering that needs no thought at all.
 */
export const DEFAULT_SORT: SortOrder = { field: 'relevance', direction: 'desc' };

/** Anything a list of library rows can be ordered by. */
export interface Sortable {
  /** Epoch milliseconds. 0 when the filesystem would not say. */
  readonly created: number;
  /**
   * Prompts composed from this, in this workspace. Absent on blocks, which
   * have no per-value count — they fall back to the name, so choosing
   * relevance leaves them alphabetical rather than in directory order.
   */
  readonly uses?: number;
  /** On disk, but not what the library resolves to. Always sorts last. */
  readonly shadowed?: boolean;
}

export function sameSort(a: SortOrder, b: SortOrder): boolean {
  return a.field === b.field && a.direction === b.direction;
}

/**
 * Narrow whatever the webview persisted into an order we still offer.
 *
 * Restored frame state was written by whichever version of struktek the user
 * last ran, so it can name a field that no longer exists. It degrades to the
 * default rather than throwing: a stale preference is not worth an empty list.
 */
export function knownSort(value: unknown): SortOrder {
  if (typeof value !== 'object' || value === null) return DEFAULT_SORT;
  const raw = value as { field?: unknown; direction?: unknown };
  if (!SORT_FIELDS.includes(raw.field as SortField)) return DEFAULT_SORT;
  if (raw.direction !== 'asc' && raw.direction !== 'desc') return DEFAULT_SORT;
  return { field: raw.field as SortField, direction: raw.direction };
}

/**
 * Order rows, overridden ones last.
 *
 * Overridden rows never compete for the top under any ordering — sorting them
 * in would put a struck-through row above a live one.
 *
 * The name breaks every tie, ALWAYS ascending even when the chosen direction
 * is descending. That is deliberate: the tie-break is there to make the order
 * total so the list cannot reshuffle between repaints, and flipping it with
 * the primary key would make "least used" reorder the zero-use templates for
 * no reason a reader could see.
 *
 * An unknown creation time is 0, which sorts oldest. A file whose age we could
 * not read must not masquerade as the newest thing in the library, and
 * grouping the unknowns at one end beats scattering them.
 */
export function orderBy<T extends Sortable>(
  rows: readonly T[],
  nameOf: (row: T) => string,
  order: SortOrder,
): T[] {
  const flip = order.direction === 'desc' ? -1 : 1;
  const compare = (a: T, b: T): number => {
    const byName = nameOf(a).localeCompare(nameOf(b));
    switch (order.field) {
      case 'name':
        return byName * flip;
      case 'date':
        return (a.created - b.created) * flip || byName;
      case 'relevance':
        return ((a.uses ?? 0) - (b.uses ?? 0)) * flip || byName;
    }
  };
  return [
    ...rows.filter((row) => !row.shadowed).sort(compare),
    ...rows.filter((row) => row.shadowed).sort(compare),
  ];
}
