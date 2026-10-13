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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { discoverClaudeMcp, discoverClaudeSkills, discoverOpencodeMcp, opencodeMcpServers } from '../../../src/agent/role-catalog';

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

describe('claude MCP + skill discovery', () => {
  it('merges ~/.claude.json and workspace .mcp.json, de-duplicating names', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'a' }, beta: { url: 'https://x' } } }),
      'utf8',
    );
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { beta: { command: 'b' }, gamma: { type: 'sse', url: 'https://y' } } }),
      'utf8',
    );

    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section.available).toBe(true);
    expect(section.items).toEqual([
      { name: 'alpha', transport: 'stdio', source: '~/.claude.json' },
      { name: 'beta', transport: 'http', source: '~/.claude.json' },
      { name: 'gamma', transport: 'sse', source: '.mcp.json' },
    ]);
  });

  it('reports unavailable when neither claude MCP file exists', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
  });

  it('lists skill directories from home and workspace', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(home, '.claude', 'skills', 'skill-a'), { recursive: true });
    await mkdir(join(workspace, '.claude', 'skills', 'skill-b'), { recursive: true });

    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section).toEqual({
      available: true,
      items: [
        { name: 'skill-a', source: '~/.claude/skills' },
        { name: 'skill-b', source: '.claude/skills' },
      ],
    });
  });

  it('treats "no skill directories" as an available empty result', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section).toEqual({ available: true, items: [] });
  });

  it('reports unavailable when the only claude config is unparseable', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(join(home, '.claude.json'), '{ not json', 'utf8');
    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
    expect(section.error).toBeTruthy();
  });

  it('de-duplicates skills by name, first source wins', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(home, '.claude', 'skills', 'shared'), { recursive: true });
    await mkdir(join(workspace, '.claude', 'skills', 'shared'), { recursive: true });
    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section.items).toEqual([{ name: 'shared', source: '~/.claude/skills' }]);
  });

  it('ignores plain files inside a skills directory', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(home, '.claude', 'skills', 'real'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'README.md'), 'x', 'utf8');
    const section = await discoverClaudeSkills({ home, workspaceDir: workspace });
    expect(section.items).toEqual([{ name: 'real', source: '~/.claude/skills' }]);
  });
});
