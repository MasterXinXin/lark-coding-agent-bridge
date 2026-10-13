import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeMcpConfig, readClaudeMcpDefinitions } from '../../../src/agent/claude/role-mcp';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-role-mcp-'));
  cleanups.push(dir);
  return dir;
}

describe('readClaudeMcpDefinitions', () => {
  it('merges ~/.claude.json and workspace .mcp.json, first definition wins', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { alpha: { command: 'a' }, beta: { command: 'home-beta' } },
      }),
      'utf8',
    );
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { beta: { command: 'ws-beta' }, gamma: { url: 'https://g' } } }),
      'utf8',
    );

    const defs = readClaudeMcpDefinitions({ home, workspaceDir: workspace });
    expect([...defs.keys()].sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(defs.get('beta')).toEqual({ command: 'home-beta' });
  });

  it('ignores missing or malformed files', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(join(home, '.claude.json'), '{ not json', 'utf8');
    expect(readClaudeMcpDefinitions({ home, workspaceDir: workspace }).size).toBe(0);
  });
});

describe('buildClaudeMcpConfig', () => {
  const defs = new Map<string, unknown>([
    ['a', { command: 'a' }],
    ['b', { command: 'b' }],
  ]);

  it('does not inject when unrestricted', () => {
    expect(buildClaudeMcpConfig({ definitions: defs })).toEqual({ config: undefined, missing: [] });
  });

  it('injects an empty strict config when the whitelist is an explicit empty array', () => {
    expect(buildClaudeMcpConfig({ mcpEnabled: [], definitions: defs })).toEqual({
      config: { mcpServers: {} },
      missing: [],
    });
  });

  it('keeps only whitelisted servers that have definitions', () => {
    expect(buildClaudeMcpConfig({ mcpEnabled: ['a', 'ghost'], definitions: defs })).toEqual({
      config: { mcpServers: { a: { command: 'a' } } },
      missing: ['ghost'],
    });
  });

  it('degrades to no injection when no whitelisted name resolves', () => {
    expect(buildClaudeMcpConfig({ mcpEnabled: ['ghost'], definitions: defs })).toEqual({
      config: undefined,
      missing: ['ghost'],
    });
  });
});
