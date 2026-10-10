import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { HttpError } from '../../../src/ui/http';
import {
  addProjects,
  projectsView,
  pullProjects,
  removeProject,
  resolveProjectDir,
  setWorkspaceDir,
  updateProjectBranch,
} from '../../../src/ui/workspace-api';

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
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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

describe('workspace-api', () => {
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
    await rm(join(workspace, 'x'), { recursive: true, force: true });
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
});
