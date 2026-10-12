import { resolveExecutablePath } from '../cli/agent-detection';
import { spawnProcess } from '../platform/spawn';

export interface CodegraphResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export type CodegraphRunner = (args: string[], opts?: CommandRunOptions) => Promise<CodegraphResult>;
export type CommandRunner = (
  command: string,
  args: string[],
  opts?: CommandRunOptions,
) => Promise<CodegraphResult>;

export const DEFAULT_CODEGRAPH_BIN = 'codegraph';

export function defaultCodegraphBin(): string {
  return process.env.LARK_CHANNEL_CODEGRAPH_BIN ?? DEFAULT_CODEGRAPH_BIN;
}

/**
 * Spawn an arbitrary command and stream its output. Never rejects: a spawn
 * failure resolves with `code: -1` and the error text, so callers branch on
 * `code` alone. `timeoutMs` kills a hung process (a stuck codegraph would
 * otherwise hang a job forever).
 */
export function createCommandRunner(): CommandRunner {
  return (command, args, opts = {}) =>
    new Promise<CodegraphResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawnProcess(command, args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        windowsHide: true,
      });
      const emit = (chunk: string) => {
        try {
          opts.onOutput?.(chunk);
        } catch {
          // A broken sink must never crash the job.
        }
      };
      child.stdout?.on('data', (data) => {
        const text = String(data);
        stdout += text;
        emit(text);
      });
      child.stderr?.on('data', (data) => {
        const text = String(data);
        stderr += text;
        emit(text);
      });
      const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
      const finish = (result: CodegraphResult) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr || String(err) }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    });
}

export function createCodegraphRunner(bin: string = defaultCodegraphBin()): CodegraphRunner {
  const run = createCommandRunner();
  return (args, opts) => run(bin, args, opts);
}

export interface CodegraphCliStatus {
  installed: boolean;
  version?: string;
  binaryPath?: string;
}

export type ExecutableResolver = (command: string) => Promise<string>;

export interface DetectCliOptions {
  runner?: CodegraphRunner;
  bin?: string;
  resolve?: ExecutableResolver;
}

export async function detectCli(opts: DetectCliOptions = {}): Promise<CodegraphCliStatus> {
  const bin = opts.bin ?? defaultCodegraphBin();
  const resolve = opts.resolve ?? resolveExecutablePath;
  let binaryPath: string;
  try {
    binaryPath = await resolve(bin);
  } catch {
    return { installed: false };
  }
  const runner = opts.runner ?? createCodegraphRunner(bin);
  const result = await runner(['--version'], { timeoutMs: 15_000 }).catch(
    () => ({ code: -1, stdout: '', stderr: '' }) as CodegraphResult,
  );
  if (result.code !== 0) return { installed: false, binaryPath };
  const version = result.stdout.trim().split(/\s+/)[0];
  return { installed: true, ...(version ? { version } : {}), binaryPath };
}
