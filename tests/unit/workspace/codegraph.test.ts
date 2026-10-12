import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CODEGRAPH_STATS,
  defaultCodegraphBin,
  detectCli,
  hasCodegraphMcp,
  mcpStatus,
  parseJsonc,
  projectIndexInfo,
  projectStats,
  type CodegraphResult,
  type CodegraphRunner,
} from '../../../src/workspace/codegraph';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

function recordingRunner(handler: (args: string[]) => Partial<CodegraphResult>): {
  runner: CodegraphRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CodegraphRunner = async (args) => {
    calls.push([...args]);
    const r = handler(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { runner, calls };
}

describe('detectCli', () => {
  it('reports installed with a version and binary path', async () => {
    const { runner, calls } = recordingRunner(() => ({ code: 0, stdout: '0.9.9\n' }));
    const status = await detectCli({
      runner,
      bin: 'codegraph',
      resolve: async () => '/usr/bin/codegraph',
    });
    expect(status).toEqual({ installed: true, version: '0.9.9', binaryPath: '/usr/bin/codegraph' });
    expect(calls).toEqual([['--version']]);
  });

  it('reports not installed without spawning when the binary is unresolved', async () => {
    const { runner, calls } = recordingRunner(() => ({ code: 0, stdout: '0.9.9\n' }));
    const status = await detectCli({
      runner,
      resolve: async () => {
        throw new Error('missing');
      },
    });
    expect(status.installed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports not installed when --version fails', async () => {
    const { runner } = recordingRunner(() => ({ code: 1, stderr: 'boom' }));
    const status = await detectCli({ runner, resolve: async () => '/x/codegraph' });
    expect(status).toEqual({ installed: false, binaryPath: '/x/codegraph' });
  });
});

describe('defaultCodegraphBin', () => {
  it('honours LARK_CHANNEL_CODEGRAPH_BIN', () => {
    const prev = process.env.LARK_CHANNEL_CODEGRAPH_BIN;
    process.env.LARK_CHANNEL_CODEGRAPH_BIN = '/custom/codegraph';
    expect(defaultCodegraphBin()).toBe('/custom/codegraph');
    if (prev === undefined) delete process.env.LARK_CHANNEL_CODEGRAPH_BIN;
    else process.env.LARK_CHANNEL_CODEGRAPH_BIN = prev;
  });
});

describe('parseJsonc / hasCodegraphMcp', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const parsed = parseJsonc(`{
      // indexed by codegraph
      "mcp": { "codegraph": { "command": ["codegraph", "serve", "--mcp"] }, },
    }`);
    expect(hasCodegraphMcp(parsed)).toBe(true);
  });

  it('accepts the legacy mcp.servers.codegraph shape', () => {
    expect(hasCodegraphMcp({ mcp: { servers: { codegraph: {} } } })).toBe(true);
  });

  it('is false when codegraph is absent', () => {
    expect(hasCodegraphMcp({ mcp: { other: {} } })).toBe(false);
    expect(hasCodegraphMcp(null)).toBe(false);
  });
});

describe('mcpStatus', () => {
  async function dirWith(contents: string, name = 'opencode.jsonc'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-mcp-'));
    cleanups.push(dir);
    await writeFile(join(dir, name), contents, 'utf8');
    return dir;
  }

  it('detects mcp.codegraph', async () => {
    const dir = await dirWith('{ "mcp": { "codegraph": { "type": "local" } } }');
    const status = await mcpStatus({ dirs: [dir] });
    expect(status.state).toBe('installed');
    expect(status.configPath).toBe(join(dir, 'opencode.jsonc'));
  });

  it('detects the legacy mcp.servers.codegraph', async () => {
    const dir = await dirWith('{ "mcp": { "servers": { "codegraph": {} } } }', 'opencode.json');
    expect((await mcpStatus({ dirs: [dir] })).state).toBe('installed');
  });

  it('reports missing when a config exists without codegraph', async () => {
    const dir = await dirWith('{ "mcp": {} }');
    expect(await mcpStatus({ dirs: [dir] })).toEqual({ state: 'missing' });
  });

  it('reports unknown when no config exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-mcp-empty-'));
    cleanups.push(dir);
    expect(await mcpStatus({ dirs: [dir] })).toEqual({ state: 'unknown' });
  });

  it('prefers .jsonc over .json in the same directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-mcp-both-'));
    cleanups.push(dir);
    await writeFile(join(dir, 'opencode.json'), '{ "mcp": {} }', 'utf8');
    await writeFile(join(dir, 'opencode.jsonc'), '{ "mcp": { "codegraph": {} } }', 'utf8');
    const status = await mcpStatus({ dirs: [dir] });
    expect(status.state).toBe('installed');
    expect(status.configPath).toBe(join(dir, 'opencode.jsonc'));
  });
});

describe('projectIndexInfo', () => {
  it('is false when .codegraph/codegraph.db is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-index-'));
    cleanups.push(dir);
    expect(await projectIndexInfo(dir)).toEqual({ indexed: false });
  });

  it('is true with size and mtime when the db exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-index-'));
    cleanups.push(dir);
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    await writeFile(join(dir, '.codegraph', 'codegraph.db'), 'x'.repeat(42));
    const info = await projectIndexInfo(dir);
    expect(info.indexed).toBe(true);
    expect(info.dbSizeBytes).toBe(42);
    expect(typeof info.updatedAt).toBe('string');
  });
});

describe('projectStats', () => {
  async function indexedDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-stats-'));
    cleanups.push(dir);
    await mkdir(join(dir, '.codegraph'), { recursive: true });
    await writeFile(join(dir, '.codegraph', 'codegraph.db'), 'x');
    return dir;
  }

  it('never spawns status for an un-indexed project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-stats-'));
    cleanups.push(dir);
    const { runner, calls } = recordingRunner(() => ({ code: 0, stdout: '{}' }));
    expect(await projectStats(runner, dir)).toEqual(EMPTY_CODEGRAPH_STATS);
    expect(calls).toEqual([]);
  });

  it('parses status --json for an indexed project', async () => {
    const dir = await indexedDir();
    const payload = {
      initialized: true,
      fileCount: 12,
      nodeCount: 34,
      edgeCount: 56,
      dbSizeBytes: 789,
      languages: ['typescript', 'markdown'],
      pendingChanges: { added: 1, modified: 2, removed: 3 },
    };
    const { runner, calls } = recordingRunner(() => ({ code: 0, stdout: JSON.stringify(payload) }));
    expect(await projectStats(runner, dir)).toEqual(payload);
    expect(calls).toEqual([['status', dir, '--json']]);
  });

  it('falls back to empty stats on malformed output', async () => {
    const dir = await indexedDir();
    const { runner } = recordingRunner(() => ({ code: 0, stdout: 'not json' }));
    expect(await projectStats(runner, dir)).toEqual(EMPTY_CODEGRAPH_STATS);
  });
});
