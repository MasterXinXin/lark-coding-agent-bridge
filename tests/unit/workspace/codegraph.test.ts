import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultCodegraphBin,
  detectCli,
  hasCodegraphMcp,
  mcpStatus,
  parseJsonc,
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
