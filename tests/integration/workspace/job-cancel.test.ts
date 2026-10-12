import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import type { GitRunner } from '../../../src/git/git-ops';
import type { CodegraphHook, CodegraphRunner } from '../../../src/workspace/codegraph';
import { startAddJob, startCodegraphJob } from '../../../src/workspace/git-jobs';
import { JobRegistry } from '../../../src/workspace/jobs';
import { cancelOperation } from '../../../src/workspace/operations';
import { ProjectStore } from '../../../src/workspace/projects';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cancel-'));
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

function projectsFile(): string {
  return resolveAppPaths({ rootDir, profile: 'claude' }).projectsFile;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function unavailableCodegraph(): CodegraphHook {
  return {
    available: false,
    init: async () => ({ ok: false, detail: 'unavailable' }),
    sync: async () => ({ ok: false, detail: 'unavailable' }),
    installCli: async () => ({ ok: false, detail: 'unavailable' }),
    wireMcp: async () => ({ ok: false, detail: 'unavailable' }),
  };
}

describe('cancelling workspace jobs', () => {
  it('cancels a hanging codegraph init and removes the partial .codegraph/', async () => {
    const store = new ProjectStore(projectsFile());
    await store.load();
    const entry = store.add({ repoUrl: 'https://example.com/x.git', name: 'x', localPath: 'x' });
    await store.flush();
    const dir = join(workspace, 'x');
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    await writeFile(join(dir, '.codegraph', 'partial.tmp'), 'p');

    const registry = new JobRegistry();
    // detectCli answers --version; `init` hangs forever (a stuck index build).
    const codegraphRunner: CodegraphRunner = (args) => {
      if (args[0] === '--version') {
        return Promise.resolve({ code: 0, stdout: 'codegraph 1.2.3\n', stderr: '' });
      }
      if (args[0] === 'init') return new Promise(() => {});
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    const { id } = startCodegraphJob(
      'claude',
      rootDir,
      { action: 'init', id: entry.id },
      {
        registry,
        codegraphRunner,
        codegraphResolve: async () => 'C:/fake/codegraph',
        codegraphBin: 'codegraph',
      },
    );

    // Wait until the init step is underway (rollback registered, .codegraph still present).
    await waitFor(() => (registry.get(id)?.steps.length ?? 0) > 0);
    expect(await exists(join(dir, '.codegraph'))).toBe(true);

    await cancelOperation(id);
    await waitFor(() => registry.get(id)?.status !== 'running');

    expect(registry.get(id)!.status).toBe('cancelled');
    expect(await exists(join(dir, '.codegraph'))).toBe(false);
    // The project record survives — only the ruined index is rolled back.
    const after = new ProjectStore(projectsFile());
    await after.load();
    expect(after.get(entry.id)).toBeDefined();
  });

  it('cancels a hanging clone and removes the partial checkout', async () => {
    const store = new ProjectStore(projectsFile());
    await store.load();
    const seed = store.add({ repoUrl: 'https://example.com/seed.git', name: 'seed', localPath: 'seed' });
    await store.flush();
    await mkdir(join(workspace, 'seed'), { recursive: true });

    const registry = new JobRegistry();
    const runner: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return Promise.resolve({ code: 128, stdout: '', stderr: '' });
      if (args[0] === 'clone') return new Promise(() => {});
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    const { id } = startAddJob(
      'claude',
      rootDir,
      { projects: [{ repoUrl: 'https://example.com/y.git', name: 'y' }] },
      { registry, runner, codegraph: unavailableCodegraph() },
    );

    // The record is persisted as soon as it is added, before the clone completes.
    await waitFor(async () => {
      const s = new ProjectStore(projectsFile());
      await s.load();
      return s.list().some((p) => p.name === 'y');
    });

    const dir = join(workspace, 'y');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.part'), 'partial');

    await cancelOperation(id);
    await waitFor(() => registry.get(id)?.status !== 'running');

    expect(registry.get(id)!.status).toBe('cancelled');
    expect(await exists(dir)).toBe(false);
    const after = new ProjectStore(projectsFile());
    await after.load();
    expect(after.list().some((p) => p.name === 'y')).toBe(false);
    expect(after.get(seed.id)).toBeDefined();
  });
});
