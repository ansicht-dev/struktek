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
import { knownSort, orderBy, type SortOrder } from '../src/shared/sort';
import { el, icon, on } from './dom';
import { closeMenu } from './menu';
import { filterButton, sortButton, type FilterSection, type SortSpec } from './toolbar';
import type {
  BlockBodies,
  Delivery,
  HistoryFeedRow,
  HostMessage,
  TemplateDetail,
  WebviewMessage,
} from '../src/shared/panelProtocol';

/**
 * The split position and the feed's order, which are the two choices a repaint
 * must not undo. Everything else arrives fresh from the host.
 */
interface PersistedState {
  readonly splitRatio: number;
  readonly feedSort?: SortOrder;
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
  feedSort: SortOrder;
  /** The seed already applied, so a repaint does not re-apply it. */
  seedId?: string;
}

/**
 * Newest first.
 *
 * A feed is read from the top, and the prompt you want is nearly always the
 * one you produced most recently.
 */
const FEED_SORT: SortOrder = { field: 'date', direction: 'desc' };

/**
 * How the feed can be ordered, and how each way round is worded.
 *
 * Two fields rather than the sidebar's three: `relevance` is a use count per
 * template, which says nothing about one run among many of the same template.
 * `date` is when the prompt was produced and `name` is the template it came
 * from — the two things a row actually carries.
 */
const FEED_SORTS: readonly SortSpec[] = [
  {
    field: 'date',
    label: 'Date',
    directions: [
      { direction: 'desc', label: 'Newest', hint: 'most recently composed first' },
      { direction: 'asc', label: 'Oldest', hint: 'the first prompts you produced' },
    ],
  },
  {
    field: 'name',
    label: 'Template',
    directions: [
      { direction: 'asc', label: 'Alphabetical', hint: 'A to Z, newest within each' },
      { direction: 'desc', label: 'Reverse alphabetical', hint: 'Z to A, newest within each' },
    ],
  },
];

/**
 * Narrow what the frame persisted to an order this screen actually offers.
 *
 * The stored value was written by whichever version of struktek last ran, and
 * the two frames do not offer the same fields — the sidebar can persist
 * `relevance`, which means nothing here. A stale preference degrades to the
 * default rather than leaving the feed in an order with no menu entry.
 */
function knownFeedSort(value: unknown): SortOrder {
  const order = knownSort(value);
  return FEED_SORTS.some((spec) => spec.field === order.field) ? order : FEED_SORT;
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
  feedSort: knownFeedSort(vscode.getState()?.feedSort),
};

/** The split and the feed order are written together; there is only one slot. */
function persist(): void {
  vscode.setState({ splitRatio: state.splitRatio, feedSort: state.feedSort });
}

// ── plumbing ──────────────────────────────────────────────────────────

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
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

/**
 * The rows this screen is showing, narrowed and then ordered.
 *
 * Ordering runs through the same comparator the sidebar uses, over `at` parsed
 * to epoch milliseconds — so "newest" means the same thing on both screens,
 * and an unparseable timestamp sorts oldest rather than jumping to the top.
 */
