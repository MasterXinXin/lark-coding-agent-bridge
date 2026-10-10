import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { saveWorkspaceConfig } from '../../../src/config/config-ops';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Seed a root config on disk and return the matching mutable profile state. */
async function createState() {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-cfg-'));
  cleanups.push(rootDir);
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  const configPath = join(rootDir, 'config.json');
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } } })),
    configPath,
  );
  const root = (await loadRootConfig(configPath))!;
  const state = {
    configPath,
    profile: 'claude',
    cfg: runtimeProfileConfig(root, 'claude'),
    profileConfig: root.profiles.claude!,
  };
  return { configPath, state };
}

it('persists workspaces.default and refreshes in-memory state', async () => {
  const { configPath, state } = await createState();

  await saveWorkspaceConfig(state, '/tmp/my-ws');

  expect(state.profileConfig.workspaces.default).toBe('/tmp/my-ws');
  const disk = (await loadRootConfig(configPath))!;
  expect(disk.profiles.claude!.workspaces.default).toBe('/tmp/my-ws');
});

it('rejects a blank workspace directory and leaves disk unchanged', async () => {
  const { configPath, state } = await createState();

  await expect(saveWorkspaceConfig(state, '   ')).rejects.toThrow('工作空间目录不能为空');

  const disk = (await loadRootConfig(configPath))!;
  expect(disk.profiles.claude!.workspaces.default).toBeUndefined();
});

it('trims surrounding whitespace before saving', async () => {
  const { configPath, state } = await createState();

  await saveWorkspaceConfig(state, '  /tmp/trimmed-ws  ');

  expect(state.profileConfig.workspaces.default).toBe('/tmp/trimmed-ws');
  const disk = (await loadRootConfig(configPath))!;
  expect(disk.profiles.claude!.workspaces.default).toBe('/tmp/trimmed-ws');
});
