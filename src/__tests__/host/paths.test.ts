/**
 * Where the global library lands.
 *
 * One resolver, used by the extension host reading the setting and by the
 * standalone bridge with no setting to read. If the two ever disagreed, the
 * editor and the offline agent would serve different templates under the same
 * names — the one failure mode a second library really can introduce, so the
 * rule is pinned here rather than in either caller.
 */

import { describe, expect, it } from 'vitest';
import { globalLibraryPath } from '../../host/paths';

const HOME = '/home/dev';

describe('globalLibraryPath', () => {
  it('defaults to .struktek under the home directory', () => {
    expect(globalLibraryPath(undefined, HOME)).toBe('/home/dev/.struktek');
    expect(globalLibraryPath('', HOME)).toBe('/home/dev/.struktek');
    expect(globalLibraryPath('   ', HOME)).toBe('/home/dev/.struktek');
  });

  it('expands a leading tilde, the notation the setting is described with', () => {
    expect(globalLibraryPath('~/prompts', HOME)).toBe('/home/dev/prompts');
    expect(globalLibraryPath('~/nested/prompts', HOME)).toBe('/home/dev/nested/prompts');
    expect(globalLibraryPath('~', HOME)).toBe(HOME);
  });

  it('takes an absolute path as written, on either platform', () => {
    expect(globalLibraryPath('/srv/prompts', HOME)).toBe('/srv/prompts');
    expect(globalLibraryPath('C:\\prompts', HOME)).toBe('C:\\prompts');
    expect(globalLibraryPath('\\\\share\\prompts', HOME)).toBe('\\\\share\\prompts');
  });

  it('refuses a relative path rather than resolving it against the CWD', () => {
    // This root belongs to no project, so there is no honest base — and
    // quietly picking one would put the library somewhere unfindable.
    expect(globalLibraryPath('prompts', HOME)).toBeUndefined();
    expect(globalLibraryPath('./prompts', HOME)).toBeUndefined();
    expect(globalLibraryPath('../prompts', HOME)).toBeUndefined();
  });

  it('has no answer without a home directory, rather than inventing one', () => {
    // Some containers run homeless. Better no global library than one written
    // to a path the user never chose.
    expect(globalLibraryPath(undefined, undefined)).toBeUndefined();
    expect(globalLibraryPath('~/prompts', undefined)).toBeUndefined();
    // An absolute path needs no home, so it still resolves.
    expect(globalLibraryPath('/srv/prompts', undefined)).toBe('/srv/prompts');
  });

  it('does not double a separator on a home path that ends in one', () => {
    expect(globalLibraryPath(undefined, '/home/dev/')).toBe('/home/dev/.struktek');
    expect(globalLibraryPath(undefined, 'C:\\Users\\dev\\')).toBe('C:\\Users\\dev\\.struktek');
  });

  it('keeps backslashes on a Windows home', () => {
    expect(globalLibraryPath(undefined, 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\.struktek');
    expect(globalLibraryPath('~/prompts', 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\prompts');
  });
});
