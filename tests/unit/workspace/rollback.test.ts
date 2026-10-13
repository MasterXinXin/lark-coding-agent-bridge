import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { ProjectStore } from '../../../src/workspace/projects';
import { executeRollback } from '../../../src/workspace/rollback';

let rootDir: string;
let workspaceDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-rollback-'));
  workspaceDir = join(rootDir, 'ws');
  await mkdir(workspaceDir, { recursive: true });
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function seedProject(profile: string, name: string, localPath: string): Promise<string> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  const entry = store.add({ repoUrl: 'https://x/y.git', name, localPath });
  await store.flush();
  return entry.id;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('executeRollback', () => {
  it('removes a partial checkout and its project record', async () => {
    const id = await seedProject('claude', 'x', 'x');
    const dir = join(workspaceDir, 'x');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'partial'), 'x');

    await executeRollback({
      kind: 'add-checkout',
      profile: 'claude',
      projectId: id,
      workspaceDir,
      localPath: 'x',
      dir,
      rootDir,
    });

    expect(await exists(dir)).toBe(false);
    const store = new ProjectStore(resolveAppPaths({ rootDir, profile: 'claude' }).projectsFile);
    await store.load();
    expect(store.get(id)).toBeUndefined();
  });

  it('refuses to delete outside the workspace but still drops the record', async () => {
    const outside = join(rootDir, 'outside');
    await mkdir(outside, { recursive: true });
    const removeProjectRecord = vi.fn(async () => {});
    const remove = vi.fn(async () => {});

    await executeRollback(
      {
        kind: 'add-checkout',
        profile: 'claude',
        projectId: 'p1',
        workspaceDir,
        localPath: '../outside',
        dir: outside,
        rootDir,
      },
      { remove, removeProjectRecord },
    );

    expect(remove).not.toHaveBeenCalled();
    expect(removeProjectRecord).toHaveBeenCalledWith('claude', rootDir, 'p1');
  });

  it('removes only .codegraph for a killed init', async () => {
    const dir = join(workspaceDir, 'proj');
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    await writeFile(join(dir, '.codegraph', 'codegraph.db'), 'partial');
    await writeFile(join(dir, 'src.ts'), 'keep me');

    await executeRollback({ kind: 'codegraph-init', dir });

    expect(await exists(join(dir, '.codegraph'))).toBe(false);
    expect(await exists(join(dir, 'src.ts'))).toBe(true);
  });

  it('unlocks a killed sync without touching the index', async () => {
    const dir = join(workspaceDir, 'proj');
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    const unlock = vi.fn(async () => {});

    await executeRollback({ kind: 'codegraph-sync', dir }, { unlock });

    expect(unlock).toHaveBeenCalledWith(dir);
    expect(await exists(join(dir, '.codegraph'))).toBe(true);
  });

  it('switches back to the previous branch on cancel', async () => {
    const dir = join(workspaceDir, 'proj');
    await mkdir(dir, { recursive: true });
    const switchBack = vi.fn(async () => {});

    await executeRollback({ kind: 'branch-switch', dir, previousBranch: 'main' }, { switchBack });

    expect(switchBack).toHaveBeenCalledWith(dir, 'main');
  });

  it('does nothing for a branch-switch with no previous branch', async () => {
    const dir = join(workspaceDir, 'proj');
    const switchBack = vi.fn(async () => {});

    await executeRollback({ kind: 'branch-switch', dir, previousBranch: '' }, { switchBack });

    expect(switchBack).not.toHaveBeenCalled();
  });
});
