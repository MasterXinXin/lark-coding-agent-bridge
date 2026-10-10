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

it('persists workspaces.default and refreshes in-memory state', async () => {
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

  await saveWorkspaceConfig(state, '/tmp/my-ws');

  expect(state.profileConfig.workspaces.default).toBe('/tmp/my-ws');
  const disk = (await loadRootConfig(configPath))!;
  expect(disk.profiles.claude!.workspaces.default).toBe('/tmp/my-ws');
});
