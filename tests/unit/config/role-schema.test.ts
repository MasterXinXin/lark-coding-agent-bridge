import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  normalizeRole,
  ROLE_PROMPT_MAX_BYTES,
  truncateUtf8,
} from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('truncateUtf8', () => {
  it('never splits a code point at the byte cap', () => {
    expect(truncateUtf8('abc', 10)).toBe('abc');
    expect(truncateUtf8('你你', 4)).toBe('你');
  });
});

describe('normalizeRole', () => {
  it('trims the prompt and drops an empty role with no whitelists', () => {
    expect(normalizeRole({ prompt: '   ' })).toBeUndefined();
    expect(normalizeRole({})).toBeUndefined();
    expect(normalizeRole(undefined)).toBeUndefined();
  });

  it('keeps a trimmed prompt', () => {
    expect(normalizeRole({ prompt: '  你是财务助手。 ' })).toEqual({ prompt: '你是财务助手。' });
  });

  it('distinguishes a missing whitelist from an explicit empty one', () => {
    // missing = follow native config → field omitted
    expect(normalizeRole({ prompt: 'x' })).toEqual({ prompt: 'x' });
    // explicit empty = disable everything → field kept as []
    expect(normalizeRole({ prompt: '', mcpEnabled: [] })).toEqual({ prompt: '', mcpEnabled: [] });
  });

  it('trims, dedupes, and drops empty whitelist names', () => {
    expect(normalizeRole({ prompt: 'x', skillsEnabled: [' a ', 'a', '', 'b'] })).toEqual({
      prompt: 'x',
      skillsEnabled: ['a', 'b'],
    });
  });

  it('clamps an oversized prompt to the byte cap', () => {
    const huge = '你'.repeat(ROLE_PROMPT_MAX_BYTES);
    const out = normalizeRole({ prompt: huge });
    expect(out).toBeDefined();
    expect(Buffer.byteLength(out!.prompt, 'utf8')).toBeLessThanOrEqual(ROLE_PROMPT_MAX_BYTES);
    expect(out!.prompt.length).toBeGreaterThan(0);
  });
});

describe('normalizeProfileConfig role', () => {
  it('preserves a valid role and drops an empty one', () => {
    const withRole = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      role: { prompt: '你是助手' },
    });
    expect(withRole.role).toEqual({ prompt: '你是助手' });

    const withoutRole = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      role: { prompt: '   ' },
    });
    expect(withoutRole.role).toBeUndefined();
  });
});

describe('role persistence', () => {
  it('round-trips role through save/load', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'bridge-role-'));
    cleanups.push(rootDir);
    await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
    const configPath = join(rootDir, 'config.json');

    const root = createRootConfig(
      'claude',
      createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    );
    root.profiles.claude!.role = { prompt: '你是财务助手', mcpEnabled: [] };
    await saveRootConfig(root, configPath);

    const disk = (await loadRootConfig(configPath))!;
    expect(disk.profiles.claude!.role).toEqual({ prompt: '你是财务助手', mcpEnabled: [] });

    delete disk.profiles.claude!.role;
    await saveRootConfig(disk, configPath);
    expect((await loadRootConfig(configPath))!.profiles.claude!.role).toBeUndefined();
  });
});
