/**
 * The sidebar frame: search row, then Templates and Blocks as collapsible
 * sections — the shape the Extensions view has.
 *
 * It draws what a TreeView would have drawn, because a contributed view cannot
 * put a search box above its own section headers. That means rows, hover cards,
 * hover actions and arrow-key navigation are implemented here rather than
 * inherited, and it is why the row metrics in `sidebarView.ts` are the
 * workbench's own rather than something that merely looks close.
 *
 * The whole library lives in this frame, so filtering is local and typing costs
 * nothing. Every action that touches disk is posted to the host.
 *
 * DOM is built with `textContent`, never `innerHTML`: a template name is text
 * the user wrote and must render as characters.
 */

import { matchesFilter, type Filterable, type FilterState } from '../src/shared/filter';
import {
  DEFAULT_SORT,
  knownSort,
  orderBy,
  sameSort,
  SORT_FIELDS,
  type SortDirection,
  type SortField,
  type SortOrder,
} from '../src/shared/sort';
import type {
  BlockRow,
  BlockTypeRow,
  SidebarHostMessage,
  SidebarMessage,
  TemplateRow,
} from '../src/shared/sidebarProtocol';

interface VsCodeApi {
  postMessage(message: SidebarMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/**
 * What survives the frame being torn down.
 *
 * A collapsed section that springs open every time the sidebar is hidden would
 * be worse than no collapsing at all.
 */
interface PersistedState {
  readonly query: string;
  readonly tags: readonly string[];
  readonly sort: SortOrder;
  readonly openTemplates: boolean;
  readonly openBlocks: boolean;
  readonly openTypes: readonly string[];
}

/**
 * How each field and each direction is worded.
 *
 * The menu is generated from this, so a fourth way to sort is one entry here
 * and nothing else. `field` names what you are sorting by and reads as the
 * submenu title; the two directions are what you actually pick.
 *
 * "Relevance" rather than "Uses" on purpose: the count itself is never shown,
 * so naming the menu after it would advertise a number the user cannot see.
 * What they are choosing is whether the list leads with what they reach for.
 */
const SORTS: readonly {
  readonly field: SortField;
  readonly label: string;
  readonly directions: readonly {
    readonly direction: SortDirection;
    readonly label: string;
    readonly hint: string;
  }[];
}[] = [
  {
    field: 'relevance',
    label: 'Relevance',
    directions: [
      { direction: 'desc', label: 'Most used', hint: 'most composed in this workspace first' },
      { direction: 'asc', label: 'Least used', hint: 'never composed here first' },
    ],
  },
  {
    field: 'name',
    label: 'Name',
    directions: [
      { direction: 'asc', label: 'Alphabetical', hint: 'A to Z' },
      { direction: 'desc', label: 'Reverse alphabetical', hint: 'Z to A' },
    ],
  },
  {
    field: 'date',
    label: 'Date',
    directions: [
      { direction: 'desc', label: 'Newest', hint: 'most recently created first' },
      { direction: 'asc', label: 'Oldest', hint: 'longest-standing first' },
    ],
  },
];

/** How the current order reads in the button's tooltip. */
function sortLabel(order: SortOrder): string {
  const field = SORTS.find((sort) => sort.field === order.field);
  const direction = field?.directions.find((option) => option.direction === order.direction);
  return direction?.label ?? '';
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

const restored = vscode.getState();

const state = {
  templates: [] as readonly TemplateRow[],
  blockTypes: [] as readonly BlockTypeRow[],
  allTags: [] as readonly string[],
  hasWorkspace: true,
  hasGlobal: true,
  query: restored?.query ?? '',
  activeTags: new Set<string>(restored?.tags ?? []),
  sort: knownSort(restored?.sort),
  openTemplates: restored?.openTemplates ?? true,
  openBlocks: restored?.openBlocks ?? true,
  openTypes: new Set<string>(restored?.openTypes ?? []),
  /** The row the keyboard is on, as `templates:name` or `block:type/instance`. */
  active: undefined as string | undefined,
};

function persist(): void {
  vscode.setState({
    query: state.query,
    tags: [...state.activeTags],
    sort: state.sort,
    openTemplates: state.openTemplates,
    openBlocks: state.openBlocks,
    openTypes: [...state.openTypes],
  });
}

function post(message: SidebarMessage): void {
  vscode.postMessage(message);
}

// ── DOM helpers ───────────────────────────────────────────────────────

type Attrs = Record<string, string | number | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (globalThis.Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function on<T extends HTMLElement>(node: T, event: string, handler: (e: Event) => void): T {
  node.addEventListener(event, handler);
  return node;
}

/** A codicon, the workbench's own icon font — not a lookalike glyph. */
function icon(name: string, extra = ''): HTMLElement {
  return el('span', { class: ('codicon codicon-' + name + ' ' + extra).trim(), 'aria-hidden': 'true' });
}

// ── menus ─────────────────────────────────────────────────

/**
 * A context menu with submenus, drawn by hand.
 *
 * Drawn rather than contributed because of one hard constraint: a contributed
 * menu is declared in package.json and there is no API to add an item at
 * runtime. Tags are the user's own data, discovered by reading their library,
 * so a native menu can never list them. The other options are worse still - a
 * select is a browser widget that looks nothing like the editor, and a row of
 * chips that unfolds shoves every template down as you reach for one.
 *
 * So this matches the workbench menu instead: the same colour tokens, 22px
 * rows, a leading check column, separators, and submenus that open to the side
 * on hover or on Right.
 *
 * Levels form a stack. Opening one at depth N closes everything below it, so
 * the structure can never fork.
 */
interface MenuItem {
  readonly label: string;
  /**
   * `radio` closes the whole menu on pick - one choice, made.
   * `checkbox` leaves it open, because you toggle several.
   * `submenu` opens `items` beside itself.
   */
  readonly kind: 'radio' | 'checkbox' | 'action' | 'submenu';
  readonly checked?: boolean;
  readonly title?: string;
  readonly separatorBefore?: boolean;
  /** Greyed and unusable - an empty section says so rather than vanishing. */
  readonly disabled?: boolean;
  readonly items?: readonly MenuItem[];
  run?(): void;
}

interface MenuLevel {
  readonly node: HTMLElement;
  readonly buttons: HTMLElement[];
  /** The submenu item this level hangs off, for Left and for focus return. */
  readonly parent?: HTMLElement;
}

const ROLES: Readonly<Record<MenuItem['kind'], string>> = {
  radio: 'menuitemradio',
  checkbox: 'menuitemcheckbox',
  action: 'menuitem',
  submenu: 'menuitem',
};

/** How long the pointer must rest on a row before its submenu opens. */
const SUBMENU_DELAY = 180;

let levels: MenuLevel[] = [];
let menuListeners: (() => void) | undefined;
let submenuTimer: ReturnType<typeof setTimeout> | undefined;

/** True while any menu is up - the row list checks this before taking a key. */
function menuIsOpen(): boolean {
  return levels.length > 0;
}

/** Drop levels deeper than `depth`, innermost first. */
function closeToDepth(depth: number): void {
  while (levels.length > depth) {
    const level = levels.pop();
    level?.node.remove();
    level?.parent?.setAttribute('aria-expanded', 'false');
  }
}

function closeMenu(restoreFocusTo?: HTMLElement): void {
  if (submenuTimer) clearTimeout(submenuTimer);
  submenuTimer = undefined;
  closeToDepth(0);
  menuListeners?.();
  menuListeners = undefined;
  restoreFocusTo?.focus();
}

/** Flip a menu item's tick, keeping the reserved check column either way. */
function setChecked(button: HTMLElement, on: boolean): void {
  button.setAttribute('aria-checked', String(on));
  button.firstElementChild?.replaceWith(
    on ? icon('check', 'stk-menu-check') : el('span', { class: 'stk-menu-check' }),
  );
}

/** Which level the keyboard is in, or -1 when focus has left the menu. */
function focusedDepth(): number {
  return levels.findIndex((level) => level.node.contains(document.activeElement));
}

function buildLevel(label: string, items: readonly MenuItem[], depth: number): MenuLevel {
  const node = el('div', { class: 'stk-menu', role: 'menu', 'aria-label': label });
  const buttons: HTMLElement[] = [];

  for (const item of items) {
    if (item.separatorBefore) node.append(el('div', { class: 'stk-menu-sep', role: 'separator' }));
    const button = el(
      'button',
      {
        class: 'stk-menu-item' + (item.disabled ? ' stk-menu-disabled' : ''),
        type: 'button',
        role: ROLES[item.kind],
        tabindex: -1,
        ...(item.disabled ? { 'aria-disabled': true } : {}),
        ...(item.kind === 'radio' || item.kind === 'checkbox'
          ? { 'aria-checked': item.checked === true }
          : {}),
        ...(item.kind === 'submenu' ? { 'aria-haspopup': 'menu', 'aria-expanded': false } : {}),
        ...(item.title ? { title: item.title } : {}),
      },
      [
        // The check column is always there, ticked or not, so labels line up -
        // the same reason a leaf tree row still reserves its twistie. A
        // submenu parent can carry a tick too: it says the current choice is
        // somewhere inside, which is what saves you opening all three.
        item.checked ? icon('check', 'stk-menu-check') : el('span', { class: 'stk-menu-check' }),
        el('span', { class: 'stk-menu-label', text: item.label }),
        ...(item.kind === 'submenu' ? [icon('chevron-right', 'stk-menu-more')] : []),
      ],
    );

    if (!item.disabled) {
      button.addEventListener('click', () => {
        if (item.kind === 'submenu') {
          openSubmenu(button, item, depth);
          levels[depth + 1]?.buttons[0]?.focus();
          return;
        }
        // A checkbox leaves the menu up: ticking three tags should not mean
        // opening the menu three times. Its own tick has to be updated here,
        // since nothing else is going to rebuild it.
        if (item.kind === 'checkbox') {
          setChecked(button, button.getAttribute('aria-checked') !== 'true');
          item.run?.();
          return;
        }
        closeMenu();
        item.run?.();
      });

      // Pointer behaviour is the workbench's: moving along the rows opens the
      // submenu you rest on and closes the one you left, after a beat so that
      // crossing a row on the way somewhere else does not flash a menu open.
      button.addEventListener('mouseenter', () => {
        if (submenuTimer) clearTimeout(submenuTimer);
        submenuTimer = setTimeout(() => {
          if (item.kind === 'submenu') openSubmenu(button, item, depth);
          else closeToDepth(depth + 1);
        }, SUBMENU_DELAY);
      });
    }

    buttons.push(button);
    node.append(button);
  }

  return { node, buttons };
}

function openSubmenu(parent: HTMLElement, item: MenuItem, depth: number): void {
  // Already showing this one: leave it, or hovering along its own rows would
  // rebuild it under the pointer.
  if (levels[depth + 1]?.parent === parent) return;
  closeToDepth(depth + 1);
  const level = buildLevel(item.label, item.items ?? [], depth + 1);
  document.body.append(level.node);
  placeBeside(level.node, parent);
  parent.setAttribute('aria-expanded', 'true');
  levels.push({ ...level, parent });
}

function showMenu(anchor: HTMLElement, label: string, items: readonly MenuItem[]): void {
  closeMenu();

  const root = buildLevel(label, items, 0);
  document.body.append(root.node);
  placeUnder(root.node, anchor);
  levels.push(root);

  const onPointerDown = (event: Event): void => {
    const target = event.target as globalThis.Node | null;
    if (!target) return;
    if (anchor.contains(target)) return;
    if (levels.some((open) => open.node.contains(target))) return;
    closeMenu();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const depth = focusedDepth();
    if (depth < 0) return;
    const level = levels[depth]!;
    const usable = level.buttons.filter((button) => button.getAttribute('aria-disabled') !== 'true');
    const stop = (): void => {
      event.preventDefault();
      // Capture phase, so stopping here is what keeps the row list from also
      // acting on the key. Both listeners are on `document`.
      event.stopPropagation();
    };

    switch (event.key) {
      case 'Escape':
      case 'Tab': {
        // Escape peels one level at a time, the way a nested menu should.
        const parent = level.parent;
        if (depth > 0) {
          closeToDepth(depth);
          parent?.focus();
        } else {
          closeMenu(anchor);
        }
        stop();
        return;
      }

      case 'ArrowDown':
      case 'ArrowUp': {
        if (usable.length === 0) return stop();
        const current = usable.findIndex((button) => button === document.activeElement);
        // Wrapping, which a menu does and a list does not: there is no "past
        // the end" in a menu, and a keyboard user should not have to reverse.
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % usable.length
            : (current <= 0 ? usable.length : current) - 1;
        usable[next]?.focus();
        stop();
        return;
      }

      case 'ArrowRight': {
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.getAttribute('aria-haspopup') === 'menu') focused.click();
        stop();
        return;
      }

      case 'ArrowLeft': {
        if (depth === 0) return;
        const parent = level.parent;
        closeToDepth(depth);
        parent?.focus();
        stop();
        return;
      }

      default:
        return;
    }
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  menuListeners = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  // Open on the ticked row, so the menu starts where you already are.
  const ticked = root.buttons.find((button) => button.getAttribute('aria-checked') === 'true');
  (ticked ?? root.buttons[0])?.focus();
}

/**
 * Put a root menu under its button, flipping and clamping to stay on screen.
 *
 * Right-aligned because the buttons sit at the right edge of a narrow pane; a
 * left-aligned menu would hang off it. The sidebar can be dragged very narrow,
 * so the width is capped rather than assumed.
 */
function placeUnder(node: HTMLElement, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  const below = box.bottom + 2;
  const top =
    below + node.offsetHeight < window.innerHeight
      ? below
      : Math.max(4, box.top - node.offsetHeight - 2);
  node.style.top = top + 'px';
  node.style.left = clampLeft(box.right - node.offsetWidth, node.offsetWidth) + 'px';
}

/**
 * Put a submenu beside the row it belongs to.
 *
 * To the right normally, and to the LEFT when there is no room - which in a
 * sidebar at its usual width is most of the time, so the flip is the common
 * path rather than an edge case. It overlaps the parent by two pixels on
 * purpose: that leaves no gap for the pointer to fall through on the way
 * across, which would close the very menu you are reaching for.
 */
function placeBeside(node: HTMLElement, parent: HTMLElement): void {
  const box = parent.getBoundingClientRect();
  const width = node.offsetWidth;
  const right = box.right - 2;
  const left = right + width < window.innerWidth ? right : box.left - width + 2;
  node.style.left = clampLeft(left, width) + 'px';
  // Aligned to the row, then pulled up by the menu's own padding so the first
  // item sits level with the row it came from.
  const top = box.top - 4;
  node.style.top = Math.max(4, Math.min(top, window.innerHeight - node.offsetHeight - 4)) + 'px';
}

function clampLeft(left: number, width: number): number {
  return Math.max(4, Math.min(left, window.innerWidth - width - 4));
}

// ── scope ─────────────────────────────────────────────────────────────

/**
 * The overlay that marks a row as coming from the home library.
 *
 * A corner badge on the row's own icon rather than a second icon beside it —
 * the same composition the Explorer uses for a decorated file, and the reason
 * the row still reads as "a template" first and "a global one" second. A
 * separate glyph after the name competed with the name for the eye; a corner
 * badge qualifies the icon that is already there.
 *
 * Only global rows get one. Marking both scopes would put a badge on every row
 * in the list and make neither of them mean anything — the workspace library is
 * the unremarkable case, so it says nothing.
 */
function scopeOverlay(row: { scope: string }): string | undefined {
  return row.scope === 'global' ? 'globe' : undefined;
}

/**
 * The move action for a row, pointed the way it can actually go.
 *
 * Absent when the destination does not exist — with no folder open there is no
 * workspace library to demote into, and with the global library switched off
 * there is nothing to promote to.
 */
function scopeAction(
  row: { scope: string },
  target: Extract<SidebarMessage, { type: 'setScope' }>['target'],
): HTMLElement | undefined {
  if (row.scope === 'global') {
    if (!state.hasWorkspace) return undefined;
    return action('root-folder', 'Make workspace-only', () =>
      post({ type: 'setScope', to: 'workspace', target }),
    );
  }
  if (!state.hasGlobal) return undefined;
  return action('globe', 'Make global', () => post({ type: 'setScope', to: 'global', target }));
}

/** What the globe means, spelled out where there is room to spell it out. */
function globalNote(): HTMLElement {
  return el('div', {
    class: 'stk-hover-line stk-scope-note',
    text: 'From your global library — available in every workspace.',
  });
}

/** The line a hover adds for a row that exists but is not what renders. */
function shadowedNote(row: { shadowed?: boolean; scope: string }): HTMLElement | undefined {
  if (!row.shadowed) return undefined;
  return el('div', {
    class: 'stk-hover-line stk-shadowed-note',
    text:
      row.scope === 'global'
        ? 'Overridden — the workspace copy of this name is the one that renders.'
        : 'Overridden by another copy of this name.',
  });
}

/**
 * A row's icon, with an optional badge in its bottom-left corner.
 *
 * The plain icon when there is no badge — the same single element the row has
 * always had, so a row that gains a badge does not shift by a pixel against
 * the rows around it. Only when there IS one does the icon get wrapped in a
 * positioning box, and the badge is placed relative to that.
 */
function rowIcon(name: string, danger: boolean, overlay?: string): HTMLElement {
  const base = icon(name, 'stk-icon' + (danger ? ' stk-err' : ''));
  if (!overlay) return base;
  return el('span', { class: 'stk-icon-stack' }, [base, icon(overlay, 'stk-overlay')]);
}

/** An action that lives on a row, and must not also trigger the row itself. */
function action(name: string, title: string, run: () => void): HTMLElement {
  const button = el('button', { class: 'stk-act', type: 'button', title, 'aria-label': title }, [icon(name)]);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

// ── filtering ─────────────────────────────────────────────────────────

function filter(): FilterState {
  return { query: state.query, tags: state.activeTags };
}

function templateMatches(row: TemplateRow): boolean {
  return matchesFilter(row as Filterable, filter());
}

/** The type name is searchable text, so `depth` finds every value of that type. */
function blockFilterable(row: BlockRow): Filterable {
  return {
    name: row.instance,
    text: row.title ? row.title + ' ' + row.type : row.type,
    ...(row.description ? { description: row.description } : {}),
    ...(row.note ? { note: row.note } : {}),
    tags: row.tags,
  };
}

function typeNameMatches(type: string): boolean {
  return matchesFilter({ name: type, tags: [] }, filter());
}

// ── ordering ──────────────────────────────────────────────────────────

/**
 * Compare by the chosen key, with the name as the tie-break throughout.
 *
 * Always a total order, so the list never reshuffles between repaints on rows
 * the key cannot separate — two templates used the same number of times, or
 * two files written in the same second.
 *
 * `uses` is absent on blocks, which have no per-value count; they fall back to
 * the name, so choosing "Most used" leaves the block section alphabetical
 * rather than in whatever order the directory happened to be read in.
 */
/** The shared comparator, against whatever this frame is currently sorted by. */
function ordered<T extends { created: number; uses?: number; shadowed?: boolean }>(
  rows: readonly T[],
  nameOf: (row: T) => string,
): T[] {
  return orderBy(rows, nameOf, state.sort);
}

/**
 * A type survives if it matches itself or holds anything that does — and a type
 * that matched on its own name shows everything inside it, since narrowing its
 * children would hide the thing that answered the query.
 */
function visibleInstances(group: BlockTypeRow): readonly BlockRow[] {
  const matching = typeNameMatches(group.type)
    ? group.instances
    : group.instances.filter((row) => matchesFilter(blockFilterable(row), filter()));
  return ordered(matching, (row) => row.instance);
}

// ── hover card ────────────────────────────────────────────────────────

let hoverCard: HTMLElement | undefined;

function hideHover(): void {
  hoverCard?.remove();
  hoverCard = undefined;
}

/**
 * The documented hover, drawn by hand:
 *
 *   title (bold) / description (italic) / tags / note
 *   ───
 *   fields: target:file, focus:choice   — or —   type: depth
 */
function showHover(anchor: HTMLElement, build: () => HTMLElement): void {
  hideHover();
  const card = build();
  document.body.append(card);
  hoverCard = card;

  const box = anchor.getBoundingClientRect();
  const height = card.offsetHeight;
  // Below the row normally, above it when there is no room — a card that ran
  // off the bottom would be unreadable exactly when the list is long.
  const top = box.bottom + height + 6 < window.innerHeight ? box.bottom + 4 : box.top - height - 4;
  card.style.top = Math.max(4, top) + 'px';
  card.style.left = '8px';
  card.style.right = '8px';
}

function hoverHead(
  title: string,
  description: string | undefined,
  tags: readonly string[],
  note: string | undefined,
): HTMLElement[] {
  const parts: HTMLElement[] = [el('div', { class: 'stk-hover-title', text: title })];
  if (description) parts.push(el('div', { class: 'stk-hover-desc', text: description }));
  if (tags.length > 0) parts.push(el('div', { class: 'stk-hover-line', text: tags.join(', ') }));
  if (note) parts.push(el('div', { class: 'stk-hover-note', text: note }));
  return parts;
}

function templateHover(row: TemplateRow): HTMLElement {
  const parts = hoverHead(row.name, row.description, row.tags, row.note);
  const overridden = shadowedNote(row);
  if (overridden) parts.push(overridden);
  else if (row.scope === 'global') parts.push(globalNote());
  // The only thing below the description is what is wrong with the template.
  for (const problem of row.problems) {
    const line = el('div', { class: 'stk-problem stk-' + problem.severity });
    line.append(icon(problem.severity === 'error' ? 'error' : 'warning'));
    line.append(el('span', { text: problem.message }));
    parts.push(line);
  }
  return el('div', { class: 'stk-hover' }, parts);
}

function blockHover(row: BlockRow): HTMLElement {
  const parts = hoverHead(row.title ?? row.instance, row.description, row.tags, row.note);
  const overridden = shadowedNote(row);
  if (overridden) parts.push(overridden);
  else if (row.scope === 'global') parts.push(globalNote());
  return el('div', { class: 'stk-hover' }, parts);
}

function blockTypeHover(group: BlockTypeRow): HTMLElement {
  const parts = hoverHead(
    group.type,
    'A field type of your own — any template can ask for a ' + group.type + '.',
    [],
    undefined,
  );
  if (group.scope === 'global') parts.push(globalNote());
  return el('div', { class: 'stk-hover' }, parts);
}

function withHover(row: HTMLElement, build: () => HTMLElement): HTMLElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  row.addEventListener('mouseenter', () => {
    timer = setTimeout(() => showHover(row, build), 450);
  });
  row.addEventListener('mouseleave', () => {
    if (timer) clearTimeout(timer);
    hideHover();
  });
  return row;
}

// ── rows ──────────────────────────────────────────────────────────────

function rowShell(
  id: string,
  opts: {
    icon: string;
    label: string;
    note?: string;
    indent?: boolean;
    danger?: boolean;
    twistie?: string;
    /** Codicon name for a corner badge on the row icon. */
    overlay?: string | undefined;
    /** Dimmed, because it is on disk but not what a template resolves to. */
    shadowed?: boolean;
  },
  activate: () => void,
): HTMLElement {
  const row = el('div', {
    class:
      'stk-row' +
      (opts.indent ? ' stk-indent' : '') +
      (opts.shadowed ? ' stk-shadowed' : '') +
      (state.active === id ? ' stk-active' : ''),
    role: 'treeitem',
    tabindex: -1,
    'data-id': id,
  });
  // A tree row is twistie, then icon, then label — and a leaf still reserves
  // the twistie column so its label lines up with its siblings'.
  row.append(
    opts.twistie ? icon(opts.twistie, 'stk-twistie') : el('span', { class: 'stk-twistie' }),
    rowIcon(opts.icon, opts.danger === true, opts.overlay),
    el('span', { class: 'stk-row-name', text: opts.label }),
  );
  if (opts.note) {
    row.append(
      el('span', { class: 'stk-row-note' + (opts.danger ? ' stk-err' : ''), text: opts.note }),
    );
  }
  row.addEventListener('click', () => {
    state.active = id;
    activate();
  });
  return row;
}

function templateRowNode(row: TemplateRow): HTMLElement {
  // The use count is deliberately NOT here. It is worth ordering the list by
  // and not worth a number on every row: a count you read past on each pass is
  // noise, while the order it produces needs no reading at all. What earns the
  // space is something actionable — that this template is broken.
  const note =
    row.errors > 0 ? String(row.errors) + ' error' + (row.errors === 1 ? '' : 's') : '';

  // A broken template still lists — you cannot fix what the view hides.
  // A shadowed one does too, keyed apart so the two never collide in the
  // keyboard's row index.
  const node = rowShell(
    (row.shadowed ? 'shadowed-template:' : 'template:') + row.scope + ':' + row.name,
    {
      icon: 'symbol-snippet',
      label: row.name,
      ...(note ? { note } : {}),
      danger: row.errors > 0,
      overlay: scopeOverlay(row),
      ...(row.shadowed ? { shadowed: true } : {}),
    },
    // An overridden template cannot be composed — composing by name would
    // silently give you the copy that displaced it.
    () =>
      row.shadowed
        ? post({ type: 'openTemplate', name: row.name })
        : post({ type: 'showTemplate', name: row.name }),
  );

  const actions: HTMLElement[] = [];
  if (!row.shadowed) {
    // The panel's compose screen, not the QuickPick chain — a button that
    // says Compose has to open the thing you compose in.
    actions.push(action('play', 'Compose', () => post({ type: 'showTemplate', name: row.name })));
  }
  actions.push(action('go-to-file', 'Open file', () => post({ type: 'openTemplate', name: row.name })));
  const move = scopeAction(row, { kind: 'template', name: row.name });
  if (move) actions.push(move);
  actions.push(action('trash', 'Delete', () => post({ type: 'deleteTemplate', name: row.name })));
  node.append(el('span', { class: 'stk-row-actions' }, actions));
  return withHover(node, () => templateHover(row));
}

function blockRowNode(row: BlockRow): HTMLElement {
  const node = rowShell(
    'block:' + row.scope + ':' + row.type + '/' + row.instance,
    {
      icon: 'symbol-enum-member',
      label: row.instance,
      ...(row.title ? { note: row.title } : {}),
      indent: true,
      overlay: scopeOverlay(row),
      ...(row.shadowed ? { shadowed: true } : {}),
    },
    () => post({ type: 'openBlock', blockType: row.type, instance: row.instance, scope: row.scope }),
  );
  const actions: HTMLElement[] = [];
  const move = scopeAction(row, { kind: 'block', blockType: row.type, instance: row.instance });
  if (move) actions.push(move);
  actions.push(
    action('trash', 'Delete', () =>
      post({ type: 'deleteBlock', blockType: row.type, instance: row.instance, scope: row.scope }),
    ),
  );
  node.append(el('span', { class: 'stk-row-actions' }, actions));
  return withHover(node, () => blockHover(row));
}

function blockTypeRowNode(group: BlockTypeRow, instances: readonly BlockRow[]): HTMLElement[] {
  const open = state.openTypes.has(group.type);
  const node = rowShell(
    'blockType:' + group.type,
    {
      icon: 'symbol-enum',
      twistie: open ? 'chevron-down' : 'chevron-right',
      label: group.type,
      note: String(group.instances.length),
      overlay: scopeOverlay(group),
    },
    () => {
      if (open) state.openTypes.delete(group.type);
      else state.openTypes.add(group.type);
      persist();
      render();
    },
  );
  node.setAttribute('aria-expanded', String(open));
  const typeActions: HTMLElement[] = [
    action('add', 'New value', () => post({ type: 'newBlock', blockType: group.type })),
  ];
  // Moving a type moves every value in it, which is the only sensible unit:
  // half a type in each library is a shape nobody asked for.
  const move = scopeAction(group, { kind: 'blockType', blockType: group.type });
  if (move) typeActions.push(move);
  typeActions.push(
    action('trash', 'Delete type', () =>
      post({ type: 'deleteBlockType', blockType: group.type, scope: group.scope }),
    ),
  );
  node.append(el('span', { class: 'stk-row-actions' }, typeActions));

  const nodes = [withHover(node, () => blockTypeHover(group))];
  // A filter that matched inside a collapsed type opens it: hiding the match
  // that justified showing the type would be the wrong answer.
  if (open || (filterActiveNow() && !typeNameMatches(group.type))) {
    for (const row of instances) nodes.push(blockRowNode(row));
  }
  return nodes;
}

function filterActiveNow(): boolean {
  return state.query.trim().length > 0 || state.activeTags.size > 0;
}

// ── sections ──────────────────────────────────────────────────────────

function sectionTitle(
  label: string,
  count: number,
  open: boolean,
  toggle: () => void,
  actions: HTMLElement[],
): HTMLElement {
  const title = el('button', { class: 'stk-section-title', type: 'button', 'aria-expanded': open }, [
    icon(open ? 'chevron-down' : 'chevron-right', 'stk-pane-twistie'),
    el('span', { text: label }),
    el('span', { class: 'stk-grow' }),
  ]);
  if (actions.length > 0) {
    const bar = el('span', { class: 'stk-section-actions' }, actions);
    // Clicking an action must not collapse the section under the pointer.
    bar.addEventListener('click', (event) => event.stopPropagation());
    title.append(bar);
  }
  title.append(el('span', { class: 'stk-section-count', text: String(count) }));
  title.addEventListener('click', toggle);
  return title;
}

// ── toolbar ───────────────────────────────────────────────────────────

/**
 * The filter menu.
 *
 * Sections rather than a flat list, because there will be more of them than
 * tags: each section is a submenu holding whatever that dimension offers. Tags
 * is the one that exists, and it is the reason this menu is drawn rather than
 * contributed - its items are the user's own words, read off their library at
 * runtime, and a contributed menu can only carry items written into
 * package.json.
 */
function filterMenuItems(button: HTMLElement): MenuItem[] {
  const tags: MenuItem[] =
    state.allTags.length === 0
      ? [{ label: 'No tags in this library', kind: 'action', disabled: true }]
      : state.allTags.map((tag) => ({
          label: tag,
          kind: 'checkbox',
          checked: state.activeTags.has(tag),
          run: () => {
            if (state.activeTags.has(tag)) state.activeTags.delete(tag);
            else state.activeTags.add(tag);
            persist();
            // The body only. Rebuilding the search row would tear the open
            // menu off the button it is anchored to.
            paintBody();
            refreshFilterButton(button);
          },
        }));

  const items: MenuItem[] = [
    {
      label: 'Tags',
      kind: 'submenu',
      // Ticked when something inside is, so you can see a filter is on
      // without opening the submenu to look.
      checked: state.activeTags.size > 0,
      items: tags,
    },
  ];

  if (state.activeTags.size > 0) {
    items.push({
      label: 'Clear filters',
      kind: 'action',
      separatorBefore: true,
      run: () => {
        state.activeTags.clear();
        persist();
        render();
      },
    });
  }
  return items;
}

/**
 * The tag filter, as a button and its menu.
 *
 * Nothing about it changes the page layout: the button reports whether a
 * filter is on and the menu shows which. An always-visible row of chips would
 * cost a line of a pane that is mostly list, and a row that appears and
 * disappears would shove every template down as you use it.
 */
function filterButton(): HTMLElement {
  const button = el(
    'button',
    { class: 'stk-filterbtn stk-funnel', type: 'button', 'aria-haspopup': 'menu' },
    [icon('filter')],
  );
  refreshFilterButton(button);
  button.addEventListener('click', () => {
    showMenu(button, 'Filter', filterMenuItems(button));
  });
  return button;
}

/**
 * Update the funnel in place while its menu is open.
 *
 * Only the parts that can change - the glyph and what it says. Replacing the
 * button would close the menu, which is the one thing ticking a tag must not
 * do.
 */
function refreshFilterButton(button: HTMLElement): void {
  const active = state.activeTags.size;
  const label = active === 0 ? 'Filter' : 'Filtering by ' + [...state.activeTags].join(', ');
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(active > 0));
  const glyph = button.querySelector('.codicon');
  // The filled funnel is the workbench's own way of saying a filter is on.
  if (glyph) glyph.className = 'codicon codicon-' + (active > 0 ? 'filter-filled' : 'filter');
}

/**
 * The sort menu: one submenu per field, two directions inside each.
 *
 * Splitting the direction out is what keeps the top level to three short words
 * you can aim at. The field carries a tick when the current order is one of
 * its two, so the answer to "how is this sorted" is visible without opening
 * anything.
 */
function sortButton(): HTMLElement {
  const label = 'Sort by \u2014 ' + sortLabel(state.sort);
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
      'aria-pressed': !sameSort(state.sort, DEFAULT_SORT),
    },
    [icon('sort-precedence')],
  );
  button.addEventListener('click', () => {
    showMenu(
      button,
      'Sort by',
      SORTS.map((sort): MenuItem => ({
        label: sort.label,
        kind: 'submenu',
        checked: state.sort.field === sort.field,
        items: sort.directions.map((option): MenuItem => ({
          label: option.label,
          kind: 'radio',
          title: option.hint,
          checked: sameSort(state.sort, { field: sort.field, direction: option.direction }),
          run: () => {
            state.sort = { field: sort.field, direction: option.direction };
            persist();
            render();
            // The button the pick came from has just been replaced; put the
            // keyboard on its successor rather than on the document.
            root.querySelector<HTMLElement>('.stk-sortbtn')?.focus();
          },
        })),
      })),
    );
  });
  return button;
}

// ── render ────────────────────────────────────────────────────────────

function render(): void {
  hideHover();
  // A menu is anchored to a button this repaint is about to replace.
  closeMenu();

  const search = el('input', {
    type: 'search',
    placeholder: 'Search templates and blocks',
    value: state.query,
    'aria-label': 'Search the library',
  }) as HTMLInputElement;
  search.addEventListener('input', () => {
    state.query = search.value;
    persist();
    // Only the list changes; a full re-render would take the caret with it.
    paintBody();
  });

  const searchRow = el('div', { class: 'stk-search' }, [search]);
  searchRow.append(filterButton());
  // Beside the funnel, same 24px button, same pressed treatment: both are
  // "change what this list shows", and they belong to the search row rather
  // than to either section.
  searchRow.append(sortButton());

  const children: HTMLElement[] = [searchRow];

  children.push(el('div', { class: 'stk-body', role: 'tree' }));
  root.replaceChildren(...children);
  paintBody();

  // Keep the caret where it was — the search box is the only thing here that
  // holds a cursor, and re-rendering must not steal it.
  if (state.query.length > 0 && document.activeElement === document.body) {
    search.focus();
    search.setSelectionRange(state.query.length, state.query.length);
  }
}

function paintBody(): void {
  const body = root.querySelector('.stk-body');
  if (!body) return;

  // Only truly empty when there is neither library. With a global one there is
  // still a library to show, so the old "open a folder" wall would be wrong.
  if (!state.hasWorkspace && !state.hasGlobal) {
    body.replaceChildren(
      el('div', { class: 'stk-empty' }, [
        el('div', { text: 'Open a folder — Struktek keeps its library inside your workspace.' }),
      ]),
    );
    return;
  }

  const nodes: HTMLElement[] = [];
  const templates = ordered(state.templates.filter(templateMatches), (row) => row.name);

  nodes.push(
    sectionTitle('Templates', templates.length, state.openTemplates, () => {
      state.openTemplates = !state.openTemplates;
      persist();
      render();
    }, [
      action('add', 'New template', () => post({ type: 'newTemplate' })),
    ]),
  );
  if (state.openTemplates) {
    if (state.templates.length === 0) {
      nodes.push(
        el('div', { class: 'stk-empty' }, [
          el('div', {
            text: state.hasWorkspace
              ? 'No templates yet. Struktek keeps them in .struktek/templates, or in your global library for every workspace.'
              : 'No templates yet. With no folder open these go to your global library, ~/.struktek/templates.',
          }),
          on(el('button', { text: 'Create Starter Templates' }), 'click', () =>
            post({ type: 'seedLibrary' }),
          ),
          on(el('button', { class: 'stk-ghost', text: 'New Blank Template' }), 'click', () =>
            post({ type: 'newTemplate' }),
          ),
        ]),
      );
    } else if (templates.length === 0) {
      nodes.push(el('div', { class: 'stk-none', text: 'No template matches.' }));
    } else {
      for (const row of templates) nodes.push(templateRowNode(row));
    }
  }

  const groups = state.blockTypes
    .map((group) => ({ group, instances: visibleInstances(group) }))
    .filter(({ group, instances }) => typeNameMatches(group.type) || instances.length > 0);

  nodes.push(
    sectionTitle('Blocks', groups.length, state.openBlocks, () => {
      state.openBlocks = !state.openBlocks;
      persist();
      render();
    }, [
      action('add', 'New block', () => post({ type: 'newBlock' })),
    ]),
  );
  if (state.openBlocks) {
    if (state.blockTypes.length === 0) {
      nodes.push(
        el('div', { class: 'stk-empty' }, [
          el('div', {
            text: 'Blocks are field types you define. A folder under .struktek/blocks is a type; the files in it are its values.',
          }),
          on(el('button', { text: 'New Block' }), 'click', () => post({ type: 'newBlock' })),
        ]),
      );
    } else if (groups.length === 0) {
      nodes.push(el('div', { class: 'stk-none', text: 'No block matches.' }));
    } else {
      for (const { group, instances } of groups) nodes.push(...blockTypeRowNode(group, instances));
    }
  }

  body.replaceChildren(...nodes);
}

// ── keyboard ──────────────────────────────────────────────────────────

/**
 * Up/down across the rows, Enter to activate.
 *
 * A tree gives this for free; a frame pretending to be one has to earn it, and
 * a list you cannot leave the mouse for is not a replacement.
 */
document.addEventListener('keydown', (event) => {
  // A menu owns the keyboard while it is up — belt and braces beside the
  // capture-phase handler that already stops these.
  if (menuIsOpen()) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.stk-row'));
  if (rows.length === 0) return;

  const current = rows.findIndex((row) => row.dataset['id'] === state.active);
  if (event.key === 'Enter') {
    if (current >= 0 && document.activeElement !== document.body) return;
    rows[current >= 0 ? current : 0]?.click();
    event.preventDefault();
    return;
  }

  const next =
    event.key === 'ArrowDown'
      ? Math.min(rows.length - 1, current + 1)
      : Math.max(0, current <= 0 ? 0 : current - 1);
  const target = rows[next];
  if (!target) return;
  state.active = target.dataset['id'];
  for (const row of rows) row.classList.toggle('stk-active', row === target);
  target.scrollIntoView({ block: 'nearest' });
  event.preventDefault();
});

window.addEventListener('message', (event: MessageEvent<SidebarHostMessage>) => {
  const message = event.data;
  if (message.type !== 'library') return;
  state.templates = message.templates;
  state.blockTypes = message.blockTypes;
  state.allTags = message.tags;
  state.hasWorkspace = message.hasWorkspace;
  state.hasGlobal = message.hasGlobal;

  // Drop filters for tags that no longer exist, or the list silently hides
  // everything with no way to tell why.
  for (const tag of [...state.activeTags]) {
    if (!message.tags.includes(tag)) state.activeTags.delete(tag);
  }
  // A type seen for the first time starts collapsed, matching a tree.
  render();
});

render();
post({ type: 'ready' });
