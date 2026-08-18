/**
 * The Struktek panel: library, compose-with-preview, and history.
 *
 * The preview updates on every keystroke by running the REAL renderer here in
 * the frame — `core/` imports nothing, so the same code that produces the
 * prompt for an agent produces the one you are looking at. No round-trip to the
 * host, and no second implementation to drift.
 *
 * DOM is built with `textContent`, never `innerHTML`: everything on screen is
 * text the user wrote, and a template containing markup should render as
 * characters rather than as elements.
 */

import { render, type Field, type Node } from '../src/core';
import type {
  BlockBodies,
  Delivery,
  HistoryRow,
  HostMessage,
  LibraryCard,
  TemplateDetail,
  WebviewMessage,
} from '../src/shared/panelProtocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

interface State {
  view: 'library' | 'template';
  cards: readonly LibraryCard[];
  allTags: readonly string[];
  search: string;
  activeTags: Set<string>;
  detail?: TemplateDetail;
  values: Record<string, string>;
  expanded: Set<string>;
}

const state: State = {
  view: 'library',
  cards: [],
  allTags: [],
  search: '',
  activeTags: new Set(),
  values: {},
  expanded: new Set(),
};

// ── tiny DOM helpers ──────────────────────────────────────────────────

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

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

/**
 * Relative time, because "3 hours ago" answers the question and a timestamp
 * makes you do arithmetic. The exact time stays in the `title` attribute.
 */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  if (days < 31) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function firstLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

function typeLabel(field: Field): string {
  const type = field.type;
  if (type.kind === 'choice') return 'choice';
  if (type.kind === 'blockType') return type.name;
  return type.kind;
}

// ── rendering the prompt ──────────────────────────────────────────────

function blocksToMap(blocks: BlockBodies): Map<string, Map<string, string>> {
  const outer = new Map<string, Map<string, string>>();
  for (const [type, instances] of Object.entries(blocks)) {
    outer.set(type, new Map(Object.entries(instances)));
  }
  return outer;
}

function compose(detail: TemplateDetail, values: Record<string, string>) {
  return render(detail.nodes as Node[], {
    values,
    fields: detail.fields,
    blocks: blocksToMap(detail.blocks),
  });
}

// ── library view ──────────────────────────────────────────────────────

function visibleCards(): readonly LibraryCard[] {
  const needle = state.search.trim().toLowerCase();
  return state.cards.filter((card) => {
    if (state.activeTags.size > 0 && !card.tags.some((tag) => state.activeTags.has(tag))) return false;
    if (needle.length === 0) return true;
    return (
      card.name.toLowerCase().includes(needle) ||
      (card.description ?? '').toLowerCase().includes(needle) ||
      card.tags.some((tag) => tag.includes(needle))
    );
  });
}

function renderLibrary(): void {
  const bar = el('div', { class: 'stk-bar' }, [
    el('div', {}, [
      el('h1', { class: 'stk-title', text: 'Templates' }),
      el('p', {
        class: 'stk-sub',
        text:
          state.cards.length === 0
            ? 'Nothing here yet.'
            : String(state.cards.length) + ' template' + (state.cards.length === 1 ? '' : 's'),
      }),
    ]),
    el('div', { class: 'stk-spacer' }),
    on(el('button', { text: 'New Template' }), 'click', () => post({ type: 'newTemplate' })),
  ]);

  const search = el('input', {
    type: 'search',
    placeholder: 'Search name, description or tag',
    value: state.search,
  }) as HTMLInputElement;
  on(search, 'input', () => {
    state.search = search.value;
    // Only the grid changes; re-rendering the whole view would steal focus
    // mid-keystroke.
    grid.replaceChildren(...cards());
  });

  const filters = el('div', { class: 'stk-filters' }, [search]);
  for (const tag of state.allTags) {
    const active = state.activeTags.has(tag);
    filters.append(
      on(
        el('button', { class: 'stk-chip', 'aria-pressed': active, text: tag }),
        'click',
        () => {
          if (active) state.activeTags.delete(tag);
          else state.activeTags.add(tag);
          renderLibrary();
        },
      ),
    );
  }

  function cards(): HTMLElement[] {
    const shown = visibleCards();
    if (shown.length === 0) {
      return [
        el('div', { class: 'stk-blank' }, [
          el('p', {
            text:
              state.cards.length === 0
                ? 'No templates yet. Create one and it will show up here.'
                : 'Nothing matches that filter.',
          }),
        ]),
      ];
    }
    return shown.map((card) => {
      const meta: (globalThis.Node | string)[] = [];
      meta.push(el('span', { text: String(card.fieldCount) + ' field' + (card.fieldCount === 1 ? '' : 's') }));
      if (card.uses > 0) meta.push(el('span', { text: String(card.uses) + ' use' + (card.uses === 1 ? '' : 's') }));
      if (card.lastUsed) {
        meta.push(el('span', { text: ago(card.lastUsed), title: new Date(card.lastUsed).toLocaleString() }));
      }
      if (card.errorCount > 0) {
        meta.push(
          el('span', {
            class: 'stk-err',
            text: String(card.errorCount) + ' error' + (card.errorCount === 1 ? '' : 's'),
          }),
        );
      }

      const body: (globalThis.Node | string)[] = [
        el('div', { class: 'stk-card-top' }, [el('span', { class: 'stk-card-name', text: card.name })]),
      ];
      if (card.description) body.push(el('div', { class: 'stk-card-desc', text: card.description }));
      if (card.tags.length > 0) {
        body.push(
          el(
            'div',
            { class: 'stk-tags' },
            card.tags.map((tag) => el('span', { class: 'stk-chip stk-static', text: tag })),
          ),
        );
      }
      body.push(el('div', { class: 'stk-card-meta' }, meta));

      return on(el('button', { class: 'stk-card' }, body), 'click', () =>
        post({ type: 'openTemplate', name: card.name }),
      );
    });
  }

  const grid = el('div', { class: 'stk-grid' }, cards());
  root.replaceChildren(bar, filters, grid);
}

