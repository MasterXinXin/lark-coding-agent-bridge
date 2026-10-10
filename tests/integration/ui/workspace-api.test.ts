import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import type { GitRunner, GitRunOptions } from '../../../src/git/git-ops';
import { saveAccount } from '../../../src/ui/git-api';
import { HttpError } from '../../../src/ui/http';
import { loadProfileState } from '../../../src/ui/api';
import {
  addProjects,
  projectsView,
  pullProjects,
  removeProject,
  resolveProjectDir,
  setWorkspaceDir,
  updateProjectBranch,
} from '../../../src/ui/workspace-api';
import { ProjectStore } from '../../../src/workspace/projects';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;
const cleanups: string[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-wsapi-'));
  cleanups.push(rootDir);
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Create a real local bare origin with one commit on `main`; return its path. */
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

describe('workspace-api', { timeout: 30_000 }, () => {
  it('adds a project and clones it into the workspace', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, branch: 'main', name: 'backend' }] });
    const view = await projectsView('claude', rootDir);
    expect(view.workspaceDir).toBe(workspace);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]).toMatchObject({ name: 'backend', branch: 'main', exists: true });
  });

  it('rolls back an add when the repo cannot be cloned', async () => {
    await expect(
      addProjects('claude', rootDir, { projects: [{ repoUrl: join(rootDir, 'nope', 'missing.git'), name: 'bad' }] }),
    ).rejects.toBeInstanceOf(HttpError);
    expect((await projectsView('claude', rootDir)).projects).toHaveLength(0);
  });

  it('rejects a project path escaping the workspace', async () => {
    await expect(
      addProjects('claude', rootDir, { projects: [{ repoUrl: 'https://e/x.git', name: 'x', localPath: '../escape' }] }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('updates branch, sets workspace, and removes', async () => {
    const origin = await makeOrigin(rootDir);
    const added = await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = added.projects[0]!.id;
    await updateProjectBranch('claude', rootDir, { id, branch: 'release' });
    expect((await projectsView('claude', rootDir)).projects[0]!.branch).toBe('release');

    await setWorkspaceDir('claude', rootDir, { path: workspace });
    await removeProject('claude', rootDir, { id });
    expect((await projectsView('claude', rootDir)).projects).toHaveLength(0);
  });

  it('records a failed manual pull when the checkout is missing', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await rm(join(workspace, 'x'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const run = await pullProjects('claude', rootDir, {});
    expect(run.results[0]!.result).toBe('failed');
    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.lastPullAt).toBeTruthy();
  });

  it('resolves in-workspace names and rejects real escapes', () => {
    expect(resolveProjectDir(workspace, 'project')).toBe(join(workspace, 'project'));
    expect(resolveProjectDir(workspace, '..foo')).toBe(join(workspace, '..foo'));
    expect(() => resolveProjectDir(workspace, '../escape')).toThrow(HttpError);
    expect(() => resolveProjectDir(workspace, join(workspace, '..', 'escape'))).toThrow(HttpError);
  });

  it('lists an absolute-path project that fell outside the workspace without failing', async () => {
    const origin = await makeOrigin(rootDir);
    const absLocal = join(workspace, 'absproj');
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'absproj', localPath: absLocal }] });
    const other = join(rootDir, 'ws2');
    await mkdir(other, { recursive: true });
    await setWorkspaceDir('claude', rootDir, { path: other });
    const view = await projectsView('claude', rootDir);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]!.exists).toBe(false);
  });

  it('serializes concurrent adds without losing projects', async () => {
    const a = join(rootDir, 'a');
    const b = join(rootDir, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const o1 = await makeOrigin(a);
    const o2 = await makeOrigin(b);
    await Promise.all([
      addProjects('claude', rootDir, { projects: [{ repoUrl: o1, name: 'one' }] }),
      addProjects('claude', rootDir, { projects: [{ repoUrl: o2, name: 'two' }] }),
    ]);
    const view = await projectsView('claude', rootDir);
    expect(view.projects.map((p) => p.name).sort()).toEqual(['one', 'two']);
  });

  it('applies a workspace change to the provided live state', async () => {
    const state = await loadProfileState('claude', rootDir);
    await setWorkspaceDir('claude', rootDir, { path: workspace }, state);
    expect(state.profileConfig.workspaces.default).toBe(await realpath(workspace));
  });
});

type Captured = { args: string[]; env?: NodeJS.ProcessEnv };

function runnerFrom(
  handler: (args: string[], opts?: GitRunOptions) => { code: number; stdout?: string; stderr?: string },
): GitRunner {
  return async (args, opts) => {
    const r = handler(args, opts);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('account-scoped git env', () => {
  it('injects the account token into git for project checkout', async () => {
    const { accounts } = await saveAccount(rootDir, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    const id = accounts[0]!.id;
    const calls: Captured[] = [];
    const runner = runnerFrom((args, opts) => {
      calls.push({ args, env: opts?.env });
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { code: 128 };
      return { code: 0 };
    });

    await addProjects(
      'claude',
      rootDir,
      { projects: [{ repoUrl: 'https://example.com/acme/api.git', name: 'api', branch: 'main', accountId: id }] },
      runner,
    );

    const clone = calls.find((c) => c.args[0] === 'clone');
    expect(clone).toBeTruthy();
    expect(clone!.env?.LARK_GIT_TOKEN).toBe('ghp_secret');
    expect(clone!.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(clone!.env?.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(String(clone!.env?.GIT_CONFIG_VALUE_0)).toContain('username=octocat');
  });

  it('injects the account token into git for pull', async () => {
    const { accounts } = await saveAccount(rootDir, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const id = accounts[0]!.id;
    const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
    const store = new ProjectStore(appPaths.projectsFile);
    await store.load();
    store.add({ repoUrl: 'https://example.com/acme/api.git', name: 'api', accountId: id });
    await store.flush();

    const calls: Captured[] = [];
    const runner = runnerFrom((args, opts) => {
      calls.push({ args, env: opts?.env });
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n' };
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n' };
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t0\n' };
      if (args[0] === 'status') return { code: 0, stdout: '' };
      if (args[0] === 'pull') return { code: 0, stdout: 'Already up to date.\n' };
      return { code: 0 };
    });

    await pullProjects('claude', rootDir, {}, runner);

    const pull = calls.find((c) => c.args[0] === 'pull');
    expect(pull).toBeTruthy();
    expect(pull!.env?.LARK_GIT_TOKEN).toBe('ghp_secret');
    expect(String(pull!.env?.GIT_CONFIG_VALUE_0)).toContain('password=$LARK_GIT_TOKEN');
  });
});
