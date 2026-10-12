import { describe, expect, it } from 'vitest';
import {
  defaultCodegraphBin,
  detectCli,
  type CodegraphResult,
  type CodegraphRunner,
} from '../../../src/workspace/codegraph';

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
