/**
 * Every prompt you have actually generated, kept.
 *
 * This is the product's promise taken literally. Counting uses tells you a
 * template is popular; keeping the rendered text tells you what you said, and
 * lets you send it again without reconstructing the inputs from memory.
 *
 * JSONL rather than a JSON document: entries are never edited, and a truncated
 * write costs the last line instead of the whole file. It lives in `.runtime/`
 * — self-ignoring — because a prompt can carry anything you happened to be
 * working on, and that is not something to put in someone's commits by default.
 *
 * The whole file is rewritten on each record rather than appended to. Appending
 * sounds cheaper but needed a read-modify-write per entry, which is quadratic
 * over a session; the list is capped, so writing all of it is a small, bounded
 * cost paid a few times a minute at most.
 */

import * as vscode from 'vscode';
import { log } from './log';

export interface HistoryEntry {
  /** Stable per entry, so a UI can key rows without an index. */
  readonly id: string;
  readonly template: string;
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly values: Readonly<Record<string, string>>;
  readonly prompt: string;
  /** Where it went, when we know — 'chat', 'clipboard', 'editor', 'mcp'. */
  readonly via?: string;
}

const FILENAME = 'history.jsonl';
const DEFAULT_LIMIT = 500;

export class History {
  private entries: HistoryEntry[] = [];
  private writing: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly runtimeDir: vscode.Uri,
    private readonly limit: number = DEFAULT_LIMIT,
  ) {}

  private get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.runtimeDir, FILENAME);
  }

  async load(): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.file);
      const lines = Buffer.from(raw).toString('utf8').split(/\r?\n/);
      const parsed: HistoryEntry[] = [];
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          // A hand-mangled or half-written line is skipped, not fatal — the
          // rest of the history is still perfectly good.
          if (entry.id && entry.template && entry.at) parsed.push(entry);
        } catch {
          continue;
        }
      }
      this.entries = parsed.slice(-this.limit);
    } catch {
      // Absent is the normal first-run state.
    }
  }

  /** Newest first — every consumer wants recency. */
  all(): readonly HistoryEntry[] {
    return [...this.entries].reverse();
  }

  for(template: string): readonly HistoryEntry[] {
    return this.all().filter((entry) => entry.template === template);
  }

  count(template: string): number {
    return this.entries.reduce((total, entry) => total + (entry.template === template ? 1 : 0), 0);
  }

  lastUsed(template: string): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry?.template === template) return entry.at;
    }
    return undefined;
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  record(
    template: string,
    values: Readonly<Record<string, string | undefined>>,
    prompt: string,
    via?: string,
  ): HistoryEntry {
    const clean: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      if (value !== undefined && value.length > 0) clean[field] = value;
    }

    this.counter += 1;
    const entry: HistoryEntry = {
      // Time plus a counter: two composes in the same millisecond still differ,
      // and the id stays sortable and readable in the raw file.
      id: Date.now().toString(36) + '-' + this.counter.toString(36),
      template,
      at: new Date().toISOString(),
      values: clean,
      prompt,
      ...(via ? { via } : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    this.schedule(() => this.save());
    return entry;
  }

  async clear(template?: string): Promise<void> {
    this.entries = template ? this.entries.filter((entry) => entry.template !== template) : [];
    await this.save();
  }

  /** Await every pending write. For shutdown and for deterministic tests. */
  flush(): Promise<void> {
    return this.writing;
  }

  /**
   * Writes are chained, never awaited by the composer.
   *
   * Recording is bookkeeping; making someone wait on a disk write — or lose a
   * composed prompt because one failed — would be the wrong trade.
   */
  private schedule(work: () => Promise<void>): void {
    this.writing = this.writing.then(work).catch(() => undefined);
  }

  private async save(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.runtimeDir);
      const body = this.entries.map((entry) => JSON.stringify(entry)).join('\n');
      await vscode.workspace.fs.writeFile(
        this.file,
        Buffer.from(body.length > 0 ? body + '\n' : '', 'utf8'),
      );
    } catch (err) {
      log.warn('Could not persist history', { error: String(err) });
    }
  }
}
