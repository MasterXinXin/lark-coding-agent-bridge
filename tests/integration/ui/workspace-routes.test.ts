import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let handle: UiServerHandle;
let rootDir: string;
let workspace: string;
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

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-wsroute-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
  handle = await startUiServer({ supervisor, version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Real local bare origin with one commit on `main`. */
async function makeOrigin(base: string): Promise<string> {
  const origin = join(base, 'origin.git');
  git(base, ['init', '--bare', origin]);
  const seed = join(base, 'seed');
  git(base, ['clone', origin, seed]);
  git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return origin;
}

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

describe('workspace routes', { timeout: 30_000 }, () => {
  it('browses a directory', async () => {
    const res = await get(`/api/workspace/dir?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.path).toBe(await realpath(workspace));
  });

  it('adds, lists and removes a project', async () => {
    const origin = await makeOrigin(rootDir);
    const added = await json(await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] }));
    expect(added.projects).toHaveLength(1);
    const id = added.projects[0].id;

    const removed = await json(await post('/api/projects/remove', { id }));
    expect(removed.projects).toHaveLength(0);
  });

  it('sets the workspace root override', async () => {
    const other = join(rootDir, 'ws2');
    await mkdir(other, { recursive: true });
    const view = await json(await post('/api/workspace/root', { path: other }));
    expect(view.workspaceDir).toBe(await realpath(other));
  });
});
