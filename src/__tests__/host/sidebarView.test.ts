/**
 * What the sidebar frame is handed.
 *
 * The frame draws the rows, so everything a row and its hover can say has to
 * already be in the snapshot — there is no second call to fill a gap. These
 * tests pin the shape of that snapshot, and in particular the fallbacks: a
 * block with no header still has to describe itself, and a template with a
 * broken field still has to be listed rather than hidden.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadBlocks, loadTemplate, mapBlockReader, type LibraryScope } from '../../core';
import type { Library } from '../../host/library';
import { blockRow, templateRow } from '../../host/sidebarView';

const BLOCK_SOURCES = {
  depth: {
    thorough: [
      '---',
      'title: Thorough',
      'description: Follow the call sites',
      'tags: [careful]',
      'note: Costs more tokens',
      '---',
      'deep — read the surrounding code.',
      '',
    ].join('\n'),
    quick: 'shallow — flag anything obvious and stop.\n',
    named: '---\ntitle: named\n---\nbody\n',
    blank: '\n',
  },
};

async function library(scope: LibraryScope = 'workspace'): Promise<Library> {
  const blocks = await loadBlocks(mapBlockReader(BLOCK_SOURCES), { parseYaml, scope });
  return {
    blocks,
    scopeOfBlock: (type: string, instance: string) => blocks.scopes.get(type)?.get(instance),
    // Times come from `stat`, which a map-backed reader has none of. Zero is
    // what the real loader records for a file the filesystem would not date.
    createdAtBlock: () => 0,
  } as unknown as Library;
}

const load = (source: string, name = 'fixture') =>
  loadTemplate(source, { name, parseYaml, blockTypes: new Map([['depth', ['thorough']]]) });

describe('templateRow', () => {
  it('carries description, tags and note through', () => {
    const model = load(
      '---\ndescription: Review a file\ntags: [review]\nnote: code you own\n---\nbody {{ a }}',
    );
    const row = templateRow(model, 3, 'workspace');
    expect(row).toMatchObject({
      description: 'Review a file',
      tags: ['review'],
      note: 'code you own',
      uses: 3,
    });
  });

  it('omits absent prose rather than sending empty strings', () => {
    const row = templateRow(load('body {{ a }}'), 0, 'workspace');
    expect(row.description).toBeUndefined();
    expect(row.note).toBeUndefined();
    expect(row.tags).toEqual([]);
  });

  it('counts errors and passes the messages on', () => {
    // A broken template still lists — you cannot fix what the view hides.
    const row = templateRow(load('{{ a: nosuchtype }}'), 0, 'workspace');
    expect(row.errors).toBe(1);
    expect(row.problems[0]?.message).toContain('Unknown type');
    expect(row.problems[0]?.severity).toBe('error');
  });

  it('keeps warnings out of the error count but still reports them', () => {
    // The hover marks the two differently, so the severity has to survive the
    // trip rather than being flattened into a string.
    const row = templateRow(load('unmatched [ bracket {{ a }}'), 0, 'workspace');
    expect(row.errors).toBe(0);
    expect(row.problems).toEqual([
      { message: expect.stringContaining('Unmatched'), severity: 'warning' },
    ]);
  });
});

describe('blockRow', () => {
  it('reads the header when there is one', async () => {
    expect(blockRow(await library(), 'depth', 'thorough')).toEqual({
      type: 'depth',
      instance: 'thorough',
      title: 'Thorough',
      description: 'Follow the call sites',
      note: 'Costs more tokens',
      tags: ['careful'],
      created: 0,
      scope: 'workspace',
    });
  });

  it('falls back to the body first line, which is what the block will say', async () => {
    expect(blockRow(await library(), 'depth', 'quick')).toEqual({
      type: 'depth',
      instance: 'quick',
      description: 'shallow — flag anything obvious and stop.',
      tags: [],
      created: 0,
      scope: 'workspace',
    });
  });

  it('drops a title that only repeats the filename', async () => {
    // The row shows the title beside the name; repeating it would be noise.
    expect(blockRow(await library(), 'depth', 'named').title).toBeUndefined();
  });

  it('describes an empty block as nothing rather than as an empty string', async () => {
    const row = blockRow(await library(), 'depth', 'blank');
    expect(row.description).toBeUndefined();
  });

  it('survives a block that is not there', async () => {
    const row = blockRow(await library(), 'depth', 'missing');
    // No instance, so no scope to report — the row falls back to the library
    // it was asked about rather than claiming to be global.
    expect(row).toEqual({
      type: 'depth',
      instance: 'missing',
      tags: [],
      created: 0,
      scope: 'workspace',
    });
  });
});
