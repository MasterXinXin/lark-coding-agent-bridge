import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, ROLE_PROMPT_MAX_BYTES, truncateUtf8 } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { buildRoleView, saveRoleConfig } from '../../../src/ui/role-api';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };

async function createState(agentKind: 'claude' | 'codex' | 'opencode' = 'claude') {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-role-api-'));
  cleanups.push(rootDir);
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  const configPath = join(rootDir, 'config.json');
  await saveRootConfig(
    createRootConfig(
      'claude',
      createDefaultProfileConfig({
        agentKind,
        accounts: { app },
        ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
      }),
    ),
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

describe('buildRoleView', () => {
  it('reports agent kind, injection mode, and an empty prompt for a fresh profile', async () => {
    const { state } = await createState('claude');
    expect(buildRoleView(state, true)).toMatchObject({
      profile: 'claude',
      agentKind: 'claude',
      prompt: '',
      injection: 'append-system-prompt',
      capabilities: { mcp: 'control', skills: 'readonly' },
      live: true,
    });
  });

  it('reports the codex injection mode and read-only scope', async () => {
    const { state } = await createState('codex');
    expect(buildRoleView(state, false)).toMatchObject({
      agentKind: 'codex',
      injection: 'stdin-prefix',
      capabilities: { mcp: 'readonly', skills: 'none' },
      live: false,
    });
  });

  it('reports the opencode injection mode and full scope', async () => {
    const { state } = await createState('opencode');
    expect(buildRoleView(state, true)).toMatchObject({
      agentKind: 'opencode',
      injection: 'prompt-body-system',
      capabilities: { mcp: 'control', skills: 'control' },
    });
  });
});

describe('saveRoleConfig', () => {
  it('trims, persists, and refreshes in-memory state', async () => {
    const { configPath, state } = await createState();

    const view = await saveRoleConfig(state, { prompt: '  你是财务助手  ' }, true);

    expect(view.prompt).toBe('你是财务助手');
    expect(state.profileConfig.role?.prompt).toBe('你是财务助手');
    const disk = (await loadRootConfig(configPath))!;
    expect(disk.profiles.claude!.role?.prompt).toBe('你是财务助手');
  });

  it('removes the role when the prompt is blank', async () => {
    const { configPath, state } = await createState();
    await saveRoleConfig(state, { prompt: '你是助手' });
    expect(state.profileConfig.role).toBeDefined();

    const view = await saveRoleConfig(state, { prompt: '   ' });

    expect(view.prompt).toBe('');
    expect(state.profileConfig.role).toBeUndefined();
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toBeUndefined();
  });

  it('rejects a non-string prompt with a 400', async () => {
    const { state } = await createState();
    await expect(saveRoleConfig(state, { prompt: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(saveRoleConfig(state, {})).rejects.toMatchObject({ status: 400 });
  });

  it('truncates an over-long prompt at the byte cap', async () => {
    const { state } = await createState();
    const huge = '你'.repeat(ROLE_PROMPT_MAX_BYTES); // 3 bytes each → far over

    const view = await saveRoleConfig(state, { prompt: huge });

    expect(Buffer.byteLength(view.prompt, 'utf8')).toBeLessThanOrEqual(ROLE_PROMPT_MAX_BYTES);
    expect(view.prompt.length).toBeGreaterThan(0);
  });

  it('rejects a non-object body with a 400', async () => {
    const { state } = await createState();
    await expect(saveRoleConfig(state, null)).rejects.toMatchObject({ status: 400 });
    await expect(saveRoleConfig(state, [1, 2])).rejects.toMatchObject({ status: 400 });
    await expect(saveRoleConfig(state, 'nope')).rejects.toMatchObject({ status: 400 });
  });

  it('404s when the profile is not in the config', async () => {
    const { state } = await createState();
    const missing = { ...state, profile: 'ghost' };
    await expect(saveRoleConfig(missing, { prompt: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('preserves phase-2 whitelist fields across a save', async () => {
    const { configPath, state } = await createState();
    const seeded = (await loadRootConfig(configPath))!;
    seeded.profiles.claude!.role = { prompt: '旧', mcpEnabled: ['mcp-a'] };
    await saveRootConfig(seeded, configPath);
    state.profileConfig = (await loadRootConfig(configPath))!.profiles.claude!;

    const view = await saveRoleConfig(state, { prompt: '新' });

    expect(view.prompt).toBe('新');
    expect(state.profileConfig.role).toEqual({ prompt: '新', mcpEnabled: ['mcp-a'] });
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toEqual({
      prompt: '新',
      mcpEnabled: ['mcp-a'],
    });
  });

  it('clearing the prompt keeps whitelist fields', async () => {
    const { configPath, state } = await createState();
    const seeded = (await loadRootConfig(configPath))!;
    seeded.profiles.claude!.role = { prompt: '旧', mcpEnabled: ['mcp-a'] };
    await saveRootConfig(seeded, configPath);
    state.profileConfig = (await loadRootConfig(configPath))!.profiles.claude!;

    const view = await saveRoleConfig(state, { prompt: '   ' });

    expect(view.prompt).toBe('');
    expect(state.profileConfig.role).toEqual({ prompt: '', mcpEnabled: ['mcp-a'] });
  });

  it('stores, echoes and clears the MCP / skill whitelists', async () => {
    const { configPath, state } = await createState();

    const set = await saveRoleConfig(state, { prompt: 'x', mcpEnabled: ['a', 'a', ' '], skillsEnabled: [] });
    expect(set.mcpEnabled).toEqual(['a']);
    expect(set.skillsEnabled).toEqual([]);
    expect(state.profileConfig.role).toEqual({ prompt: 'x', mcpEnabled: ['a'], skillsEnabled: [] });

    // omitted keys keep the existing selection
    const kept = await saveRoleConfig(state, { prompt: 'y' });
    expect(kept.mcpEnabled).toEqual(['a']);
    expect(kept.skillsEnabled).toEqual([]);

    // null clears back to "unlimited"
    const cleared = await saveRoleConfig(state, { prompt: 'y', mcpEnabled: null });
    expect(cleared.mcpEnabled).toBeUndefined();
    expect(cleared.skillsEnabled).toEqual([]);
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toEqual({
      prompt: 'y',
      skillsEnabled: [],
    });
  });

  it('400s a whitelist that is neither a string array nor null', async () => {
    const { state } = await createState();
    await expect(saveRoleConfig(state, { prompt: 'x', mcpEnabled: 42 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      saveRoleConfig(state, { prompt: 'x', skillsEnabled: [1, 2] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('echoes stored whitelists on the role view', async () => {
    const { state } = await createState();
    await saveRoleConfig(state, { prompt: 'x', mcpEnabled: ['a'] });
    expect(buildRoleView(state, true)).toMatchObject({ mcpEnabled: ['a'] });
  });
});

describe('truncateUtf8', () => {
  it('keeps the string when within budget and never splits a code point', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
    const out = truncateUtf8('你你', 4); // one 3-byte char fits, the second does not
    expect(out).toBe('你');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4);
  });
});
