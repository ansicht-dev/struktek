/**
 * Usage counts and sticky field values.
 *
 * Two jobs, both about removing friction on the SECOND use of a template:
 * ordering the picker by what you actually reach for, and pre-filling each field
 * with what you chose last time. Most of the cost of a form is re-entering what
 * you always enter.
 *
 * Stored as JSON under the library's `.runtime/` directory rather than in
 * `workspaceState` so it is inspectable, survives a workspace-state reset, and
 * sits next to the other per-session runtime files. `.runtime/` is self-ignoring,
 * so none of this reaches the user's commits.
 */

import * as vscode from 'vscode';
import { log } from './log';

/** What we remember about one template. */
interface TemplateStats {
  uses: number;
  lastUsed: string;
  /** Field name to the value chosen last time. */
  sticky: Record<string, string>;
}

interface StatsDocument {
  schema: number;
  templates: Record<string, TemplateStats>;
}

const SCHEMA = 1;
const FILENAME = 'stats.json';

export class Stats {
  private document: StatsDocument = { schema: SCHEMA, templates: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly runtimeDir: vscode.Uri) {}

  private get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.runtimeDir, FILENAME);
  }

  async load(): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.file);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as StatsDocument;
      // A schema bump discards rather than migrates: these are conveniences,
      // and losing them costs one re-typed field, not any real work.
      if (parsed.schema === SCHEMA && parsed.templates) this.document = parsed;
    } catch {
      // Absent or unreadable is the normal first-run state.
    }
  }

  /** Descending use count; templates never used sort last, alphabetically. */
  order(names: readonly string[]): string[] {
    return [...names].sort((a, b) => {
      const byUse = (this.document.templates[b]?.uses ?? 0) - (this.document.templates[a]?.uses ?? 0);
      return byUse !== 0 ? byUse : a.localeCompare(b);
    });
  }

  uses(template: string): number {
    return this.document.templates[template]?.uses ?? 0;
  }

  sticky(template: string, field: string): string | undefined {
    return this.document.templates[template]?.sticky[field];
  }

  /** Record one composition: bump the count and remember the values used. */
  record(template: string, values: Readonly<Record<string, string | undefined>>): void {
    const entry = (this.document.templates[template] ??= { uses: 0, lastUsed: '', sticky: {} });
    entry.uses += 1;
    entry.lastUsed = new Date().toISOString();
    for (const [field, value] of Object.entries(values)) {
      if (value !== undefined && value.length > 0) entry.sticky[field] = value;
    }
    this.scheduleSave();
  }

  /**
   * Writes are chained rather than awaited by the caller.
   *
   * Composing is interactive and stats are a convenience; making the user wait
   * on a disk write — or lose the composed prompt because one failed — would be
   * the wrong trade. Chaining keeps concurrent records from interleaving.
   */
  private scheduleSave(): void {
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
  }

  private async save(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.runtimeDir);
      const body = Buffer.from(JSON.stringify(this.document, null, 2) + '\n', 'utf8');
      await vscode.workspace.fs.writeFile(this.file, body);
    } catch (err) {
      log.warn('Could not persist stats', { error: String(err) });
    }
  }
}
