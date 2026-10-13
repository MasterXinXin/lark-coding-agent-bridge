import { describe, expect, it } from 'vitest';
import { roleScope } from '../../../src/agent/role-catalog';

describe('roleScope', () => {
  it('reports per-agent MCP / skill control levels', () => {
    expect(roleScope('claude')).toEqual({ mcp: 'control', skills: 'readonly' });
    expect(roleScope('codex')).toEqual({ mcp: 'readonly', skills: 'none' });
    expect(roleScope('opencode')).toEqual({ mcp: 'control', skills: 'control' });
  });

  it('returns a fresh object so callers cannot mutate the table', () => {
    const a = roleScope('claude');
    a.mcp = 'none';
    expect(roleScope('claude').mcp).toBe('control');
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { discoverOpencodeMcp, opencodeMcpServers } from '../../../src/agent/role-catalog';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'role-catalog-'));
  cleanups.push(dir);
  return dir;
}

describe('opencode MCP discovery', () => {
  it('reads server names (new `mcp.<name>` shape) and infers transport', () => {
    expect(
      opencodeMcpServers(
        {
          mcp: {
            local1: { type: 'local', command: ['node', 'x.js'] },
            remote1: { type: 'remote', url: 'https://example.com/sse' },
            remote2: { type: 'remote', url: 'https://example.com' },
          },
        },
        'opencode.json',
      ),
    ).toEqual([
      { name: 'local1', transport: 'stdio', source: 'opencode.json' },
      { name: 'remote1', transport: 'sse', source: 'opencode.json' },
      { name: 'remote2', transport: 'http', source: 'opencode.json' },
    ]);
  });

  it('reads the legacy `mcp.servers.<name>` shape', () => {
    expect(opencodeMcpServers({ mcp: { servers: { old: { type: 'local' } } } }, 'opencode.json')).toEqual([
      { name: 'old', transport: 'stdio', source: 'opencode.json' },
    ]);
  });

  it('returns an empty, available section when a config has no mcp', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    const section = await discoverOpencodeMcp({ env: { OPENCODE_CONFIG_DIR: dir } });
    expect(section).toEqual({ available: true, items: [] });
  });

  it('parses jsonc and reads the first candidate dir', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'opencode.jsonc'),
      '{\n  // comment\n  "mcp": { "cg": { "type": "local" } },\n}\n',
      'utf8',
    );
    const section = await discoverOpencodeMcp({ env: { OPENCODE_CONFIG_DIR: dir } });
    expect(section).toEqual({
      available: true,
      items: [{ name: 'cg', transport: 'stdio', source: 'opencode.jsonc' }],
    });
  });

  it('reports unavailable when no config exists', async () => {
    const dir = await tempDir();
    const section = await discoverOpencodeMcp({
      env: { OPENCODE_CONFIG_DIR: join(dir, 'nope') },
      home: dir,
    });
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
    expect(section.error).toBeTruthy();
  });
});
