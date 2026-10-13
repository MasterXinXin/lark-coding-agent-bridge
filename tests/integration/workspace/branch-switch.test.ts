import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import type { GitRunner } from '../../../src/git/git-ops';
import {
  addProjects,
  projectBranchesView,
  projectsView,
  pullProjects,
  setSchedule,
  switchProjectBranch,
} from '../../../src/ui/workspace-api';
import {
  ensureCodegraphExcluded,
  type CodegraphHook,
  type CodegraphOpResult,
} from '../../../src/workspace/codegraph';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-branch-'));
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
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Real local bare origin with one commit on `main` plus a `release` branch. */
async function makeOrigin(base: string): Promise<string> {
  const origin = join(base, 'origin.git');
  git(base, ['init', '--bare', origin]);
  const seed = join(base, 'seed');
  git(base, ['clone', origin, seed]);
  git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['branch', 'release']);
  git(seed, ['push', '-u', 'origin', 'main', 'release']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return origin;
}

function syncHook(available = true): { hook: CodegraphHook; syncDirs: string[] } {
  const syncDirs: string[] = [];
  const ok: CodegraphOpResult = { ok: true };
  const hook: CodegraphHook = {
    available,
    init: async () => ok,
    sync: async (dir) => {
      syncDirs.push(dir);
      return ok;
    },
    installCli: async () => ok,
    wireMcp: async () => ok,
  };
  return { hook, syncDirs };
}

describe('project branch switch', { timeout: 60_000 }, () => {
  it('lists branches with the current branch first', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const [entry] = (await projectsView('claude', rootDir)).projects;

    const view = await projectBranchesView('claude', rootDir, entry!.id);

    expect(view.current).toBe('main');
    expect(view.branches[0]).toBe('main');
    expect(view.branches).toEqual(expect.arrayContaining(['main', 'release']));
  });

  it('404s branch listing for an unknown project', async () => {
    await expect(projectBranchesView('claude', rootDir, 'ghost')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('surfaces an ls-remote failure as a 400 HttpError', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;
    const failing: GitRunner = async (args) =>
      args[0] === 'ls-remote'
        ? { code: 128, stdout: '', stderr: 'fatal: nope\n' }
        : { code: 0, stdout: '', stderr: '' };

    await expect(projectBranchesView('claude', rootDir, id, failing)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('switches the checkout, persists the branch, and syncs the index', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    // A raw `.codegraph/` is untracked and would make the tree look dirty.
    await ensureCodegraphExcluded(join(workspace, 'x'));
    const { hook, syncDirs } = syncHook();
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await switchProjectBranch('claude', rootDir, { id, branch: 'release' }, undefined, undefined, hook);

    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.branch).toBe('release');
    expect(view.projects[0]!.status.branch).toBe('release');
    expect(syncDirs).toEqual([join(workspace, 'x')]);
  });

  it('refuses to switch when the tree is dirty and keeps the branch', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await writeFile(join(workspace, 'x', 'wip.txt'), 'wip', 'utf8');
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await expect(switchProjectBranch('claude', rootDir, { id, branch: 'release' })).rejects.toThrow(
      /未提交改动/,
    );

    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.branch).toBe('main');
    expect(view.projects[0]!.status.branch).toBe('main');
  });

  it('is a no-op when the target already matches the current branch', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    const { hook, syncDirs } = syncHook();
    const id = (await projectsView('claude', rootDir)).projects[0]!.id;

    await switchProjectBranch('claude', rootDir, { id, branch: 'main' }, undefined, undefined, hook);

    expect(syncDirs).toEqual([]);
  });
});
