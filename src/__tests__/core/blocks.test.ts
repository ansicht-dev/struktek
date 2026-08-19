/**
 * Blocks began as bare bodies and most still are.
 *
 * The header is a late addition, so the load-bearing property is not that it
 * parses — it is that adding the feature changed nothing for every block that
 * predates it. These tests pin the split from both sides: what a header does,
 * and what its absence must keep doing.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadBlocks, mapBlockReader, readBlockFile } from '../../core';

const HEADED = [
  '---',
  'title: Thorough',
  'description: Follow the call sites',
  'tags: [careful, slow]',
  'note: Costs more tokens than quick',
  '---',
  'deep — read the surrounding code.',
  '',
].join('\n');

const BARE = 'shallow — flag anything obvious and stop.\n';

describe('readBlockFile', () => {
  it('keeps a header out of the body', () => {
    const file = readBlockFile(HEADED, parseYaml);
    expect(file.body).toBe('deep — read the surrounding code.\n');
    expect(file.body).not.toContain('---');
    expect(file.body).not.toContain('Thorough');
  });

  it('reads every key the tooltip shows', () => {
    const { meta } = readBlockFile(HEADED, parseYaml);
    expect(meta).toEqual({
      title: 'Thorough',
      description: 'Follow the call sites',
      tags: ['careful', 'slow'],
      note: 'Costs more tokens than quick',
    });
  });

  it('leaves a block with no header exactly as it was', () => {
    const file = readBlockFile(BARE, parseYaml);
    expect(file.body).toBe(BARE);
    expect(file.meta).toBeUndefined();
  });

  it('does not touch a fence that is not the first thing in the file', () => {
    const source = 'Reply as a table.\n\n---\n\nThen explain it.\n';
    expect(readBlockFile(source, parseYaml).body).toBe(source);
  });

  it('accepts tags as a comma-separated string, like a template', () => {
    const source = '---\ntags: careful, Slow, careful\n---\nbody\n';
    expect(readBlockFile(source, parseYaml).meta?.tags).toEqual(['careful', 'slow']);
  });

  it('falls back to `name` when there is no `title`', () => {
    expect(readBlockFile('---\nname: Quick\n---\nbody\n', parseYaml).meta?.title).toBe('Quick');
  });

  it('degrades a malformed header to no header rather than losing the block', () => {
    const source = '---\ntitle: [unclosed\n---\nthe body still matters\n';
    const file = readBlockFile(source, parseYaml);
    expect(file.body).toBe('the body still matters\n');
    expect(file.meta).toBeUndefined();
  });

  it('reports no header at all when every key is empty', () => {
    expect(readBlockFile('---\ntitle: \n---\nbody\n', parseYaml).meta).toBeUndefined();
  });

  it('leaves the header in place when no YAML parser is supplied', () => {
    // Callers that only render never need the header, and must not pay to parse
    // it — but they still get the body, stripped.
    const file = readBlockFile(HEADED);
    expect(file.body).toBe('deep — read the surrounding code.\n');
    expect(file.meta).toBeUndefined();
  });
});

describe('loadBlocks', () => {
  const reader = mapBlockReader({
    depth: { thorough: HEADED, quick: BARE },
    'output-format': { prose: 'Answer in prose.\n' },
  });

  it('renders bodies without headers and keeps meta beside them', async () => {
    const library = await loadBlocks(reader, { parseYaml });
    expect(library.bodies.get('depth')?.get('thorough')).toBe('deep — read the surrounding code.\n');
    expect(library.bodies.get('depth')?.get('quick')).toBe(BARE);
    expect(library.meta.get('depth')?.get('thorough')?.title).toBe('Thorough');
    expect(library.meta.get('depth')?.has('quick')).toBe(false);
  });

  it('lists every instance whether or not it has a header', async () => {
    const library = await loadBlocks(reader, { parseYaml });
    expect(library.names.get('depth')).toEqual(['thorough', 'quick']);
    expect(library.names.get('output-format')).toEqual(['prose']);
  });

  it('still strips headers when no parser is supplied', async () => {
    // The bodies must not depend on whether the caller cares about metadata,
    // or the same block would render two different ways.
    const library = await loadBlocks(reader);
    expect(library.bodies.get('depth')?.get('thorough')).toBe('deep — read the surrounding code.\n');
    expect(library.meta.get('depth')?.size).toBe(0);
  });
});
