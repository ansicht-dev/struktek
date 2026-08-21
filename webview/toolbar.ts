/**
 * The two buttons that sit at the end of a search box: filter, and sort.
 *
 * Both frames have a search row over a list — the sidebar over the library,
 * the panel over the prompts you have produced — and "narrow this" and "order
 * this" mean the same thing in both. What differs is only what there is to
 * filter by and what there is to sort on, so those arrive as arguments and the
 * widgets themselves are written once.
 *
 * Nothing here changes the page layout. The button reports whether a filter is
 * on and its menu shows which; an always-visible row of chips would cost a line
 * of the pane on every screen, and a row that appears and disappears would
 * shove the whole list down as you reach for it.
 */

import { el, icon } from './dom';
import { showMenu, type MenuItem } from './menu';
import { sameSort, type SortDirection, type SortField, type SortOrder } from '../src/shared/sort';

/**
 * One dimension the list can be narrowed by, as a submenu.
 *
 * Sections rather than a flat list, because there is more than one of them:
 * the history feed filters by template AND by tag, and two kinds of name in
 * one list would be a list you have to read carefully. Values are the user's
 * own words, read off their library at runtime, which is the reason this menu
 * is drawn rather than contributed — a contributed menu can only carry items
 * written into package.json.
 */
export interface FilterSection {
  readonly label: string;
  /** What an empty section says. It stays, greyed: vanishing hides the why. */
  readonly empty: string;
  readonly values: readonly string[];
  readonly active: ReadonlySet<string>;
  /** How a value reads in the menu. The value itself, by default. */
  readonly display?: (value: string) => string;
  toggle(value: string): void;
}

export interface FilterOptions {
  /** Read fresh each time the menu opens — the library changes underneath it. */
  readonly sections: () => readonly FilterSection[];
  /**
   * Repaint the LIST only.
   *
   * Called after every tick. Rebuilding the search row would tear the open
   * menu off the button it is anchored to, and ticking three tags should not
   * mean opening the menu three times.
   */
  readonly onChange: () => void;
  /** Drop every active value. Followed by a full repaint by the caller. */
  readonly onClear: () => void;
}

export function filterButton(options: FilterOptions): HTMLElement {
  const button = el(
    'button',
    { class: 'stk-filterbtn stk-funnel', type: 'button', 'aria-haspopup': 'menu' },
    [icon('filter')],
  );
  refreshFilterButton(button, options.sections());
  button.addEventListener('click', () => {
    showMenu(button, 'Filter', filterMenuItems(button, options));
  });
  return button;
}

function filterMenuItems(button: HTMLElement, options: FilterOptions): MenuItem[] {
  const sections = options.sections();

  const items: MenuItem[] = sections.map((section) => ({
    label: section.label,
    kind: 'submenu',
    // Ticked when something inside is, so you can see a filter is on without
    // opening the submenu to look.
    checked: section.active.size > 0,
    items:
      section.values.length === 0
        ? [{ label: section.empty, kind: 'action', disabled: true }]
        : section.values.map(
            (value): MenuItem => ({
              label: section.display ? section.display(value) : value,
              kind: 'checkbox',
              checked: section.active.has(value),
              run: () => {
                section.toggle(value);
                options.onChange();
                refreshFilterButton(button, options.sections());
              },
            }),
          ),
  }));

  if (sections.some((section) => section.active.size > 0)) {
    items.push({
      label: 'Clear filters',
      kind: 'action',
      separatorBefore: true,
      run: options.onClear,
    });
  }
  return items;
}

/**
 * Update the funnel in place while its menu is open.
 *
 * Only the parts that can change — the glyph and what it says. Replacing the
 * button would close the menu, which is the one thing ticking a value must not
 * do.
 */
function refreshFilterButton(button: HTMLElement, sections: readonly FilterSection[]): void {
  const active = sections.flatMap((section) => [...section.active]);
  const label = active.length === 0 ? 'Filter' : 'Filtering by ' + active.join(', ');
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(active.length > 0));
  const glyph = button.querySelector('.codicon');
  // The filled funnel is the workbench's own way of saying a filter is on.
  if (glyph) glyph.className = 'codicon codicon-' + (active.length > 0 ? 'filter-filled' : 'filter');
}

/**
 * How each field and each direction is worded, per frame.
 *
 * A frame's menu is generated from its own list of these, so another way to
 * sort is one entry there and nothing else. `field` names what you are sorting
 * by and reads as the submenu title; the two directions are what you pick.
 */
export interface SortSpec {
  readonly field: SortField;
  readonly label: string;
  readonly directions: readonly {
    readonly direction: SortDirection;
    readonly label: string;
    readonly hint: string;
  }[];
}

/** How the current order reads in the button's tooltip. */
export function sortLabel(specs: readonly SortSpec[], order: SortOrder): string {
  const field = specs.find((spec) => spec.field === order.field);
  return field?.directions.find((option) => option.direction === order.direction)?.label ?? '';
}

/**
 * The sort menu: one submenu per field, two directions inside each.
 *
 * Splitting the direction out is what keeps the top level to three short words
 * you can aim at. The field carries a tick when the current order is one of
 * its two, so the answer to "how is this sorted" is visible without opening
 * anything.
 */
export function sortButton(
  specs: readonly SortSpec[],
  order: SortOrder,
  fallback: SortOrder,
  pick: (order: SortOrder) => void,
): HTMLElement {
  const label = 'Sort by — ' + sortLabel(specs, order);
  const button = el(
    'button',
    {
      class: 'stk-sortbtn stk-funnel',
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-haspopup': 'menu',
      // Pressed whenever the order is not the default, so an unexpected order
      // always has something pointing at the control that caused it.
      'aria-pressed': !sameSort(order, fallback),
    },
    [icon('sort-precedence')],
  );
  button.addEventListener('click', () => {
    showMenu(
      button,
      'Sort by',
      specs.map((spec): MenuItem => ({
        label: spec.label,
        kind: 'submenu',
        checked: order.field === spec.field,
        items: spec.directions.map((option): MenuItem => ({
          label: option.label,
          kind: 'radio',
          title: option.hint,
          checked: sameSort(order, { field: spec.field, direction: option.direction }),
          run: () => {
            pick({ field: spec.field, direction: option.direction });
            // The button the pick came from has just been replaced by the
            // repaint; put the keyboard on its successor rather than on the
            // document.
            document.querySelector<HTMLElement>('.stk-sortbtn')?.focus();
          },
        })),
      })),
    );
  });
  return button;
}
