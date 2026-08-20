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

/** A diagnostic, reduced to what a hover shows. */
export interface Problem {
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface TemplateRow {
  readonly name: string;
  readonly description?: string;
  readonly note?: string;
  readonly tags: readonly string[];
  readonly uses: number;
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

export interface BlockRow {
  readonly type: string;
  readonly instance: string;
  /** From the header, when it says something the filename does not. */
  readonly title?: string;
  /** The header's description, else the body's first line. */
  readonly description?: string;
  readonly note?: string;
  readonly tags: readonly string[];
}

export interface BlockTypeRow {
  readonly type: string;
  readonly instances: readonly BlockRow[];
}

export type SidebarHostMessage = {
  readonly type: 'library';
  readonly templates: readonly TemplateRow[];
  readonly blockTypes: readonly BlockTypeRow[];
  /** Every tag in the library, for the funnel. */
  readonly tags: readonly string[];
  /** False when no folder is open — the frame says so instead of looking empty. */
  readonly hasWorkspace: boolean;
};

export type SidebarMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'showTemplate'; readonly name: string }
  | { readonly type: 'openTemplate'; readonly name: string }
  | { readonly type: 'deleteTemplate'; readonly name: string }
  | { readonly type: 'newTemplate' }
  | { readonly type: 'newBlock'; readonly blockType?: string }
  | { readonly type: 'openBlock'; readonly blockType: string; readonly instance: string }
  | { readonly type: 'deleteBlock'; readonly blockType: string; readonly instance: string }
  | { readonly type: 'deleteBlockType'; readonly blockType: string }
  | { readonly type: 'seedLibrary' };
