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
  readonly openTemplates: boolean;
  readonly openBlocks: boolean;
  readonly openTypes: readonly string[];
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

const restored = vscode.getState();

const state = {
  templates: [] as readonly TemplateRow[],
  blockTypes: [] as readonly BlockTypeRow[],
  allTags: [] as readonly string[],
  hasWorkspace: true,
  query: restored?.query ?? '',
  activeTags: new Set<string>(restored?.tags ?? []),
  chipsOpen: (restored?.tags ?? []).length > 0,
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

/**
 * A type survives if it matches itself or holds anything that does — and a type
 * that matched on its own name shows everything inside it, since narrowing its
 * children would hide the thing that answered the query.
 */
function visibleInstances(group: BlockTypeRow): readonly BlockRow[] {
  if (typeNameMatches(group.type)) return group.instances;
  return group.instances.filter((row) => matchesFilter(blockFilterable(row), filter()));
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
  parts.push(el('div', { class: 'stk-hover-rule' }));
  parts.push(
    el('div', {
      class: 'stk-hover-fields',
      text:
        row.fields.length === 0
          ? 'No fields — composes as written.'
          : 'fields: ' + row.fields.map((field) => field.name + ':' + field.type).join(', '),
    }),
  );
  for (const problem of row.problems) {
    parts.push(el('div', { class: 'stk-hover-line stk-err', text: problem }));
  }
  return el('div', { class: 'stk-hover' }, parts);
}

function blockHover(row: BlockRow): HTMLElement {
  const parts = hoverHead(row.title ?? row.instance, row.description, row.tags, row.note);
  parts.push(el('div', { class: 'stk-hover-rule' }));
  parts.push(el('div', { class: 'stk-hover-fields', text: 'type: ' + row.type }));
  return el('div', { class: 'stk-hover' }, parts);
}

function blockTypeHover(group: BlockTypeRow): HTMLElement {
  const parts = hoverHead(
    group.type,
    'A field type of your own — any template can ask for a ' + group.type + '.',
    [],
    undefined,
  );
  parts.push(el('div', { class: 'stk-hover-rule' }));
  parts.push(
    el('div', {
      class: 'stk-hover-fields',
      text:
        group.instances.length > 0
          ? 'values: ' + group.instances.map((row) => row.instance).join(', ')
          : 'No values yet — add a file under blocks/' + group.type + '/.',
    }),
  );
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
  },
  activate: () => void,
): HTMLElement {
  const row = el('div', {
    class: 'stk-row' + (opts.indent ? ' stk-indent' : '') + (state.active === id ? ' stk-active' : ''),
    role: 'treeitem',
    tabindex: -1,
    'data-id': id,
  });
  // A tree row is twistie, then icon, then label — and a leaf still reserves
  // the twistie column so its label lines up with its siblings'.
  row.append(
    opts.twistie ? icon(opts.twistie, 'stk-twistie') : el('span', { class: 'stk-twistie' }),
    icon(opts.icon, 'stk-icon' + (opts.danger ? ' stk-err' : '')),
    el('span', { class: 'stk-row-name', text: opts.label }),
  );
  if (opts.note) row.append(el('span', { class: 'stk-row-note', text: opts.note }));
  row.addEventListener('click', () => {
    state.active = id;
    activate();
  });
  return row;
}

function templateRowNode(row: TemplateRow): HTMLElement {
  const note = [
    row.uses > 0 ? String(row.uses) + '×' : undefined,
    row.errors > 0 ? String(row.errors) + ' error' + (row.errors === 1 ? '' : 's') : undefined,
  ]
    .filter(Boolean)
    .join('  ');

  // A broken template still lists — you cannot fix what the view hides.
  const node = rowShell(
    'template:' + row.name,
    {
      icon: row.errors > 0 ? 'warning' : 'symbol-snippet',
      label: row.name,
      ...(note ? { note } : {}),
      danger: row.errors > 0,
    },
    () => post({ type: 'showTemplate', name: row.name }),
  );

  node.append(
    el('span', { class: 'stk-row-actions' }, [
      action('play', 'Compose', () => post({ type: 'compose', name: row.name })),
      action('go-to-file', 'Open file', () => post({ type: 'openTemplate', name: row.name })),
      action('trash', 'Delete', () => post({ type: 'deleteTemplate', name: row.name })),
    ]),
  );
  return withHover(node, () => templateHover(row));
}

function blockRowNode(row: BlockRow): HTMLElement {
  const node = rowShell(
    'block:' + row.type + '/' + row.instance,
    {
      icon: 'symbol-text',
      label: row.instance,
      ...(row.title ? { note: row.title } : {}),
      indent: true,
    },
    () => post({ type: 'openBlock', blockType: row.type, instance: row.instance }),
  );
  node.append(
    el('span', { class: 'stk-row-actions' }, [
      action('trash', 'Delete', () =>
        post({ type: 'deleteBlock', blockType: row.type, instance: row.instance }),
      ),
    ]),
  );
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
    },
    () => {
      if (open) state.openTypes.delete(group.type);
      else state.openTypes.add(group.type);
      persist();
      render();
    },
  );
  node.setAttribute('aria-expanded', String(open));
  node.append(
    el('span', { class: 'stk-row-actions' }, [
      action('add', 'New value', () => post({ type: 'newBlock', blockType: group.type })),
      action('trash', 'Delete type', () => post({ type: 'deleteBlockType', blockType: group.type })),
    ]),
  );

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

// ── render ────────────────────────────────────────────────────────────

function render(): void {
  hideHover();

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
  if (state.allTags.length > 0) {
    searchRow.append(
      on(
        el(
          'button',
          {
            class: 'stk-funnel',
            type: 'button',
            title: 'Filter by tag',
            'aria-label': 'Filter by tag',
            'aria-pressed': state.chipsOpen || state.activeTags.size > 0,
          },
          [icon('filter')],
        ),
        'click',
        () => {
          state.chipsOpen = !state.chipsOpen;
          render();
        },
      ),
    );
  }

  const children: HTMLElement[] = [searchRow];

  if (state.chipsOpen || state.activeTags.size > 0) {
    const row = el('div', { class: 'stk-tagrow' });
    for (const tag of state.allTags) {
      const pressed = state.activeTags.has(tag);
      row.append(
        on(el('button', { class: 'stk-chip', type: 'button', 'aria-pressed': pressed, text: tag }), 'click', () => {
          if (pressed) state.activeTags.delete(tag);
          else state.activeTags.add(tag);
          persist();
          render();
        }),
      );
    }
    children.push(row);
  }

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

  if (!state.hasWorkspace) {
    body.replaceChildren(
      el('div', { class: 'stk-empty' }, [
        el('div', { text: 'Open a folder — Struktek keeps its library inside your workspace.' }),
      ]),
    );
    return;
  }

  const nodes: HTMLElement[] = [];
  const templates = state.templates.filter(templateMatches);

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
          el('div', { text: 'No templates yet. Struktek keeps them in .struktek/templates.' }),
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
