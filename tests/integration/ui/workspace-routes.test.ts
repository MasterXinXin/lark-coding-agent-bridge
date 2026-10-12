import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import { JobRegistry, type JobSnapshot } from '../../../src/workspace/jobs';
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

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-wsroute-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
  jobs = new JobRegistry();
  handle = await startUiServer({ supervisor, version: 'test', rootDir, jobRegistry: jobs });
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

/** Poll the injected registry until the job leaves `running`, or fail the test. */
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

describe('workspace routes', { timeout: 30_000 }, () => {
  it('browses a directory', async () => {
    const res = await get(`/api/workspace/dir?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.path).toBe(await realpath(workspace));
  });

  it('adds, lists and removes a project', async () => {
    const origin = await makeOrigin(rootDir);
    const created = await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] });
    expect(created.status).toBe(202);
    const { jobId } = await json(created);
    expect(typeof jobId).toBe('string');

    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');
    expect(snap.logs.some((l) => l.text.includes('任务已启动'))).toBe(true);

    // Unknown / expired job ids surface as 404.
    const missing = await get('/api/jobs/does-not-exist');
    expect(missing.status).toBe(404);

    // `since` returns only lines newer than the given seq.
    const full = await json(await get(`/api/jobs/${jobId}`));
    const lastLog = full.logs.at(-1);
    expect(lastLog).toBeDefined();
    const lastSeq = lastLog.seq as number;
    expect(lastSeq).toBeGreaterThan(0);
    const inc = await json(await get(`/api/jobs/${jobId}?since=${lastSeq}`));
    expect(inc.logs).toHaveLength(0);
    const earlier = await json(await get(`/api/jobs/${jobId}?since=0`));
    expect(earlier.logs.every((l: { seq: number }) => l.seq > 0)).toBe(true);
    expect(earlier.logs.length).toBeGreaterThanOrEqual(full.logs.length);

    const listed = await json(await get('/api/projects'));
    expect(listed.projects).toHaveLength(1);
    const id = listed.projects[0].id;

    const removed = await json(await post('/api/projects/remove', { id }));
    expect(removed.projects).toHaveLength(0);
  });

  it('removes a project and deletes its directory when deleteDir is true', async () => {
    const origin = await makeOrigin(rootDir);
    const created = await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] });
    const { jobId } = await json(created);
    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');

    const dir = join(workspace, 'x');
    const exists = () => stat(dir).then(() => true, () => false);
    expect(await exists()).toBe(true);

    const listed = await json(await get('/api/projects'));
    const removed = await json(await post('/api/projects/remove', { id: listed.projects[0].id, deleteDir: true }));
    expect(removed.projects).toHaveLength(0);
    expect(removed.removed.deleted).toBe(true);
    expect(await exists()).toBe(false);
  });

  it('pulls projects via the pull route and records a pull job', async () => {
    const origin = await makeOrigin(rootDir);
    const created = await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] });
    expect(created.status).toBe(202);
    const { jobId: addJobId } = await json(created);
    const addSnap = await waitForJob(addJobId);
    expect(addSnap.status).toBe('succeeded');

    const pulled = await post('/api/projects/pull', {});
    expect(pulled.status).toBe(202);
    const { jobId } = await json(pulled);
    expect(typeof jobId).toBe('string');

    const snap = await waitForJob(jobId);
    expect(snap.status).toBe('succeeded');
    expect(snap.kind).toBe('pull');
  });

  it('sets the workspace root override', async () => {
    const other = join(rootDir, 'ws2');
    await mkdir(other, { recursive: true });
    const view = await json(await post('/api/workspace/root', { path: other }));
    expect(view.workspaceDir).toBe(await realpath(other));
  });
});