function visibleRuns(): readonly HistoryFeedRow[] {
  const needle = state.feedSearch.trim().toLowerCase();
  const matching = state.feed.filter((run) => {
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

  const keyed = matching.map((run) => ({ run, created: Date.parse(run.at) || 0 }));
  const ordered = orderBy(keyed, (row) => row.run.template, state.feedSort);
  // Ordered by template, the runs inside one name stay newest-first: the name
  // is the key you chose, and within it recency is still what you want to read
  // first. `orderBy` breaks its ties by name, which for a feed of one template
  // is no tie-break at all.
  if (state.feedSort.field === 'name') {
    const flip = state.feedSort.direction === 'desc' ? -1 : 1;
    ordered.sort(
      (a, b) => a.run.template.localeCompare(b.run.template) * flip || b.created - a.created,
    );
  }
  return ordered.map((row) => row.run);
}

/** What the funnel offers on this screen: the templates, and their tags. */
function feedFilterSections(): readonly FilterSection[] {
  return [
    {
      label: 'Templates',
      empty: 'Nothing composed yet',
      values: state.feedTemplates,
      active: state.feedActiveTemplates,
      toggle: (name) => {
        if (state.feedActiveTemplates.has(name)) state.feedActiveTemplates.delete(name);
        else state.feedActiveTemplates.add(name);
      },
    },
    {
      label: 'Tags',
      empty: 'No tags on these templates',
      values: state.feedTags,
      active: state.feedActiveTags,
      display: (tag) => '#' + tag,
      toggle: (tag) => {
        if (state.feedActiveTags.has(tag)) state.feedActiveTags.delete(tag);
        else state.feedActiveTags.add(tag);
      },
    },
  ];
}

function renderHistoryFeed(): void {
  // A menu is anchored to a button this repaint is about to replace, and an
  // open dialog is about a run the host has just sent a new version of.
  closeMenu();
  closeRunDialog();

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

  // The same pair the sidebar's search box carries, and for the same reasons.
  // The templates and tags this feed can be narrowed by are the user's own
  // words, so the menu has to be drawn rather than contributed — and the row
  // of chips they used to be shoved the whole feed down the page every time
  // you reached for one, on the screen where the list is the entire point.
  const filters = el('div', { class: 'stk-filters' }, [
    search,
    filterButton({
      sections: feedFilterSections,
      onChange: () => list.replaceChildren(...runs()),
      onClear: () => {
        state.feedActiveTemplates.clear();
        state.feedActiveTags.clear();
        renderHistoryFeed();
      },
    }),
    sortButton(FEED_SORTS, state.feedSort, FEED_SORT, (order) => {
      state.feedSort = order;
      persist();
      renderHistoryFeed();
    }),
  ]);

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

/**
 * One run, as a card you can click.
 *
 * The prompt used to expand in place: the excerpt was a button, and opening it
 * grew the card inside a list of cards, so everything below jumped. It also had
 * to look pressable, which meant a second highlighted surface inside a card
 * that is already a surface. The whole card is the target now, and the prompt
 * opens in a dialog over the feed instead of inside it — the list never moves,
 * and there is room to actually read the thing.
 *
 * The buttons and the reference chips inside stop the click from reaching the
 * card, so pressing Copy copies rather than opening a dialog about copying.
 */
function runCard(run: HistoryFeedRow): HTMLElement {
  const card = el(
    'div',
    {
      class: 'stk-run-card',
      role: 'button',
      tabindex: 0,
      'aria-label': 'Open the prompt composed from ' + run.template,
    },
    [runHead(run), el('p', { class: 'stk-excerpt', text: firstLine(run.prompt, 260) }), runRefs(run)],
  );
  card.append(
    el('div', { class: 'stk-run-actions' }, [
      inCard(iconButton('copy', 'Copy prompt', () => post({ type: 'copyHistory', id: run.id }))),
      inCard(variantButton(run)),
      el('div', { class: 'stk-spacer' }),
      // Removing one row is not the same act as clearing the feed: the two
      // Clear buttons throw away work you cannot see from where you are
      // standing and ask first, while this row is right in front of you and
      // says what it is. A modal here would make tidying the feed a chore.
      inCard(
        iconButton('trash', 'Delete this prompt', () => post({ type: 'deleteHistory', id: run.id })),
      ),
    ]),
  );

  on(card, 'click', () => {
    // Dragging across the excerpt to copy a phrase ends in a click on the
    // card, and opening a dialog on top of the text you were reading is not
    // what that gesture meant.
    if ((window.getSelection()?.toString() ?? '').length > 0) return;
    showRun(run);
  });
  on(card, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    // A div with role=button has to earn the two keys a real button gets.
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    showRun(run);
  });
  return card;
}

/** Anything inside a clickable card that is itself clickable. */
function inCard<T extends HTMLElement>(node: T): T {
  return on(node, 'click', (event) => event.stopPropagation());
}

function runHead(run: HistoryFeedRow): HTMLElement {
  const head = el('div', { class: 'stk-run-top' }, [
    el('span', { class: 'stk-run-name', text: run.template }),
    el('span', { class: 'stk-when', text: ago(run.at), title: run.at }),
  ]);
  if (run.via) head.append(el('span', { class: 'stk-chip stk-static', text: run.via }));
  if (!run.templateExists) {
    head.append(el('span', { class: 'stk-chip stk-static stk-warn', text: 'template deleted' }));
  }
  return head;
}

/**
 * What the prompt was made from, as links to the files themselves.
 *
 * This is the thing a prompt cannot tell you by reading it, and until now it
 * was the thing you then had to go and find by hand. The template opens in the
 * composer, a block opens its file — each chip goes where you would have gone.
 *
 * A template that has been deleted stays a plain chip: the run still records
 * what it was made from, and there is no longer anywhere for it to lead.
 */
function runRefs(run: HistoryFeedRow): HTMLElement {
  const refs = el('div', { class: 'stk-ref' }, [
    run.templateExists
      ? inCard(
          on(
            el('button', {
              class: 'stk-chip stk-path',
              type: 'button',
              title: 'Open ' + run.template + ' in the composer',
              text: run.template,
            }),
            'click',
            () => post({ type: 'openTemplate', name: run.template }),
          ),
        )
      : el('span', { class: 'stk-chip stk-static stk-path', text: run.template }),
  ]);
  for (const block of run.blocks) {
    const name = block.type + '/' + block.instance;
    refs.append(
      inCard(
        on(
          el('button', {
            class: 'stk-chip stk-path',
            type: 'button',
            title: 'Open ' + name,
            text: name,
          }),
          'click',
          () => post({ type: 'openBlockFile', blockType: block.type, instance: block.instance }),
        ),
      ),
    );
  }
  return refs;
}

/**
 * `git-branch` rather than a stack of versions: varying a run is branching off
 * it, and a version stack said "this prompt has revisions", which is the one
 * thing a history entry never has — it is what was sent, once.
 */
function variantButton(run: HistoryFeedRow, label?: string): HTMLElement {
  return on(
    el(
      'button',
      {
        class: label ? 'stk-ghost stk-primary' : 'stk-icon-button',
        disabled: !run.templateExists,
        'aria-label': 'Create variant',
        title: run.templateExists
          ? 'Create variant - open the composer with these values'
          : 'The template this came from no longer exists',
      },
      label ? [icon('git-branch'), el('span', { text: label })] : [icon('git-branch')],
    ),
    'click',
    () => post({ type: 'variant', id: run.id }),
  );
}

// ── one run, in full ──────────────────────────────────────────────────

/**
 * The whole prompt, over the feed rather than inside it.
 *
 * A real `<dialog>`, opened modally, because the browser already implements
 * the parts a hand-rolled overlay gets wrong: Escape, the focus trap, making
 * the page behind it inert, and a backdrop that is one element rather than a
 * stack of z-indexes. What is left to write is what is IN it.
 */
let runDialog: HTMLDialogElement | undefined;

function closeRunDialog(): void {
  runDialog?.close();
  runDialog = undefined;
}

function showRun(run: HistoryFeedRow): void {
  closeRunDialog();

  const head = el('div', { class: 'stk-dialog-head' }, [
    el('h2', { class: 'stk-dialog-title', text: run.template }),
    el('span', { class: 'stk-when', text: ago(run.at), title: run.at }),
  ]);
  if (run.via) head.append(el('span', { class: 'stk-chip stk-static', text: run.via }));
  if (!run.templateExists) {
    head.append(el('span', { class: 'stk-chip stk-static stk-warn', text: 'template deleted' }));
  }
  head.append(el('div', { class: 'stk-spacer' }));
  head.append(iconButton('close', 'Close', closeRunDialog));

  const dialog = el('dialog', {
    class: 'stk-dialog',
    'aria-label': 'Prompt composed from ' + run.template,
  }) as HTMLDialogElement;

  dialog.append(head, runRefs(run));

  // The values it was filled with. The prompt says what was asked; these say
  // what you would be changing if you varied it, which the prose can bury.
  const filled = Object.entries(run.values);
  if (filled.length > 0) {
    const values = el('dl', { class: 'stk-dialog-values' });
    for (const [field, value] of filled) {
      values.append(el('dt', { text: field }), el('dd', { text: value }));
    }
    dialog.append(values);
  }

  dialog.append(el('pre', { class: 'stk-dialog-prompt', text: run.prompt }));
  dialog.append(
    el('div', { class: 'stk-dialog-actions' }, [
      on(
        el('button', { class: 'stk-primary' }, [icon('copy'), el('span', { text: 'Copy prompt' })]),
        'click',
        () => post({ type: 'copyHistory', id: run.id }),
      ),
      on(variantButton(run, 'Create variant'), 'click', closeRunDialog),
      el('div', { class: 'stk-spacer' }),
      iconButton('trash', 'Delete this prompt', () => {
        closeRunDialog();
        post({ type: 'deleteHistory', id: run.id });
      }),
    ]),
  );

  // A click that lands on the dialog element itself came down on the backdrop,
  // since every child fills the box. Escape is the browser's already.
  on(dialog, 'click', (event) => {
    if (event.target === dialog) closeRunDialog();
  });
  on(dialog, 'close', () => {
    dialog.remove();
    if (runDialog === dialog) runDialog = undefined;
  });

  document.body.append(dialog);
  runDialog = dialog;
  dialog.showModal();
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
  // Varying a run leaves the composer on screen; its dialog must not float
  // over the form it just filled in.
  closeRunDialog();

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
    // Wrapped, so the chevron the stylesheet draws has something to sit in -
    // the platform's own arrows are the one part of a select no theme reaches.
    control = el('span', { class: 'stk-select' }, [select, icon('chevron-down')]);
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
