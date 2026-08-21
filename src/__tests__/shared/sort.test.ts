/**
 * How the library orders itself.
 *
 * The use count is the reason this module exists as something separate from
 * the frame that draws the list: it decides the order and is never printed, so
 * the only way to know it is doing its job is to test the order directly.
 *
 * An order is a field and a direction, which is also the shape of the menu.
 * The properties that matter are the ones a list you scan every day depends
 * on — that the order is total, so it never reshuffles under you, and that an
 * overridden row cannot climb above a live one whichever way round you pick.
 */

import { describe, expect, it } from 'vitest';
import {
  knownSort,
  orderBy,
  sameSort,
  DEFAULT_SORT,
  type Sortable,
  type SortOrder,
} from '../../shared/sort';

interface Row extends Sortable {
  readonly name: string;
}

const nameOf = (row: Row): string => row.name;

const ROWS: readonly Row[] = [
  { name: 'refactor', uses: 2, created: 300 },
  { name: 'debug', uses: 9, created: 100 },
  { name: 'explain', uses: 0, created: 500 },
  { name: 'code-review', uses: 2, created: 200 },
];

const ORDERS: readonly SortOrder[] = [
  { field: 'relevance', direction: 'desc' },
  { field: 'relevance', direction: 'asc' },
  { field: 'name', direction: 'asc' },
  { field: 'name', direction: 'desc' },
  { field: 'date', direction: 'desc' },
  { field: 'date', direction: 'asc' },
];

const names = (rows: readonly Row[]): string[] => rows.map((row) => row.name);
const by = (field: SortOrder['field'], direction: SortOrder['direction']): string[] =>
  names(orderBy(ROWS, nameOf, { field, direction }));

describe('orderBy', () => {
  it('leads with the most used, and with the least used reversed', () => {
    // Two templates on 2 uses, so the name breaks the tie in both directions.
    expect(by('relevance', 'desc')).toEqual(['debug', 'code-review', 'refactor', 'explain']);
    expect(by('relevance', 'asc')).toEqual(['explain', 'code-review', 'refactor', 'debug']);
  });

  it('sorts by name both ways round', () => {
    expect(by('name', 'asc')).toEqual(['code-review', 'debug', 'explain', 'refactor']);
    expect(by('name', 'desc')).toEqual(['refactor', 'explain', 'debug', 'code-review']);
  });

  it('sorts by date both ways round', () => {
    expect(by('date', 'desc')).toEqual(['explain', 'refactor', 'code-review', 'debug']);
    expect(by('date', 'asc')).toEqual(['debug', 'code-review', 'refactor', 'explain']);
  });

  it('keeps the name tie-break ascending even when the order is descending', () => {
    // Otherwise "least used" would also reverse the templates it cannot
    // separate, reordering them for a reason nothing on screen explains.
    const tied: Row[] = [
      { name: 'b', uses: 0, created: 0 },
      { name: 'a', uses: 0, created: 0 },
    ];
    expect(names(orderBy(tied, nameOf, { field: 'relevance', direction: 'asc' }))).toEqual([
      'a',
      'b',
    ]);
    expect(names(orderBy(tied, nameOf, { field: 'relevance', direction: 'desc' }))).toEqual([
      'a',
      'b',
    ]);
  });

  it('is total, so repeated sorting never reshuffles', () => {
    // The list is repainted on every keystroke in the search box. An unstable
    // order would make rows swap places under the pointer as you type.
    for (const order of ORDERS) {
      const once = orderBy(ROWS, nameOf, order);
      const twice = orderBy([...ROWS].reverse(), nameOf, order);
      expect(names(twice), order.field + '/' + order.direction).toEqual(names(once));
    }
  });

  it('never lets an overridden row climb above a live one, in any order', () => {
    const rows: Row[] = [
      { name: 'zzz', uses: 0, created: 0 },
      { name: 'aaa', uses: 99, created: 999, shadowed: true },
    ];
    for (const order of ORDERS) {
      expect(names(orderBy(rows, nameOf, order)), order.field + '/' + order.direction).toEqual([
        'zzz',
        'aaa',
      ]);
    }
  });

  it('orders the overridden rows among themselves', () => {
    const rows: Row[] = [
      { name: 'live', uses: 1, created: 1 },
      { name: 'b', uses: 0, created: 0, shadowed: true },
      { name: 'a', uses: 0, created: 0, shadowed: true },
    ];
    expect(names(orderBy(rows, nameOf, { field: 'name', direction: 'asc' }))).toEqual([
      'live',
      'a',
      'b',
    ]);
  });

  it('falls back to the name for rows with no count, which is every block', () => {
    // Blocks have no per-value usage. Relevance must leave them alphabetical
    // rather than in whatever order the directory happened to be read in.
    const blocks: Row[] = [
      { name: 'thorough', created: 0 },
      { name: 'forensic', created: 0 },
      { name: 'quick', created: 0 },
    ];
    expect(names(orderBy(blocks, nameOf, { field: 'relevance', direction: 'desc' }))).toEqual([
      'forensic',
      'quick',
      'thorough',
    ]);
  });

  it('treats an unreadable creation time as oldest, not newest', () => {
    // 0 means "the filesystem would not say". A file of unknown age must not
    // masquerade as the newest thing in the library.
    const rows: Row[] = [
      { name: 'unknown', uses: 0, created: 0 },
      { name: 'ancient', uses: 0, created: 1 },
    ];
    expect(names(orderBy(rows, nameOf, { field: 'date', direction: 'desc' }))).toEqual([
      'ancient',
      'unknown',
    ]);
  });

  it('leaves the input array alone', () => {
    const input = [...ROWS];
    orderBy(input, nameOf, { field: 'name', direction: 'desc' });
    expect(names(input)).toEqual(names(ROWS));
  });

  it('handles an empty list', () => {
    expect(orderBy([], nameOf, DEFAULT_SORT)).toEqual([]);
  });
});

describe('knownSort', () => {
  it('accepts every order the menu offers', () => {
    for (const order of ORDERS) expect(knownSort(order)).toEqual(order);
  });

  it('falls back to the default for anything else', () => {
    // Restored webview state is whatever was persisted by a previous version,
    // so an unrecognised order has to degrade rather than break the list.
    for (const value of [
      undefined,
      null,
      '',
      'uses',
      42,
      {},
      { field: 'size', direction: 'asc' },
      { field: 'name' },
      { field: 'name', direction: 'sideways' },
    ]) {
      expect(knownSort(value)).toEqual(DEFAULT_SORT);
    }
  });

  it('rejects the flat keys an older version persisted', () => {
    // Before directions existed the frame stored a bare string. It has to read
    // as "unrecognised" rather than throw on a property access.
    for (const legacy of ['uses', 'name', 'created']) {
      expect(knownSort(legacy)).toEqual(DEFAULT_SORT);
    }
  });
});

describe('sameSort', () => {
  it('needs both halves to match', () => {
    expect(sameSort(DEFAULT_SORT, { field: 'relevance', direction: 'desc' })).toBe(true);
    expect(sameSort(DEFAULT_SORT, { field: 'relevance', direction: 'asc' })).toBe(false);
    expect(sameSort(DEFAULT_SORT, { field: 'name', direction: 'desc' })).toBe(false);
  });
});
