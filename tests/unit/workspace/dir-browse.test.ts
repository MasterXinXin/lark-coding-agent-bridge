import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browseDirectory } from '../../../src/workspace/dir-browse';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it('lists only subdirectories and reports the parent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bridge-browse-'));
  cleanups.push(base);
  await mkdir(join(base, 'alpha'), { recursive: true });
  await mkdir(join(base, 'beta'), { recursive: true });
  await writeFile(join(base, 'readme.txt'), 'x', 'utf8');

  const listing = await browseDirectory(base);
  expect(listing.dirs.map((d) => d.name)).toEqual(['alpha', 'beta']);
  expect(listing.path).toBe(await realpath(base));
  expect(listing.parent).toBeTruthy();
});

it('rejects a missing path', async () => {
  await expect(browseDirectory(join(tmpdir(), 'does-not-exist-xyz'))).rejects.toThrow();
});
