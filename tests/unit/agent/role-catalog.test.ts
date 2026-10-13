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
import { discoverClaudeMcp, discoverClaudeSkills, discoverOpencodeMcp, discoverOpencodeRoleNames, discoverOpencodeSkills, opencodeMcpServers } from '../../../src/agent/role-catalog';

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
  it('reads server names from the legacy `mcp.<name>` (v1) shape and infers transport', () => {
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

  it('reads the `mcp.servers.<name>` (v2) shape', () => {
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

describe('opencode skill discovery', () => {
  it('reads markdown files and SKILL.md directories from global + workspace sources', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const configDir = await tempDir();
    await mkdir(join(configDir, 'skills', 'git-release'), { recursive: true });
    await writeFile(join(configDir, 'skills', 'git-release', 'SKILL.md'), '# git release', 'utf8');
    await writeFile(join(configDir, 'skills', 'review.md'), '# review', 'utf8');
    await mkdir(join(home, '.claude', 'skills', 'compat'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'compat', 'SKILL.md'), '# compat', 'utf8');
    await mkdir(join(workspace, '.opencode', 'skills', 'local-skill'), { recursive: true });
    await writeFile(join(workspace, '.opencode', 'skills', 'local-skill', 'SKILL.md'), '# local', 'utf8');

    const section = await discoverOpencodeSkills({
      env: { OPENCODE_CONFIG_DIR: configDir },
      home,
      workspaceDir: workspace,
    });
    expect(section.available).toBe(true);
    expect(section.items.map((i) => i.name).sort()).toEqual(['compat', 'git-release', 'local-skill', 'review']);
  });

  it('ignores directories without SKILL.md and non-markdown files', async () => {
    const workspace = await tempDir();
    const configDir = await tempDir();
    await mkdir(join(configDir, 'skills', 'not-a-skill'), { recursive: true });
    await writeFile(join(configDir, 'skills', 'notes.txt'), 'x', 'utf8');

    const section = await discoverOpencodeSkills({
      env: { OPENCODE_CONFIG_DIR: configDir },
      home: workspace,
      workspaceDir: workspace,
    });
    expect(section).toEqual({ available: true, items: [] });
  });

  it('treats "no skill directories" as an available empty result', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    const section = await discoverOpencodeSkills({ home, workspaceDir: workspace });
    expect(section).toEqual({ available: true, items: [] });
  });
});

describe('discoverOpencodeRoleNames', () => {
  it('returns the deny-able MCP and skill names', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'opencode.json'),
      JSON.stringify({ mcp: { servers: { context7: { type: 'remote', url: 'https://x' } } } }),
      'utf8',
    );
    await mkdir(join(dir, 'skills', 'deploy'), { recursive: true });
    await writeFile(join(dir, 'skills', 'deploy', 'SKILL.md'), '# deploy', 'utf8');

    const names = await discoverOpencodeRoleNames({ env: { OPENCODE_CONFIG_DIR: dir }, home: dir });
    expect(names.mcp).toEqual(['context7']);
    expect(names.skills).toEqual(['deploy']);
  });

  it('degrades to empty lists when nothing is found', async () => {
    const dir = await tempDir();
    const names = await discoverOpencodeRoleNames({ env: { OPENCODE_CONFIG_DIR: dir }, home: dir });
    expect(names).toEqual({ mcp: [], skills: [] });
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

  it('does not throw when a claude config parses to null', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(join(home, '.claude.json'), 'null', 'utf8');
    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section).toEqual({ available: true, items: [] });
  });

  it('does not throw when a claude config parses to an array', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await writeFile(join(workspace, '.mcp.json'), '[1, 2]', 'utf8');
    const section = await discoverClaudeMcp({ home, workspaceDir: workspace });
    expect(section).toEqual({ available: true, items: [] });
  });
});

import { discoverCodexMcp } from '../../../src/agent/role-catalog';