// ── compose view ──────────────────────────────────────────────────────

function renderTemplate(): void {
  const detail = state.detail;
  if (!detail) return;

  const header = el('div', { class: 'stk-bar' }, [
    on(el('button', { class: 'stk-ghost', text: '← Library' }), 'click', () =>
      post({ type: 'openLibrary' }),
    ),
    el('div', {}, [
      el('h1', { class: 'stk-title', text: detail.name }),
      el('p', { class: 'stk-sub', text: detail.description ?? 'No description' }),
    ]),
    el('div', { class: 'stk-spacer' }),
    on(el('button', { class: 'stk-ghost', text: 'Edit template' }), 'click', () =>
      post({ type: 'editTemplate', name: detail.name }),
    ),
  ]);

  const tagRow = el('div', { class: 'stk-tags' }, [
    ...detail.tags.map((tag) => el('span', { class: 'stk-chip stk-static', text: tag })),
  ]);
  if (detail.uses > 0) {
    tagRow.append(
      el('span', {
        class: 'stk-opt',
        text: String(detail.uses) + ' use' + (detail.uses === 1 ? '' : 's'),
      }),
    );
  }

  const preview = el('pre', { class: 'stk-preview' });
  const status = el('span', {});
  const form = el('div', {});

  const refresh = (): void => {
    const result = compose(detail, state.values);
    if (result.text.trim().length === 0) {
      preview.className = 'stk-preview stk-empty-slot';
      preview.textContent = 'Fill a field to see the prompt take shape.';
    } else {
      preview.className = 'stk-preview';
      preview.textContent = result.text;
    }
    const blank = result.unfilled.length;
    status.textContent =
      blank === 0
        ? String(result.text.length) + ' characters'
        : String(blank) + ' field' + (blank === 1 ? '' : 's') + ' blank';
    status.className = blank === 0 ? '' : 'stk-warn';
  };

  for (const field of detail.fields) {
    form.append(fieldControl(detail, field, refresh));
  }
  if (detail.fields.length === 0) {
    form.append(el('p', { class: 'stk-hint', text: 'This template has no fields — it composes as written.' }));
  }

  for (const diagnostic of detail.diagnostics) {
    form.append(
      el('p', {
        class: diagnostic.severity === 'error' ? 'stk-hint stk-err' : 'stk-hint stk-warn',
        text: diagnostic.message,
      }),
    );
  }

  const deliver = (via: Delivery) => () => {
    const result = compose(detail, state.values);
    post({ type: 'deliver', name: detail.name, values: { ...state.values }, prompt: result.text, via });
  };

  const pane = el('div', { class: 'stk-pane' }, [
    el('div', { class: 'stk-pane-head' }, [el('span', { text: 'Preview' }), el('div', { class: 'stk-spacer' }), status]),
    preview,
    el('div', { class: 'stk-actions' }, [
      on(el('button', { text: 'Send to Chat' }), 'click', deliver('chat')),
      on(el('button', { class: 'stk-ghost', text: 'Copy' }), 'click', deliver('clipboard')),
      on(el('button', { class: 'stk-ghost', text: 'Insert' }), 'click', deliver('insert')),
      on(el('button', { class: 'stk-ghost', text: 'Open' }), 'click', deliver('editor')),
    ]),
  ]);

  refresh();
  root.replaceChildren(
    header,
    tagRow,
    el('div', { class: 'stk-split' }, [form, pane]),
    renderHistory(detail),
  );
}

