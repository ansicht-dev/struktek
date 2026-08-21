/**
 * History spec.
 *
 * The product's promise is "never forget a good prompt", so the things worth
 * pinning are that a recorded prompt survives a reload, that the file cannot
 * grow without bound, and that one corrupt line does not take the rest of the
 * history with it.
 *
 * Runs against a real temp directory through the `vscode.workspace.fs` mock —
 * the point is the file actually round-trips.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Field } from '../../core';
import { blockRefs, History } from '../../host/history';

let dir: string;
let runtime: vscode.Uri;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'struktek-history-'));
  runtime = vscode.Uri.file(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});



describe('recording', () => {
  it('keeps the rendered prompt, the values, and when', async () => {
    const history = new History(runtime);
    const entry = history.record('code-review', { target: 'a.ts' }, 'Review a.ts.', 'chat');

    expect(entry.template).toBe('code-review');
    expect(entry.prompt).toBe('Review a.ts.');
    expect(entry.values).toEqual({ target: 'a.ts' });
    expect(entry.via).toBe('chat');
    expect(Date.parse(entry.at)).not.toBeNaN();
  });

  it('drops blank values so a skipped optional does not look answered', () => {
    const history = new History(runtime);
    const entry = history.record('t', { a: 'x', b: undefined, c: '' }, 'p');
    expect(entry.values).toEqual({ a: 'x' });
  });

  it('gives entries distinct ids even within the same millisecond', () => {
    const history = new History(runtime);
    const ids = new Set([
      history.record('t', {}, 'one').id,
      history.record('t', {}, 'two').id,
      history.record('t', {}, 'three').id,
    ]);
    expect(ids.size).toBe(3);
  });

  it('returns newest first', () => {
    const history = new History(runtime);
    history.record('t', {}, 'first');
    history.record('t', {}, 'second');
    expect(history.all().map((e) => e.prompt)).toEqual(['second', 'first']);
  });

  it('reports counts and last-used per template', () => {
    const history = new History(runtime);
    history.record('a', {}, 'one');
    history.record('b', {}, 'two');
    history.record('a', {}, 'three');

    expect(history.count('a')).toBe(2);
    expect(history.count('b')).toBe(1);
    expect(history.count('never')).toBe(0);
    expect(history.lastUsed('a')).toBeDefined();
    expect(history.lastUsed('never')).toBeUndefined();
    expect(history.for('a').map((e) => e.prompt)).toEqual(['three', 'one']);
  });
});

describe('persistence', () => {
  it('survives a reload', async () => {
    const first = new History(runtime);
    first.record('code-review', { target: 'a.ts' }, 'Review a.ts.', 'chat');
    await first.flush();

    const second = new History(runtime);
    await second.load();
    expect(second.all()).toHaveLength(1);
    expect(second.all()[0]!.prompt).toBe('Review a.ts.');
  });

  it('skips a corrupt line instead of losing the file', async () => {
    const history = new History(runtime);
    history.record('t', {}, 'good one');
    await history.flush();
    // A half-written line is exactly what a crash mid-append leaves behind.
    const file = path.join(dir, 'history.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')) + '{"id":"x","tem\n');

    const reloaded = new History(runtime);
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(1);
    expect(reloaded.all()[0]!.prompt).toBe('good one');
  });

  it('trims to the limit on disk, not just in memory', async () => {
    const history = new History(runtime, 3);
    for (let i = 0; i < 6; i++) history.record('t', {}, 'prompt ' + String(i));
    await history.flush();

    expect(history.all()).toHaveLength(3);

    const reloaded = new History(runtime, 3);
    await reloaded.load();
    expect(reloaded.all().map((e) => e.prompt)).toEqual(['prompt 5', 'prompt 4', 'prompt 3']);
  });

  it('starts empty when there is no file', async () => {
    const history = new History(runtime);
    await history.load();
    expect(history.all()).toEqual([]);
  });
});

describe('deleting one entry', () => {
  it('removes that entry and keeps the rest, on disk too', async () => {
    const history = new History(runtime);
    const first = history.record('a', {}, 'keep me');
    const second = history.record('a', {}, 'remove me');
    await history.flush();

    expect(await history.remove(second.id)).toBe(true);
    expect(history.all().map((e) => e.prompt)).toEqual(['keep me']);
    expect(history.get(second.id)).toBeUndefined();
    expect(history.get(first.id)).toBeDefined();

    const reloaded = new History(runtime);
    await reloaded.load();
    expect(reloaded.all().map((e) => e.prompt)).toEqual(['keep me']);
  });

  /**
   * The frame holds a snapshot, so the row it asks about may already be gone.
   * That has to be a no-op the caller can recognise rather than a throw.
   */
  it('says so when the id is not there, and touches nothing', async () => {
    const history = new History(runtime);
    history.record('a', {}, 'keep me');
    await history.flush();

    expect(await history.remove('no-such-id')).toBe(false);
    expect(history.all().map((e) => e.prompt)).toEqual(['keep me']);
  });
});

