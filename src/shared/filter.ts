/**
 * One matcher, used by every surface that narrows a list.
 *
 * The sidebar and the panel both have a search box over the same library, and
 * two implementations of "does this match" would eventually disagree about
 * something small and unreportable — whether a tag chip ANDs or ORs, whether a
 * note is searchable. So the rule lives here and both call it.
 *
 * No imports: this runs in the extension host and in two webview frames.
 */

export interface FilterState {
  readonly query: string;
  /** Empty means "every tag"; otherwise an item needs at least one of them. */
  readonly tags: ReadonlySet<string>;
}

/** Anything a search box can narrow. */
export interface Filterable {
  readonly name: string;
  readonly description?: string;
  readonly note?: string;
  readonly tags: readonly string[];
  /** Extra searchable text that is never displayed — a block's type, say. */
  readonly text?: string;
}

export const EMPTY_FILTER: FilterState = { query: '', tags: new Set() };

/** True when the filter is hiding anything at all. */
export function filterActive(state: FilterState): boolean {
  return state.query.trim().length > 0 || state.tags.size > 0;
}

/**
 * Tags OR together; free text ANDs against them.
 *
 * Chips that narrowed each other would make two chips almost always show
 * nothing, which is not what a filter row is for. Text is a case-insensitive
 * substring across every piece of prose an item carries, including the ones no
 * row displays — you should be able to find a template by something you wrote
 * in its note.
 */
export function matchesFilter(item: Filterable, state: FilterState): boolean {
  if (state.tags.size > 0 && !item.tags.some((tag) => state.tags.has(tag))) return false;
  const needle = state.query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [item.name, item.description, item.note, item.text, ...item.tags].some(
    (field) => field !== undefined && field.toLowerCase().includes(needle),
  );
}