function fieldControl(detail: TemplateDetail, field: Field, refresh: () => void): HTMLElement {
  const label = el('div', { class: 'stk-label' }, [
    el('span', { class: 'stk-name', text: field.name }),
    el('span', { class: 'stk-type', text: typeLabel(field) }),
  ]);
  if (!field.required) label.append(el('span', { class: 'stk-opt', text: 'optional' }));

  const wrap = el('div', { class: 'stk-field' }, [label]);
  const current = state.values[field.name] ?? '';
  const type = field.type;

  let control: HTMLElement;
  if (type.kind === 'choice' || type.kind === 'blockType') {
    const options =
      type.kind === 'choice' ? type.options : (detail.blockNames[type.name] ?? []);
    const select = el('select') as HTMLSelectElement;
    select.append(el('option', { value: '', text: field.required ? 'Choose...' : '(omit)' }));
    for (const option of options) {
      select.append(el('option', { value: option, text: option, selected: option === current }));
    }
    select.value = current;
    on(select, 'change', () => {
      state.values[field.name] = select.value;
      refresh();
    });
    control = select;
    if (type.kind === 'blockType' && options.length === 0) {
      wrap.append(
        el('p', {
          class: 'stk-hint stk-warn',
          text: 'No instances yet — add a file to blocks/' + type.name + '/.',
        }),
      );
    }
  } else if (type.kind === 'block') {
    const area = el('textarea', { rows: 4 }) as HTMLTextAreaElement;
    area.value = current;
    on(area, 'input', () => {
      state.values[field.name] = area.value;
      refresh();
    });
    control = area;
  } else {
    const input = el('input', {
      type: type.kind === 'number' ? 'number' : 'text',
      // A file field offers the workspace, but stays typeable — a path you know
      // is faster than a list you have to scroll.
      list: type.kind === 'file' ? 'stk-files' : undefined,
      placeholder: field.pin ?? '',
    }) as HTMLInputElement;
    input.value = current;
    on(input, 'input', () => {
      state.values[field.name] = input.value;
      refresh();
    });
    control = input;
  }

  wrap.append(control);
  if (field.description) wrap.append(el('p', { class: 'stk-hint', text: field.description }));
  return wrap;
}

function renderHistory(detail: TemplateDetail): HTMLElement {
  const section = el('div', { class: 'stk-section' });
  const head = el('div', { class: 'stk-section-head' }, [
    el('h2', { class: 'stk-h2', text: 'History' }),
    el('span', {
      class: 'stk-opt',
      text:
        detail.history.length === 0
          ? 'nothing yet'
          : String(detail.history.length) + ' generated',
    }),
    el('div', { class: 'stk-spacer' }),
  ]);
  if (detail.history.length > 0) {
    head.append(
      on(el('button', { class: 'stk-ghost', text: 'Clear' }), 'click', () =>
        post({ type: 'clearHistory', name: detail.name }),
      ),
    );
  }
  section.append(head);

  if (detail.history.length === 0) {
    section.append(
      el('p', {
        class: 'stk-hint',
        text: 'Every prompt you generate from this template is kept here, so you can find it again or send it a second time.',
      }),
    );
    return section;
  }

  for (const entry of detail.history) {
    section.append(historyRow(entry));
  }
  return section;
}

function historyRow(entry: HistoryRow): HTMLElement {
  const open = state.expanded.has(entry.id);
  const row = el('div', { class: 'stk-run' });

  const toggle = on(
    el('button', { class: 'stk-run-head' }, [
      el('span', { class: 'stk-when', text: ago(entry.at), title: new Date(entry.at).toLocaleString() }),
      el('span', { class: 'stk-run-line', text: firstLine(entry.prompt) }),
      entry.via ? el('span', { class: 'stk-opt', text: entry.via }) : el('span', {}),
    ]),
    'click',
    () => {
      if (open) state.expanded.delete(entry.id);
      else state.expanded.add(entry.id);
      renderTemplate();
    },
  );
  row.append(toggle);

  if (!open) return row;

  const body = el('div', { class: 'stk-run-body' }, [el('pre', { text: entry.prompt })]);
  const actions = el('div', { class: 'stk-tags' }, [
    on(el('button', { class: 'stk-ghost', text: 'Copy' }), 'click', () =>
      post({ type: 'copyHistory', id: entry.id }),
    ),
    // The reason history is worth keeping: recover the inputs, not just the
    // output, and adjust one of them rather than retyping all of them.
    on(el('button', { class: 'stk-ghost', text: 'Reuse these values' }), 'click', () => {
      state.values = { ...entry.values };
      renderTemplate();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }),
  ]);
  body.append(actions);
  row.append(body);
  return row;
}

// ── host messages ─────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'library') {
    state.view = 'library';
    state.cards = message.cards;
    state.allTags = message.tags;
    // Drop filters for tags that no longer exist, or the list silently hides
    // everything with no way to tell why.
    for (const tag of [...state.activeTags]) {
      if (!message.tags.includes(tag)) state.activeTags.delete(tag);
    }
    renderLibrary();
    return;
  }
  if (message.type === 'template') {
    const detail = message.detail;
    const switching = state.detail?.name !== detail.name;
    state.view = 'template';
    state.detail = detail;
    if (switching) {
      state.expanded.clear();
      // Seed from last-used values, and from any pinned default the author set.
      state.values = {};
      for (const field of detail.fields) {
        const seed = detail.sticky[field.name] ?? field.pin;
        if (seed !== undefined) state.values[field.name] = seed;
      }
    }
    renderFilesDatalist(detail.files);
    renderTemplate();
  }
});

function renderFilesDatalist(files: readonly string[]): void {
  document.getElementById('stk-files')?.remove();
  const list = el('datalist', { id: 'stk-files' });
  for (const file of files) list.append(el('option', { value: file }));
  document.body.append(list);
}

post({ type: 'ready' });
