import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/git/providers';
import { HttpError } from '../../../src/ui/http';
import {
  accountsView,
  branchesView,
  deleteAccount,
  reposView,
  saveAccount,
  testAccount,
} from '../../../src/ui/git-api';

const cleanups: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-gitapi-'));
  cleanups.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('git-api accounts', () => {
  it('creates, lists and removes an account without exposing the token', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    expect(created.accounts).toHaveLength(1);
    expect(created.accounts[0]).toMatchObject({
      label: 'GitHub',
      provider: 'github',
      username: 'octocat',
      hasToken: true,
    });
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    const id = created.accounts[0]!.id;

    const listed = await accountsView(root);
    expect(listed.accounts[0]!.id).toBe(id);
    expect(JSON.stringify(listed)).not.toContain('ghp_secret');

    const removed = await deleteAccount(root, { id });
    expect(removed.accounts).toHaveLength(0);
  });

  it('preserves a stored token when an update omits it', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GH',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const id = created.accounts[0]!.id;
    const updated = await saveAccount(root, {
      id,
      label: 'GH 2',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: '',
    });
    expect(updated.accounts[0]).toMatchObject({ id, label: 'GH 2', hasToken: true });
  });

  it('404s when removing a missing account', async () => {
    const root = await tempRoot();
    await expect(deleteAccount(root, { id: 'gh-missing' })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('git-api provider endpoints', () => {
  it('lists repos and branches and tests the connection with an injected fetch', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    const id = created.accounts[0]!.id;

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/branches')) return ok([{ name: 'main' }, { name: 'dev' }]);
      return ok([
        {
          id: 1,
          name: 'api',
          full_name: 'acme/api',
          clone_url: 'https://github.com/acme/api.git',
          ssh_url: 'git@github.com:acme/api.git',
          default_branch: 'main',
          private: true,
        },
      ]);
    };

    const repos = await reposView(root, { accountId: id }, fetchImpl);
    expect(repos.repos[0]).toMatchObject({ fullName: 'acme/api', defaultBranch: 'main' });

    const branches = await branchesView(root, { accountId: id, repo: 'acme/api' }, fetchImpl);
    expect(branches.branches).toEqual(['main', 'dev']);

    const tested = await testAccount(
      root,
      { id, provider: 'github', baseUrl: 'https://api.github.com', token: '' },
      fetchImpl,
    );
    expect(tested).toMatchObject({ ok: true, username: 'octocat', repoCount: 1 });
  });

  it('maps provider errors to 400 for repo listing', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 't',
    });
    const id = created.accounts[0]!.id;
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 401 });
    await expect(reposView(root, { accountId: id }, fetchImpl)).rejects.toThrow(/令牌无效或权限不足/);
  });
});
