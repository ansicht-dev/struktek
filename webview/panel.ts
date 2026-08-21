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
  HistoryFeedRow,
  HistoryRow,
  HostMessage,
  TemplateDetail,
  WebviewMessage,
} from '../src/shared/panelProtocol';

/** Only the split position is worth keeping; everything else arrives fresh. */
interface PersistedState {
  readonly splitRatio: number;
}

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

interface State {
  view: 'history' | 'template';
  detail?: TemplateDetail;
  values: Record<string, string>;
  /** Whether the optional-field fold is open, remembered across repaints. */
  optionalOpen: boolean;
  /** Fraction of the composer given to the form, 0.25 to 0.75. */
  splitRatio: number;
  /** The feed: every prompt produced, newest first, and its own filters. */
  feed: readonly HistoryFeedRow[];
  feedTemplates: readonly string[];
  feedTags: readonly string[];
  feedSearch: string;
  feedActiveTemplates: Set<string>;
  feedActiveTags: Set<string>;
  /** Which run's full prompt is open, keyed by entry id. */
  feedOpen: Set<string>;
  /** The seed already applied, so a repaint does not re-apply it. */
  seedId?: string;
}

const state: State = {
  view: 'history',
  values: {},
  optionalOpen: false,
  splitRatio: vscode.getState()?.splitRatio ?? 0.45,
  feed: [],
  feedTemplates: [],
  feedTags: [],
  feedSearch: '',
  feedActiveTemplates: new Set(),
  feedActiveTags: new Set(),
  feedOpen: new Set(),
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

/** A codicon, the workbench's own icon font — not a lookalike glyph. */
function icon(name: string): HTMLElement {
  return el('span', { class: 'codicon codicon-' + name, 'aria-hidden': 'true' });
}

/**
 * A secondary action.
 *
 * Icon-only with a tooltip, the way every toolbar in the workbench works. The
 * primary action keeps its label, because guessing which glyph sends your
 * prompt somewhere is not a game worth playing.
 */
function iconButton(name: string, title: string, run: () => void): HTMLElement {
  return on(
    el('button', { class: 'stk-icon-button', title, 'aria-label': title }, [icon(name)]),
    'click',
    run,
  );
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


// ── navigation ────────────────────────────────────────────────────────

/**
 * Where the panel is, always visible.
 *
 * Compose is disabled rather than hidden when nothing is selected: a control
 * that appears and disappears as you move around is harder to aim at than one
 * that is simply not available yet.
 */
function nav(): HTMLElement {
  const bar = el('div', { class: 'stk-nav' });
  const items: [State['view'], string, boolean][] = [
    ['template', 'Compose', state.detail !== undefined],
    ['history', 'History', true],
  ];
  for (const [view, label, enabled] of items) {
    const item = el('button', {
      class: 'stk-nav-item' + (state.view === view ? ' stk-nav-on' : ''),
      type: 'button',
      text: label,
      disabled: !enabled,
      'aria-current': state.view === view ? 'page' : undefined,
    });
    on(item, 'click', () => {
      if (view === state.view) return;
      if (view === 'history') post({ type: 'openHistory' });
      else if (state.detail) post({ type: 'openTemplate', name: state.detail.name });
    });
    bar.append(item);
  }
  return bar;
}

// ── history feed ──────────────────────────────────────────────────────

function visibleRuns(): readonly HistoryFeedRow[] {
  const needle = state.feedSearch.trim().toLowerCase();
  return state.feed.filter((run) => {
    if (state.feedActiveTemplates.size > 0 && !state.feedActiveTemplates.has(run.template)) return false;
    if (state.feedActiveTags.size > 0 && !run.tags.some((tag) => state.feedActiveTags.has(tag))) {
      return false;
    }
    if (needle.length === 0) return true;
    // The prompt text is the point of searching a feed: you remember what you
    // asked for, rarely which template you reached for to ask it.
    return (
      run.prompt.toLowerCase().includes(needle) ||
      run.template.toLowerCase().includes(needle) ||
      run.tags.some((tag) => tag.includes(needle)) ||
      Object.values(run.values).some((value) => value.toLowerCase().includes(needle))
    );
  });
}

function renderHistoryFeed(): void {
  const total = state.feed.length;
  const bar = el('div', { class: 'stk-bar' }, [
    el('div', {}, [
      el('h1', { class: 'stk-title', text: 'History' }),
      el('p', {
        class: 'stk-sub',
        text:
          total === 0
            ? 'Nothing composed yet.'
            : String(total) + ' prompt' + (total === 1 ? '' : 's') + ' kept',
      }),
    ]),
    el('div', { class: 'stk-spacer' }),
  ]);
  if (total > 0) {
    // Clear follows the filter. With exactly one template selected it clears
    // that template's runs — the per-template Clear the composer used to
    // carry, without a second button to implement it.
    const only = state.feedActiveTemplates.size === 1 ? [...state.feedActiveTemplates][0] : undefined;
    bar.append(
      iconButton(
        'clear-all',
        only ? 'Clear history for ' + only : 'Clear all history',
        () => post(only ? { type: 'clearHistory', name: only } : { type: 'clearAllHistory' }),
      ),
    );
  }

  const search = el('input', {
    type: 'search',
    placeholder: 'Search the prompts you have produced',
    value: state.feedSearch,
    'aria-label': 'Search history',
  }) as HTMLInputElement;
  on(search, 'input', () => {
    state.feedSearch = search.value;
    // Only the list changes; a full re-render would take the caret with it.
    list.replaceChildren(...runs());
  });

  const filters = el('div', { class: 'stk-filters' }, [search]);
  for (const name of state.feedTemplates) {
    const active = state.feedActiveTemplates.has(name);
    filters.append(
      on(el('button', { class: 'stk-chip', 'aria-pressed': active, text: name }), 'click', () => {
        if (active) state.feedActiveTemplates.delete(name);
        else state.feedActiveTemplates.add(name);
        renderHistoryFeed();
      }),
    );
  }
  for (const tag of state.feedTags) {
    const active = state.feedActiveTags.has(tag);
    filters.append(
      on(
        el('button', { class: 'stk-chip', 'aria-pressed': active, text: '#' + tag }),
        'click',
        () => {
          if (active) state.feedActiveTags.delete(tag);
          else state.feedActiveTags.add(tag);
          renderHistoryFeed();
        },
      ),
    );
  }

  function runs(): HTMLElement[] {
    const shown = visibleRuns();
    if (shown.length === 0) {
      return [
        el('div', { class: 'stk-blank' }, [
          el('p', {
            text:
              total === 0
                ? 'Compose a prompt and it lands here — including the ones your agent composes.'
                : 'No prompt matches that.',
          }),
        ]),
      ];
    }
    return shown.map(runCard);
  }

  const list = el('div', { class: 'stk-feed' }, runs());
  root.replaceChildren(nav(), bar, filters, list);
}

function runCard(run: HistoryFeedRow): HTMLElement {
  const open = state.feedOpen.has(run.id);

  const head = el('div', { class: 'stk-run-top' }, [
    el('span', { class: 'stk-run-name', text: run.template }),
    el('span', { class: 'stk-when', text: ago(run.at), title: run.at }),
  ]);
  if (run.via) head.append(el('span', { class: 'stk-chip stk-static', text: run.via }));
  if (!run.templateExists) {
    head.append(el('span', { class: 'stk-chip stk-static stk-warn', text: 'template deleted' }));
  }

  // What it was made from: the template, then each block it drew on. This is
  // the thing a prompt cannot tell you by reading it.
  const refs = el('div', { class: 'stk-ref' }, [
    el('span', { class: 'stk-chip stk-static', text: run.template }),
  ]);
  for (const block of run.blocks) {
    refs.append(
      el('span', { class: 'stk-chip stk-static', text: block.type + '/' + block.instance }),
    );
  }

  const excerpt = on(
    el('button', {
      class: open ? 'stk-excerpt stk-excerpt-open' : 'stk-excerpt',
      type: 'button',
      title: open ? 'Collapse' : 'Show the whole prompt',
      text: open ? run.prompt : firstLine(run.prompt, 260),
    }),
    'click',
    () => {
      if (open) state.feedOpen.delete(run.id);
      else state.feedOpen.add(run.id);
      renderHistoryFeed();
    },
  );

  const variant = on(
    el(
      'button',
      {
        class: 'stk-icon-button',
        disabled: !run.templateExists,
        'aria-label': 'Create variant',
        title: run.templateExists
          ? 'Create variant - open the composer with these values'
          : 'The template this came from no longer exists',
      },
      [icon('versions')],
    ),
    'click',
    () => post({ type: 'variant', id: run.id }),
  );

  const actions = el('div', { class: 'stk-run-actions' }, [
    iconButton('copy', 'Copy prompt', () => post({ type: 'copyHistory', id: run.id })),
    variant,
  ]);

  return el('div', { class: 'stk-run-card' }, [head, excerpt, refs, actions]);
}

// ── compose view ──────────────────────────────────────────────────────

/**
 * The composer: fields on the left, the prompt as it will be sent on the right.
 *
 * The divider between them is draggable and its position is kept, because how
 * much room a form needs depends on the template and how much room a preview
 * needs depends on the prompt — neither is a number to pick once for everyone.
 */
function renderTemplate(): void {
  const detail = state.detail;
  if (!detail) return;

  const preview = el('pre', { class: 'stk-preview' });
  const status = el('span', { class: 'stk-status' });
  const form = el('div', { class: 'stk-form' });

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
      String(result.text.length) + ' chars' +
      (blank === 0 ? '' : ' \u00b7 ' + String(blank) + ' blank');
    status.className = blank === 0 ? 'stk-status' : 'stk-status stk-warn';
  };

  // Required fields carry the form; optional ones fold away, since a template
  // with two of them should not read as a longer form than it is.
  const required = detail.fields.filter((field) => field.required);
  const optional = detail.fields.filter((field) => !field.required);
  for (const field of required) form.append(fieldControl(detail, field, refresh));

  if (optional.length > 0) {
    // Anything already carrying a value is not hidden — a sticky value or a
    // varied run must never sit silently behind a fold.
    const filled = optional.some((field) => (state.values[field.name] ?? '').length > 0);
    const open = state.optionalOpen || filled;
    const fold = el('details', { class: 'stk-fold', open }) as HTMLDetailsElement;
    fold.append(el('summary', { text: 'Optional (' + String(optional.length) + ')' }));
    for (const field of optional) fold.append(fieldControl(detail, field, refresh));
    on(fold, 'toggle', () => {
      state.optionalOpen = fold.open;
    });
    form.append(fold);
  }

  if (detail.fields.length === 0) {
    form.append(
      el('p', { class: 'stk-hint', text: 'This template has no fields — it composes as written.' }),
    );
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
    el('div', { class: 'stk-pane-head' }, [
      status,
      el('div', { class: 'stk-spacer' }),
      iconButton('copy', 'Copy', deliver('clipboard')),
      iconButton('insert', 'Insert at cursor', deliver('insert')),
      iconButton('go-to-file', 'Open in editor', deliver('editor')),
    ]),
    preview,
    el('div', { class: 'stk-actions' }, [
      // The one button that sends your prompt somewhere keeps its label; an
      // icon alone there would be a guess.
      on(
        el('button', { class: 'stk-primary' }, [icon('send'), el('span', { text: 'Send to Chat' })]),
        'click',
        deliver('chat'),
      ),
      el('div', { class: 'stk-spacer' }),
      iconButton('clear-all', 'Reset fields', () => {
        state.values = {};
        renderTemplate();
      }),
    ]),
  ]);

  refresh();
  root.replaceChildren(nav(), composerHeader(detail), split(form, pane));
}

