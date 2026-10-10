import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { listSecretIds } from '../../../src/config/keystore';
import {
  GitAccountStore,
  hostStorePaths,
  normalizeBaseUrl,
  tokenRefFor,
} from '../../../src/git/accounts';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStore() {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-accounts-'));
  cleanups.push(rootDir);
  const file = resolveAppPaths({ rootDir, profile: 'claude' }).gitAccountsFile;
  const storePaths = hostStorePaths(rootDir);
  const store = new GitAccountStore(file, storePaths);
  await store.load();
  return { rootDir, file, storePaths, store };
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and allows an empty base only for "other"', () => {
    expect(normalizeBaseUrl('github', 'https://api.github.com/')).toBe('https://api.github.com');
    expect(normalizeBaseUrl('other', '  ')).toBe('');
    expect(() => normalizeBaseUrl('gitlab', '')).toThrow(/不能为空/);
    expect(() => normalizeBaseUrl('gitea', 'gitlab.com')).toThrow(/http/);
  });
});

describe('GitAccountStore', () => {
  it('creates an account with a generated id and stores the token as a secret', async () => {
    const { store } = await makeStore();
    const created = await store.upsert({
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    expect(created.id).toMatch(/^gh-[0-9a-f]{8}$/);
    expect(created.tokenRef).toBe(tokenRefFor(created.id));
    expect(await store.getToken(created.id)).toBe('ghp_secret');
    expect(await store.hasToken(created.id)).toBe(true);
  });

  it('preserves the stored token when an update omits it', async () => {
    const { store } = await makeStore();
    const created = await store.upsert({
      label: 'GH',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const updated = await store.upsert({
      id: created.id,
      label: 'GH renamed',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: '',
    });
    expect(updated).toMatchObject({ id: created.id, label: 'GH renamed' });
    expect(await store.getToken(created.id)).toBe('ghp_secret');
  });

  it('removes the account and its secret', async () => {
    const { store, storePaths } = await makeStore();
    const created = await store.upsert({
      label: 'Gitea',
      provider: 'gitea',
      baseUrl: 'https://gitea.com/',
      token: 't',
    });
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
    expect(await listSecretIds(storePaths)).not.toContain(tokenRefFor(created.id));
    expect(store.list()).toHaveLength(0);
  });

  it('reloads persisted accounts from disk', async () => {
    const { store, file, storePaths } = await makeStore();
    await store.upsert({
      label: 'GitLab',
      provider: 'gitlab',
      baseUrl: 'https://gitlab.com',
      username: 'me',
      token: 't',
    });
    await store.flush();

    const reloaded = new GitAccountStore(file, storePaths);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({
      label: 'GitLab',
      provider: 'gitlab',
      username: 'me',
      baseUrl: 'https://gitlab.com',
    });
  });

  it('rejects an unknown provider and a blank label', async () => {
    const { store } = await makeStore();
    await expect(
      store.upsert({ label: 'X', provider: 'bitbucket' as never, baseUrl: 'https://x', token: '' }),
    ).rejects.toThrow(/平台/);
    await expect(
      store.upsert({ label: '  ', provider: 'github', baseUrl: 'https://api.github.com', token: '' }),
    ).rejects.toThrow(/名称/);
  });
});
