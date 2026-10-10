import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/git/providers';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

let handle: UiServerHandle;
let rootDir: string;
let base: string;

const supervisor: UiSupervisor = {
  isOnline: () => false,
  controlsFor: () => undefined,
  channelFor: () => undefined,
  list: () => [],
  startProfile: async () => {},
  stopProfile: async () => {},
  restartProfile: async () => {},
};

const fetchImpl: FetchLike = async (input) => {
  const url = String(input);
  const body = url.includes('/branches')
    ? [{ name: 'main' }, { name: 'dev' }]
    : [
        {
          id: 1,
          name: 'api',
          full_name: 'acme/api',
          clone_url: 'https://github.com/acme/api.git',
          ssh_url: 'git@github.com:acme/api.git',
          default_branch: 'main',
          private: true,
        },
      ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-gitroute-'));
  handle = await startUiServer({ supervisor, version: 'test', rootDir, fetchImpl });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function get(path: string) {
  return fetch(`${base}${path}`, { headers: { 'x-ui-token': handle.token } });
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': handle.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function del(path: string) {
  return fetch(`${base}${path}`, { method: 'DELETE', headers: { 'x-ui-token': handle.token } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

describe('git routes', { timeout: 30_000 }, () => {
  it('manages accounts and lists repos/branches without leaking tokens', async () => {
    const created = await json(
      await post('/api/git/accounts', {
        label: 'GitHub',
        provider: 'github',
        baseUrl: 'https://api.github.com',
        username: 'octocat',
        token: 'ghp_secret',
      }),
    );
    expect(created.accounts).toHaveLength(1);
    expect(created.accounts[0].hasToken).toBe(true);
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    const id = created.accounts[0].id;

    const listed = await json(await get('/api/git/accounts'));
    expect(JSON.stringify(listed)).not.toContain('ghp_secret');
    expect(listed.accounts[0].id).toBe(id);

    const tested = await json(
      await post('/api/git/accounts/test', {
        id,
        provider: 'github',
        baseUrl: 'https://api.github.com',
        token: '',
      }),
    );
    expect(tested).toMatchObject({ ok: true, repoCount: 1 });

    const repos = await json(await get(`/api/git/repos?account=${id}`));
    expect(repos.repos[0]).toMatchObject({ fullName: 'acme/api' });

    const branches = await json(
      await get(`/api/git/branches?account=${id}&repo=${encodeURIComponent('acme/api')}`),
    );
    expect(branches.branches).toEqual(['main', 'dev']);

    const removed = await json(await del(`/api/git/accounts?id=${id}`));
    expect(removed.accounts).toHaveLength(0);
  });
});