describe('clearing', () => {
  it('clears one template and leaves the others', async () => {
    const history = new History(runtime);
    history.record('a', {}, 'keep me');
    history.record('b', {}, 'remove me');
    await history.flush();

    await history.clear('b');
    expect(history.all().map((e) => e.prompt)).toEqual(['keep me']);

    const reloaded = new History(runtime);
    await reloaded.load();
    expect(reloaded.all().map((e) => e.prompt)).toEqual(['keep me']);
  });

  it('clears everything when no template is named', async () => {
    const history = new History(runtime);
    history.record('a', {}, 'one');
    history.record('b', {}, 'two');
    await history.flush();

    await history.clear();
    expect(history.all()).toEqual([]);

    const reloaded = new History(runtime);
    await reloaded.load();
    expect(reloaded.all()).toEqual([]);
  });
});

describe('blocks', () => {
  const fields: Field[] = [
    { name: 'target', type: { kind: 'file' }, required: true, span: { start: 0, end: 0 } },
    { name: 'depth', type: { kind: 'blockType', name: 'depth' }, required: true, span: { start: 0, end: 0 } },
    {
      name: 'format',
      type: { kind: 'blockType', name: 'output-format' },
      pin: 'prose',
      required: false,
      span: { start: 0, end: 0 },
    },
  ];

  it('projects block-typed values onto the blocks they selected', () => {
    expect(blockRefs(fields, { target: 'a.ts', depth: 'thorough', format: 'json-strict' })).toEqual([
      { type: 'depth', instance: 'thorough' },
      { type: 'output-format', instance: 'json-strict' },
    ]);
  });

  it('falls back to the pin, which is what actually rendered', () => {
    expect(blockRefs(fields, { depth: 'quick' })).toEqual([
      { type: 'depth', instance: 'quick' },
      { type: 'output-format', instance: 'prose' },
    ]);
  });

  it('skips a block field left blank with no pin behind it', () => {
    expect(blockRefs([fields[1]!], {})).toEqual([]);
    expect(blockRefs([fields[1]!], { depth: '' })).toEqual([]);
  });

  it('round-trips through the file', async () => {
    const history = new History(runtime);
    history.record('code-review', { depth: 'thorough' }, 'go deep', 'chat', [
      { type: 'depth', instance: 'thorough' },
    ]);
    await history.flush();

    const reloaded = new History(runtime);
    await reloaded.load();
    expect(reloaded.all()[0]?.blocks).toEqual([{ type: 'depth', instance: 'thorough' }]);
  });

  it('omits the field entirely rather than writing an empty list', async () => {
    const history = new History(runtime);
    history.record('code-review', {}, 'plain', 'chat', []);
    await history.flush();
    const line = (await readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim();
    expect(JSON.parse(line)).not.toHaveProperty('blocks');
  });

  it('still reads an entry written before blocks were kept', async () => {
    // Every line already in someone's history.jsonl looks like this one.
    const legacy = {
      id: 'abc-1',
      template: 'code-review',
      at: '2026-01-01T00:00:00.000Z',
      values: { depth: 'thorough' },
      prompt: 'go deep',
    };
    await writeFile(path.join(dir, 'history.jsonl'), JSON.stringify(legacy) + '\n');

    const history = new History(runtime);
    await history.load();
    const entry = history.all()[0];
    expect(entry?.blocks).toBeUndefined();
    // The panel reconstructs them from the template it still has.
    expect(blockRefs(fields, entry?.values ?? {})).toEqual([
      { type: 'depth', instance: 'thorough' },
      { type: 'output-format', instance: 'prose' },
    ]);
  });
});