/** Name, tags, how often it has been used, and the way out to its file. */
function composerHeader(detail: TemplateDetail): HTMLElement {
  const name = on(
    el('button', { class: 'stk-switch', title: 'Switch template' }, [
      el('span', { class: 'stk-title', text: detail.name }),
      icon('chevron-down'),
    ]),
    'click',
    () => post({ type: 'pickTemplate' }),
  );

  const bar = el('div', { class: 'stk-bar' }, [name]);
  // Before the tags, because it is not one: it says which library the file is
  // in, which changes what editing it affects.
  if (detail.scope === 'global') {
    const badge = el(
      'span',
      {
        class: 'stk-chip stk-static stk-scope',
        title: 'From your global library — editing this changes it in every workspace.',
      },
      [icon('globe'), el('span', { text: 'global' })],
    );
    bar.append(badge);
  }
  for (const tag of detail.tags) bar.append(el('span', { class: 'stk-chip stk-static', text: tag }));
  bar.append(el('div', { class: 'stk-spacer' }));

  // A pointer at the history screen, not a copy of it \u2014 and not a scoreboard
  // either. How many times you have composed this is a sort key in the
  // sidebar, not a number worth carrying in the header; WHEN you last did is
  // the part that tells you whether you are repeating yourself.
  if (detail.uses > 0) {
    bar.append(
      on(
        el('button', { class: 'stk-link', title: 'History for this template' }, [
          el('span', { text: detail.lastUsed ? ago(detail.lastUsed) : 'History' }),
          icon('history'),
        ]),
        'click',
        () => post({ type: 'openHistory', template: detail.name }),
      ),
    );
  }
  bar.append(
    iconButton('edit', 'Edit template file', () => post({ type: 'editTemplate', name: detail.name })),
  );

  const head = el('div', { class: 'stk-head' }, [bar]);
  if (detail.description) head.append(el('p', { class: 'stk-sub', text: detail.description }));
  return head;
}

