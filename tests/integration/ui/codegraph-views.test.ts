import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { ProjectStore } from '../../../src/workspace/projects';
import { listProjectTargets, projectDirById, projectsView } from '../../../src/ui/workspace-api';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cgviews-'));
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

async function addStoredProject(name: string): Promise<string> {
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  const entry = store.add({ repoUrl: `https://example.com/${name}.git`, name, localPath: name });
  await store.flush();
  await mkdir(join(workspace, name), { recursive: true });
  return entry.id;
}

describe('projectsView codegraph state', () => {
  it('marks an indexed project and leaves an unindexed one false', async () => {
    const indexedId = await addStoredProject('indexed');
    await addStoredProject('plain');
    await mkdir(join(workspace, 'indexed', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'indexed', '.codegraph', 'codegraph.db'), 'x');

    const view = await projectsView('claude', rootDir);
    const byId = new Map(view.projects.map((p) => [p.id, p]));
    expect(byId.get(indexedId)!.codegraph.indexed).toBe(true);
    expect(byId.get(indexedId)!.codegraph.dbSizeBytes).toBe(1);
  });
});

describe('project targets', () => {
  it('lists targets and resolves a directory by id', async () => {
    const id = await addStoredProject('alpha');
    const targets = await listProjectTargets('claude', rootDir);
    expect(targets).toEqual([{ id, name: 'alpha', dir: join(workspace, 'alpha') }]);
    expect(await projectDirById('claude', rootDir, id)).toBe(join(workspace, 'alpha'));
  });

  it('throws 404 for an unknown id', async () => {
    await expect(projectDirById('claude', rootDir, 'missing')).rejects.toThrow(/项目不存在/);
  });
});
