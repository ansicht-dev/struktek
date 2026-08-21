/**
 * The sidebar wire protocol.
 *
 * The whole activity-bar view is one webview, so that it can put a search box
 * above its section headers the way the Extensions view does — a view VS Code
 * contributes to a container always gets its own collapsible header, and there
 * is no API to take it away. One view means no header but our own.
 *
 * The frame therefore owns rendering and filtering, and the host owns the
 * library and every action that touches disk. What crosses is a flat snapshot:
 * already-resolved rows with everything a row or its hover needs, so the frame
 * never has to ask a follow-up question to paint.
 */

import type { LibraryScope } from '../core';

export type { SortField, SortDirection, SortOrder } from './sort';

/** A diagnostic, reduced to what a hover shows. */
export interface Problem {
  readonly message: string;
  readonly severity: "error" | "warning";
}

/**
 * What every row says about where it lives.
 *
 * Shared by templates and blocks because the distinction is the same one, and
 * the frame draws the same badge from it either way.
 */
export interface ScopeInfo {
  readonly scope: LibraryScope;
  /**
   * True for a row that exists but does not resolve — a workspace copy of the
   * same name is what actually renders.
   *
   * Shown rather than hidden. A global template silently overridden by a local
   * one is the single most confusing thing two libraries can do, and the row
   * saying so is the cheapest possible answer.
   */
  readonly shadowed?: boolean;
}

export interface TemplateRow extends ScopeInfo {
  readonly name: string;
  readonly description?: string;
  readonly note?: string;
  readonly tags: readonly string[];
  /** A sort key, never rendered. See `SortKey`. */
  readonly uses: number;
  /** Epoch milliseconds, 0 when unknown. A sort key, never rendered. */
  readonly created: number;
  readonly errors: number;
  /**
   * What is wrong with the template, if anything.
   *
   * The only thing a hover says beyond describing the template. Its fields are
   * the composer's business — the hover is for deciding whether this is the
   * template you want, and a field list answers a question you have not asked
   * yet.
   */
  readonly problems: readonly Problem[];
}

export interface BlockRow extends ScopeInfo {
  readonly type: string;
  readonly instance: string;
  /** From the header, when it says something the filename does not. */
  readonly title?: string;
  /** The header's description, else the body's first line. */
  readonly description?: string;
  readonly note?: string;
  readonly tags: readonly string[];
  /** Epoch milliseconds, 0 when unknown. A sort key, never rendered. */
  readonly created: number;
}

export interface BlockTypeRow {
  readonly type: string;
  readonly instances: readonly BlockRow[];
  /**
   * The type's own scope, derived from its values.
   *
   * `global` only when every value is: a type with even one workspace value is
   * partly local, and calling it global would make the badge a lie about what
   * another workspace would see.
   */
  readonly scope: LibraryScope;
}

export type SidebarHostMessage = {
  readonly type: 'library';
  readonly templates: readonly TemplateRow[];
  readonly blockTypes: readonly BlockTypeRow[];
  /** Every tag in the library, for the funnel. */
  readonly tags: readonly string[];
  /** False when no folder is open — the frame says so instead of looking empty. */
  readonly hasWorkspace: boolean;
  /** False when the global library is switched off — moving into it is hidden. */
  readonly hasGlobal: boolean;
};

/**
 * Messages that name a file carry the scope of the row they came from.
 *
 * Without it the host resolves by name and gets whichever copy WINS the merge,
 * which for an overridden row is the wrong file — harmless for "open", and a
 * deleted-the-wrong-template for "delete".
 */
export type SidebarMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'showTemplate'; readonly name: string }
  | { readonly type: 'openTemplate'; readonly name: string; readonly scope?: LibraryScope }
  | { readonly type: 'deleteTemplate'; readonly name: string; readonly scope?: LibraryScope }
  | { readonly type: 'newTemplate' }
  | { readonly type: 'newBlock'; readonly blockType?: string }
  | {
      readonly type: 'openBlock';
      readonly blockType: string;
      readonly instance: string;
      readonly scope?: LibraryScope;
    }
  | {
      readonly type: 'deleteBlock';
      readonly blockType: string;
      readonly instance: string;
      readonly scope?: LibraryScope;
    }
  | { readonly type: 'deleteBlockType'; readonly blockType: string; readonly scope?: LibraryScope }
  /**
   * Move a row into the other library.
   *
   * One message for all three row kinds, carrying the destination rather than a
   * direction, so the frame never has to work out what "promote" means for the
   * row it is looking at.
   */
  | {
      readonly type: 'setScope';
      readonly to: LibraryScope;
      readonly target:
        | { readonly kind: 'template'; readonly name: string }
        | { readonly kind: 'block'; readonly blockType: string; readonly instance: string }
        | { readonly kind: 'blockType'; readonly blockType: string };
    }
  | { readonly type: 'seedLibrary' };
