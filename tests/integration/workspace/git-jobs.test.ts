import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { createGitRunner, type GitRunner } from '../../../src/git/git-ops';
import { startAddJob, startCodegraphJob, startPullJob } from '../../../src/workspace/git-jobs';
import { JobRegistry, type JobSnapshot } from '../../../src/workspace/jobs';
import type { CodegraphHook } from '../../../src/workspace/codegraph';
import { addProjects, type ProjectsView } from '../../../src/ui/workspace-api';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-gitjobs-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
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

/**
 * The real runner plus a recorder: collect every chunk git emits while still
 * forwarding to the caller's `onOutput` (the job wrapper's registry append).
 */
function makeRecording(chunks: string[]): GitRunner {
  return (args, opts) =>
    createGitRunner()(args, {
      ...opts,
      onOutput: (c) => {
        chunks.push(c);
        opts?.onOutput?.(c);
      },
    });
}

/** Poll the registry until the job leaves `running`, or fail the test. */
async function waitForJob(registry: JobRegistry, id: string, timeoutMs = 20_000): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = registry.get(id);
    if (!snap) throw new Error(`job ${id} disappeared`);
    if (snap.status !== 'running') return snap;
    if (Date.now() >= deadline) throw new Error(`job ${id} still running after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('git jobs', { timeout: 60_000 }, () => {
  it('runs an add job to success and tags logs with the project step', async () => {
    const origin = await makeOrigin(rootDir);
    const registry = new JobRegistry();
    const chunks: string[] = [];
    const { id } = startAddJob(
      'claude',
      rootDir,
      { projects: [{ repoUrl: origin, name: 'x' }] },
      { registry, runner: makeRecording(chunks) },
    );

    // Must already be visible (running) before the fire-and-forget work settles.
    const initial = registry.get(id);
    expect(initial).toBeDefined();
    expect(initial!.status).toBe('running');
    expect(initial!.label).toBe('x');

    const snap = await waitForJob(registry, id);
    expect(snap.status).toBe('succeeded');
    expect(snap.steps.map((s) => s.name)).toEqual(['x']);
    expect(snap.logs.some((l) => l.text.includes('任务已启动'))).toBe(true);
    const stepId = snap.steps[0]!.id;
    // The recording runner must have received live git output, and the job
    // must have forwarded it as stderr tagged with the project step (not just
    // the `开始处理` info line, which carries the step id but a different stream).
    expect(chunks.length).toBeGreaterThan(0);
    expect(snap.logs.some((l) => l.stepId === stepId && l.stream === 'stderr')).toBe(true);

    const result = snap.result as ProjectsView;
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.name).toBe('x');
  });

  it('fails the job when the repo cannot be cloned', async () => {
    const registry = new JobRegistry();
    const chunks: string[] = [];
    const { id } = startAddJob(
      'claude',
      rootDir,
      { projects: [{ repoUrl: join(rootDir, 'missing.git'), name: 'bad' }] },
      { registry, runner: makeRecording(chunks) },
    );

    const snap = await waitForJob(registry, id);
    expect(snap.status).toBe('failed');
    expect(snap.error).toBeTruthy();
  });

  it('pulls an added project and records its step', async () => {
    const origin = await makeOrigin(rootDir);
    const registry = new JobRegistry();
    const add = startAddJob(
      'claude',
      rootDir,
      { projects: [{ repoUrl: origin, name: 'x' }] },
      { registry, runner: makeRecording([]) },
    );
    await waitForJob(registry, add.id);

    const chunks: string[] = [];
    const pull = startPullJob('claude', rootDir, {}, { registry, runner: makeRecording(chunks) });
    const snap = await waitForJob(registry, pull.id);
    expect(snap.status).toBe('succeeded');
    expect(snap.steps.map((s) => s.name)).toEqual(['x']);

    const result = snap.result as { results: Array<{ projectId: string; result: string }> };
    expect(result.results).toHaveLength(1);
  });

  it('runs a codegraph sync job and reports per-project results', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] }, makeRecording([]));
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');

    const registry = new JobRegistry();
    const syncDirs: string[] = [];
    const hook: CodegraphHook = {
      available: true,
      init: async () => ({ ok: true }),
      sync: async (dir) => {
        syncDirs.push(dir);
        return { ok: true };
      },
      installCli: async () => ({ ok: true }),
      wireMcp: async () => ({ ok: true }),
    };

    const { id } = startCodegraphJob(
      'claude',
      rootDir,
      { action: 'sync', all: true },
      { registry, codegraph: hook },
    );
    const snap = await waitForJob(registry, id);
    expect(snap.status).toBe('succeeded');
    expect(syncDirs).toEqual([join(workspace, 'x')]);
  });
});
