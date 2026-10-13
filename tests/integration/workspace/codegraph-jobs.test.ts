import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { createGitRunner, type GitRunner } from '../../../src/git/git-ops';
import { addProjects, pullProjects } from '../../../src/ui/workspace-api';
import {
  ensureCodegraphExcluded,
  type CodegraphHook,
  type CodegraphOpResult,
} from '../../../src/workspace/codegraph';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cgjobs-'));
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

function recordingHook(available = true): {
  hook: CodegraphHook;
  initDirs: string[];
  syncDirs: string[];
} {
  const initDirs: string[] = [];
  const syncDirs: string[] = [];
  const ok: CodegraphOpResult = { ok: true };
  const hook: CodegraphHook = {
    available,
    init: async (dir) => {
      initDirs.push(dir);
      return ok;
    },
    sync: async (dir) => {
      syncDirs.push(dir);
      return ok;
    },
    installCli: async () => ok,
    wireMcp: async () => ok,
  };
  return { hook, initDirs, syncDirs };
}

const runner = (): GitRunner => createGitRunner();

describe('codegraph hook wiring', { timeout: 60_000 }, () => {
  it('syncs only when a pull actually updated and the project is indexed', async () => {
    const origin = await makeOrigin(rootDir);
    const { hook, syncDirs } = recordingHook();
    await addProjects(
      'claude',
      rootDir,
      { projects: [{ repoUrl: origin, name: 'x' }] },
      runner(),
    );
    // Not yet indexed -> an up-to-date pull must not sync.
    await pullProjects('claude', rootDir, {}, runner(), undefined, 'manual', hook);
    expect(syncDirs).toEqual([]);

    // Index it, then push a new commit so the next pull updates. Mirror
    // codegraph init by keeping `.codegraph/` out of `git status`.
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    await ensureCodegraphExcluded(join(workspace, 'x'));
    const seed = join(rootDir, 'seed');
    git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'more']);
    git(seed, ['push', 'origin', 'main']);
    await pullProjects('claude', rootDir, {}, runner(), undefined, 'manual', hook);
    expect(syncDirs).toEqual([join(workspace, 'x')]);
  });
});