/**
 * Two panes and a divider you can drag.
 *
 * The ratio lives in the frame's state rather than being recomputed, so it
 * survives a repaint — and every repaint is total, since the form is rebuilt
 * whenever a value changes.
 */
function split(left: HTMLElement, right: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'stk-split' });
  const divider = el('div', {
    class: 'stk-divider',
    role: 'separator',
    'aria-orientation': 'vertical',
  });
  left.classList.add('stk-pane-left');
  right.classList.add('stk-pane-right');
  wrap.append(left, divider, right);

  const apply = (): void => {
    left.style.flexBasis = String(state.splitRatio * 100) + '%';
  };
  apply();

  divider.addEventListener('pointerdown', (event) => {
    const start = event as PointerEvent;
    start.preventDefault();
    divider.setPointerCapture(start.pointerId);
    const move = (moved: Event): void => {
      const box = wrap.getBoundingClientRect();
      if (box.width === 0) return;
      // Clamped so neither pane can be dragged out of existence.
      const x = (moved as PointerEvent).clientX;
      state.splitRatio = Math.min(0.75, Math.max(0.25, (x - box.left) / box.width));
      apply();
    };
    const up = (): void => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      vscode.setState({ splitRatio: state.splitRatio });
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  return wrap;
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

// ── host messages ─────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'history') {
    state.view = 'history';
    state.feed = message.rows;
    state.feedTemplates = message.templates;
    state.feedTags = message.tags;
    // Arriving from a template's composer opens the feed already narrowed to it.
    if (message.focus) {
      state.feedActiveTemplates = new Set([message.focus]);
      state.feedSearch = '';
    }
    // Drop filters for things that no longer exist, or the feed silently hides
    // everything with no way to tell why.
    for (const name of [...state.feedActiveTemplates]) {
      if (!message.templates.includes(name)) state.feedActiveTemplates.delete(name);
    }
    for (const tag of [...state.feedActiveTags]) {
      if (!message.tags.includes(tag)) state.feedActiveTags.delete(tag);
    }
    renderHistoryFeed();
    return;
  }
  if (message.type === 'template') {
    const detail = message.detail;
    // A new seed reseeds even for the template already open — that is exactly
    // what varying a run of the template you are looking at has to do.
    const seeded = detail.seedId !== undefined && detail.seedId !== state.seedId;
    const switching = state.detail?.name !== detail.name || seeded;
    state.view = 'template';
    state.detail = detail;
    if (detail.seedId !== undefined) state.seedId = detail.seedId;
    if (switching) {
      state.optionalOpen = false;
      // Seed from the run being varied when there is one, else from last-used
      // values and any pinned default the author set.
      state.values = {};
      for (const field of detail.fields) {
        const seed = detail.seed?.[field.name] ?? detail.sticky[field.name] ?? field.pin;
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