describe('codex MCP discovery', () => {
  it('extracts [mcp_servers.<name>] names and transport, ignoring comments', async () => {
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, 'config.toml'),
      [
        '# top comment',
        '[mcp_servers.docs]',
        'command = "docs-mcp"   # inline comment',
        '[mcp_servers.web]',
        'url = "https://example.com"',
        '',
        '[mcp_servers.docs.env]',
        'TOKEN = "x"',
        '',
      ].join('\n'),
      'utf8',
    );

    const section = await discoverCodexMcp(codexHome);
    expect(section).toEqual({
      available: true,
      items: [
        { name: 'docs', transport: 'stdio', source: 'config.toml' },
        { name: 'web', transport: 'http', source: 'config.toml' },
      ],
    });
  });

  it('reports unavailable when config.toml is missing', async () => {
    const codexHome = await tempDir();
    const section = await discoverCodexMcp(codexHome);
    expect(section.available).toBe(false);
    expect(section.items).toEqual([]);
  });

  it('ignores url/command keys inside a nested sub-table', async () => {
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, 'config.toml'),
      ['[mcp_servers.docs]', 'command = "docs-mcp"', '[mcp_servers.docs.env]', 'url = "https://nope.example"', ''].join('\n'),
      'utf8',
    );
    const section = await discoverCodexMcp(codexHome);
    expect(section.items).toEqual([{ name: 'docs', transport: 'stdio', source: 'config.toml' }]);
  });

  it('ignores keys in unrelated later tables', async () => {
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, 'config.toml'),
      ['[mcp_servers.docs]', 'command = "docs-mcp"', '[model_providers.custom]', 'url = "https://example.com"', ''].join('\n'),
      'utf8',
    );
    const section = await discoverCodexMcp(codexHome);
    expect(section.items).toEqual([{ name: 'docs', transport: 'stdio', source: 'config.toml' }]);
  });

  it('handles duplicate and array-of-table headers without duplicating servers', async () => {
    const codexHome = await tempDir();
    await writeFile(
      join(codexHome, 'config.toml'),
      ['[mcp_servers.docs]', 'command = "docs-mcp"', '[mcp_servers.docs]', 'url = "https://x"', '[[mcp_servers.docs]]', 'command = "y"', ''].join('\n'),
      'utf8',
    );
    const section = await discoverCodexMcp(codexHome);
    expect(section.items).toEqual([{ name: 'docs', transport: 'stdio', source: 'config.toml' }]);
  });

  it('ignores quoted table names', async () => {
    const codexHome = await tempDir();
    await writeFile(join(codexHome, 'config.toml'), ['[mcp_servers."my server"]', 'command = "x"', ''].join('\n'), 'utf8');
    const section = await discoverCodexMcp(codexHome);
    expect(section.items).toEqual([]);
  });
});

import type { MutableProfileState } from '../../../src/config/config-ops';
import { buildRoleCatalog } from '../../../src/agent/role-catalog';

function fakeState(configPath: string, profileConfig: Record<string, unknown>): MutableProfileState {
  return {
    configPath,
    profile: 'p',
    cfg: {} as never,
    profileConfig: profileConfig as never,
  };
}

describe('buildRoleCatalog', () => {
  it('dispatches claude to claude discovery with the configured workspace', async () => {
    const home = await tempDir();
    const workspace = await tempDir();
    await mkdir(join(workspace, '.claude', 'skills', 's1'), { recursive: true });
    const state = fakeState(join(workspace, 'config.json'), {
      agentKind: 'claude',
      workspaces: { default: workspace },
    });
    const view = await buildRoleCatalog(state, { home });
    expect(view).toMatchObject({
      profile: 'p',
      agentKind: 'claude',
      capabilities: { mcp: 'control', skills: 'readonly' },
    });
    expect(view.skills.items).toEqual([{ name: 's1', source: '.claude/skills' }]);
  });

  it('dispatches codex to a read-only config.toml and no skills', async () => {
    const codexHome = await tempDir();
    await writeFile(join(codexHome, 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n', 'utf8');
    const state = fakeState(join(codexHome, 'config.json'), {
      agentKind: 'codex',
      codex: { binaryPath: 'codex', codexHome },
    });
    const view = await buildRoleCatalog(state);
    expect(view.capabilities).toEqual({ mcp: 'readonly', skills: 'none' });
    expect(view.mcp.items).toEqual([{ name: 'x', transport: 'stdio', source: 'config.toml' }]);
    expect(view.skills).toEqual({ available: false, error: '该桥接无 skill', items: [] });
  });

  it('dispatches opencode to file discovery for MCP and skills', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ mcp: { a: { type: 'local' } } }), 'utf8');
    await mkdir(join(dir, 'skills', 'deploy'), { recursive: true });
    await writeFile(join(dir, 'skills', 'deploy', 'SKILL.md'), '# deploy', 'utf8');
    const state = fakeState(join(dir, 'config.json'), { agentKind: 'opencode' });
    const view = await buildRoleCatalog(state, { env: { OPENCODE_CONFIG_DIR: dir }, home: dir });
    expect(view.capabilities).toEqual({ mcp: 'control', skills: 'control' });
    expect(view.mcp.items).toEqual([{ name: 'a', transport: 'stdio', source: 'opencode.json' }]);
    expect(view.skills.items).toEqual([{ name: 'deploy', source: `${dir}/skills` }]);
  });

  it('degrades instead of throwing when path resolution fails', async () => {
    const dir = await tempDir();
    const state: MutableProfileState = {
      configPath: join(dir, 'config.json'),
      profile: 'p',
      cfg: {} as never,
      profileConfig: {
        agentKind: 'claude',
        get workspaces(): never {
          throw new Error('boom');
        },
      } as never,
    };
    const view = await buildRoleCatalog(state);
    expect(view.mcp).toEqual({ available: false, error: 'boom', items: [] });
    expect(view.skills).toEqual({ available: false, error: 'boom', items: [] });
    expect(view.capabilities).toEqual({ mcp: 'control', skills: 'readonly' });
  });
});
