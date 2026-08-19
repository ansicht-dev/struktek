/**
 * The panel wire protocol.
 *
 * Two discriminated unions and the serialisable shapes they carry. Maps are
 * flattened to records because `postMessage` structured-clones through JSON.
 *
 * The webview receives the parsed NODES, not just the text, so it can run the
 * renderer itself and preview on every keystroke without a round-trip. That is
 * the whole reason `core/` imports nothing: the same parser runs in the
 * extension host, the MCP bridge, and this browser frame.
 */

import type { Field, Node } from '../core';

/** Block type name to instance name to body. `Map` does not survive postMessage. */
export type BlockBodies = Record<string, Record<string, string>>;

/** One row in the library list. */
export interface LibraryCard {
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly uses: number;
  /** ISO 8601, or absent if never composed. */
  readonly lastUsed?: string;
  readonly historyCount: number;
  readonly fieldCount: number;
  readonly errorCount: number;
}

/** One block a prompt drew on, as the feed shows it. */
export interface BlockRef {
  readonly type: string;
  readonly instance: string;
}

export interface HistoryRow {
  readonly id: string;
  readonly at: string;
  readonly values: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly via?: string;
  readonly blocks: readonly BlockRef[];
}

/**
 * A row in the panel-wide feed.
 *
 * `HistoryRow` is scoped to one template and needs no name; the feed spans all
 * of them, so it carries the template it came from, that template's tags for
 * filtering, and whether the template is still there — a run outlives the
 * template it was made from, and "create a variant" has nowhere to go once it
 * does not.
 */
export interface HistoryFeedRow extends HistoryRow {
  readonly template: string;
  readonly tags: readonly string[];
  readonly templateExists: boolean;
}

/** Everything the compose screen needs, in one message. */
export interface TemplateDetail {
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly fields: readonly Field[];
  readonly nodes: readonly Node[];
  readonly blocks: BlockBodies;
  /** Instance names per block type, in library order. */
  readonly blockNames: Record<string, readonly string[]>;
  /** Last-used value per field. */
  readonly sticky: Readonly<Record<string, string>>;
  /**
   * Values to start from, beating `sticky`. Set when a run is being varied.
   *
   * `seedId` is what makes it land: the frame keeps values across refreshes of
   * the same template, so a new seed has to be distinguishable from the same
   * template arriving again.
   */
  readonly seed?: Readonly<Record<string, string>>;
  readonly seedId?: string;
  readonly history: readonly HistoryRow[];
  readonly uses: number;
  readonly diagnostics: readonly { message: string; severity: string }[];
  /** Workspace files, for `file` fields. Active editor first. */
  readonly files: readonly string[];
}

export type HostMessage =
  | { readonly type: 'library'; readonly cards: readonly LibraryCard[]; readonly tags: readonly string[] }
  | {
      readonly type: 'history';
      readonly rows: readonly HistoryFeedRow[];
      readonly templates: readonly string[];
      readonly tags: readonly string[];
    }
  | { readonly type: 'template'; readonly detail: TemplateDetail }
  | { readonly type: 'notice'; readonly text: string; readonly kind: 'info' | 'warn' };

export type Delivery = 'chat' | 'clipboard' | 'editor' | 'insert';

export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'openLibrary' }
  | { readonly type: 'openHistory' }
  | { readonly type: 'variant'; readonly id: string }
  | { readonly type: 'clearAllHistory' }
  | { readonly type: 'openTemplate'; readonly name: string }
  | { readonly type: 'newTemplate' }
  | { readonly type: 'editTemplate'; readonly name: string }
  | {
      readonly type: 'deliver';
      readonly name: string;
      readonly values: Readonly<Record<string, string>>;
      readonly prompt: string;
      readonly via: Delivery;
    }
  | { readonly type: 'clearHistory'; readonly name: string }
  | { readonly type: 'copyHistory'; readonly id: string };
