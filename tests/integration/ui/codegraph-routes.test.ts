import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import { ProjectStore } from '../../../src/workspace/projects';
import { JobRegistry, type JobSnapshot } from '../../../src/workspace/jobs';
import type { CodegraphHook, CodegraphRunner } from '../../../src/workspace/codegraph';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let handle: UiServerHandle;
let jobs: JobRegistry;
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

function fakeHook(overrides: Partial<CodegraphHook> = {}): {
  hook: CodegraphHook;
  initDirs: string[];
  syncDirs: string[];
  installs: string[];
} {
  const initDirs: string[] = [];
  const syncDirs: string[] = [];
  const installs: string[] = [];
  const hook: CodegraphHook = {
    available: true,
    init: async (dir) => {
      initDirs.push(dir);
      return { ok: true };
    },
    sync: async (dir) => {
      syncDirs.push(dir);
      return { ok: true };
    },
    installCli: async (method) => {
      installs.push(method);
      return { ok: true };
    },
    wireMcp: async () => ({ ok: true }),
    ...overrides,
  };
  return { hook, initDirs, syncDirs, installs };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cgroutes-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig(
    'claude',
    createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
  );
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
  jobs = new JobRegistry();
});
afterEach(async () => {
  if (handle) await handle.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function start(deps: Record<string, unknown> = {}): Promise<void> {
  handle = await startUiServer({ supervisor, version: 'test', rootDir, jobRegistry: jobs, ...deps });
  base = `http://127.0.0.1:${handle.port}`;
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

async function waitForJob(id: string, timeoutMs = 20_000): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = jobs.get(id);
    if (!snap) throw new Error(`job ${id} disappeared`);
    if (snap.status !== 'running') return snap;
    if (Date.now() >= deadline) throw new Error(`job ${id} still running after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Seed a project straight into the store (no clone) and return its id + dir. */
async function seedProject(name: string): Promise<{ id: string; dir: string }> {
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  const entry = store.add({ repoUrl: `https://example.com/${name}.git`, name, localPath: name });
  await store.flush();
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  return { id: entry.id, dir };
}

describe('codegraph routes', { timeout: 30_000 }, () => {
  it('serves the injected system view from GET /api/codegraph', async () => {
    await start({
      codegraphStatus: async () => ({
        cli: { installed: true, version: '0.9.9' },
        mcp: { state: 'installed', configPath: '/c.jsonc' },
      }),
    });
    const body = await json(await get('/api/codegraph?profile=claude'));
    expect(body).toEqual({
      cli: { installed: true, version: '0.9.9' },
      mcp: { state: 'installed', configPath: '/c.jsonc' },
    });
  });

  it('starts an init job that runs the hook for the stored projects', async () => {
    const { dir } = await seedProject('x');
    const { hook, initDirs } = fakeHook();
    await start({ codegraph: hook });

    const res = await post('/api/codegraph/init?profile=claude', { all: true });
    expect(res.status).toBe(202);
    const { jobId } = await json(res);
    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');
    expect(initDirs).toEqual([dir]);
  });

  it('starts a cli-install job that forwards the chosen method', async () => {
    const { hook, installs } = fakeHook({ available: false });
    await start({ codegraph: hook });

    const res = await post('/api/codegraph/cli/install?profile=claude', { method: 'npm' });
    expect(res.status).toBe(202);
    const { jobId } = await json(res);
    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');
    expect(installs).toEqual(['npm']);
  });

  it('returns empty stats for an un-indexed project without spawning codegraph', async () => {
    const { id } = await seedProject('x');
    const calls: string[][] = [];
    const runner: CodegraphRunner = async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: '{}', stderr: '' };
    };
    await start({ codegraphRunner: runner });

    const body = await json(await get(`/api/codegraph/project?profile=claude&id=${encodeURIComponent(id)}`));
    expect(body.initialized).toBe(false);
    expect(body.fileCount).toBe(0);
    expect(calls).toEqual([]);
  });

  it('binds a sync job to a single project id', async () => {
    const { id, dir } = await seedProject('x');
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    await writeFile(join(dir, '.codegraph', 'codegraph.db'), 'x');
    const { hook, syncDirs } = fakeHook();
    await start({ codegraph: hook });

    const res = await post('/api/codegraph/sync?profile=claude', { id });
    expect(res.status).toBe(202);
    const { jobId } = await json(res);
    expect((await waitForJob(jobId)).status).toBe('succeeded');
    expect(syncDirs).toEqual([dir]);
  });
});
