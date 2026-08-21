/**
 * Two libraries, one vocabulary.
 *
 * The merge is the whole contract of the global library: which value a template
 * actually renders when both scopes define the same name, and — just as
 * load-bearing — that a type defined in only one of them is usable from both.
 * Every consumer folds the two the same way (the extension host, the offline
 * bridge), so these tests pin the rule once rather than per reader.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  EMPTY_BLOCK_LIBRARY,
  loadBlocks,
  mapBlockReader,
  mergeBlockLibraries,
  type BlockLibrary,
  type LibraryScope,
} from '../../core';

async function library(
  source: Readonly<Record<string, Readonly<Record<string, string>>>>,
  scope: LibraryScope,
): Promise<BlockLibrary> {
  return loadBlocks(mapBlockReader(source), { parseYaml, scope });
}

const GLOBAL = {
  depth: {
    thorough: '---\ndescription: the global one\n---\nglobal thorough\n',
    quick: 'global quick\n',
  },
  tone: { blunt: 'global blunt\n' },
};

const WORKSPACE = {
  depth: { thorough: 'workspace thorough\n' },
  audience: { juniors: 'workspace juniors\n' },
};

describe('mergeBlockLibraries', () => {
  it('unions the types, so a globally-defined type is usable here', async () => {
    const merged = mergeBlockLibraries(
      await library(GLOBAL, 'global'),
      await library(WORKSPACE, 'workspace'),
    );
    expect([...merged.library.names.keys()].sort()).toEqual(['audience', 'depth', 'tone']);
  });

  it('lets the workspace win a name collision', async () => {
    const merged = mergeBlockLibraries(
      await library(GLOBAL, 'global'),
      await library(WORKSPACE, 'workspace'),
    );
    expect(merged.library.bodies.get('depth')?.get('thorough')).toBe('workspace thorough\n');
    expect(merged.library.scopes.get('depth')?.get('thorough')).toBe('workspace');
  });

  it('keeps the global values the workspace does not override', async () => {
    const merged = mergeBlockLibraries(
      await library(GLOBAL, 'global'),
      await library(WORKSPACE, 'workspace'),
    );
    expect(merged.library.bodies.get('depth')?.get('quick')).toBe('global quick\n');
    expect(merged.library.scopes.get('depth')?.get('quick')).toBe('global');
  });

  it('reports what it hid, with that copy\'s own body', async () => {
    const merged = mergeBlockLibraries(
      await library(GLOBAL, 'global'),
      await library(WORKSPACE, 'workspace'),
    );
    expect(merged.shadowed).toEqual([
      {
        type: 'depth',
        instance: 'thorough',
        scope: 'global',
        body: 'global thorough\n',
        meta: { description: 'the global one', tags: [] },
      },
    ]);
  });

  it('does not leave the winner wearing the loser\'s header', async () => {
    // The global copy has a description and the workspace one has none. A
    // spread-merge would leave the workspace value describing itself with text
    // from a file it has nothing to do with.
    const merged = mergeBlockLibraries(
      await library(GLOBAL, 'global'),
      await library(WORKSPACE, 'workspace'),
    );
    expect(merged.library.meta.get('depth')?.get('thorough')).toBeUndefined();
  });

  it('is the identity on a single library, object and all', async () => {
    const only = await library(WORKSPACE, 'workspace');
    const merged = mergeBlockLibraries(EMPTY_BLOCK_LIBRARY, only);
    expect(merged.library).toBe(only);
    expect(merged.shadowed).toEqual([]);
  });

  it('is empty when both are', () => {
    const merged = mergeBlockLibraries(EMPTY_BLOCK_LIBRARY, EMPTY_BLOCK_LIBRARY);
    expect(merged.library.names.size).toBe(0);
    expect(merged.shadowed).toEqual([]);
  });

  it('records no scope when the loader did not supply one', async () => {
    // Every existing caller that only renders passes no scope, and must keep
    // working — provenance is for the UI, not for rendering.
    const plain = await loadBlocks(mapBlockReader(WORKSPACE), { parseYaml });
    expect(plain.scopes.get('depth')?.size).toBe(0);
    expect(plain.bodies.get('depth')?.get('thorough')).toBe('workspace thorough\n');
  });
});
