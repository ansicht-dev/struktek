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
import { DEFAULT_SORT, knownSort, orderBy, type SortOrder } from '../src/shared/sort';
import { el, icon, on } from './dom';
import { closeMenu, menuIsOpen } from './menu';
import { filterButton, sortButton, type FilterSection, type SortSpec } from './toolbar';
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
const SORTS: readonly SortSpec[] = [
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
 * What the funnel offers: the tags found in this library.
 *
 * One section today. It is a list rather than a single set because the shared
 * widget takes a list, and because the next dimension worth filtering by —
 * scope, say — is an entry here and nothing else.
 */
function filterSections(): readonly FilterSection[] {
  return [
    {
      label: 'Tags',
      empty: 'No tags in this library',
      values: state.allTags,
      active: state.activeTags,
      toggle: (tag) => {
        if (state.activeTags.has(tag)) state.activeTags.delete(tag);
        else state.activeTags.add(tag);
        persist();
      },
    },
  ];
}

function libraryFilterButton(): HTMLElement {
  return filterButton({
    sections: filterSections,
    // The body only. Rebuilding the search row would tear the open menu off
    // the button it is anchored to.
    onChange: paintBody,
    onClear: () => {
      state.activeTags.clear();
      persist();
      render();
    },
  });
}

function librarySortButton(): HTMLElement {
  return sortButton(SORTS, state.sort, DEFAULT_SORT, (order) => {
    state.sort = order;
    persist();
    render();
  });
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
  searchRow.append(libraryFilterButton());
  // Beside the funnel, same 24px button, same pressed treatment: both are
  // "change what this list shows", and they belong to the search row rather
  // than to either section.
  searchRow.append(librarySortButton());

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
