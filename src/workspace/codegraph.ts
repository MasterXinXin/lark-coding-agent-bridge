import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export type CodegraphMcpState = 'installed' | 'missing' | 'unknown';

export interface CodegraphMcpStatus {
  state: CodegraphMcpState;
  configPath?: string;
}

/** Candidate opencode config directories, most specific first. */
export function opencodeConfigDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const dirs: string[] = [];
  if (env.OPENCODE_CONFIG_DIR) dirs.push(env.OPENCODE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) dirs.push(join(env.XDG_CONFIG_HOME, 'opencode'));
  if (platform === 'win32' && env.APPDATA) dirs.push(join(env.APPDATA, 'opencode'));
  dirs.push(join(home, '.config', 'opencode'));
  return [...new Set(dirs)];
}

/** Strip `//`, block comments and trailing commas so JSONC parses as JSON. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}

/** True when either `mcp.codegraph` or the legacy `mcp.servers.codegraph` exists. */
export function hasCodegraphMcp(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const mcp = (config as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return false;
  if ('codegraph' in (mcp as Record<string, unknown>)) return true;
  const servers = (mcp as { servers?: unknown }).servers;
  return (
    !!servers && typeof servers === 'object' && 'codegraph' in (servers as Record<string, unknown>)
  );
}

export interface McpStatusOptions {
  dirs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * Where the codegraph MCP is wired, if anywhere. `unknown` (not `missing`) when
 * no config could be read/parsed, so a missing read never produces a false
 * "needs setup" prompt.
 */
export async function mcpStatus(opts: McpStatusOptions = {}): Promise<CodegraphMcpStatus> {
  const dirs = opts.dirs ?? opencodeConfigDirCandidates(opts.env, opts.platform, opts.home);
  let sawFile = false;
  let sawParsed = false;
  for (const dir of dirs) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const configPath = join(dir, name);
      let text: string;
      try {
        text = await readFile(configPath, 'utf8');
      } catch {
        continue;
      }
      sawFile = true;
      let config: unknown;
      try {
        config = parseJsonc(text);
      } catch {
        continue;
      }
      sawParsed = true;
      if (hasCodegraphMcp(config)) return { state: 'installed', configPath };
    }
  }
  if (!sawFile) return { state: 'unknown' };
  return { state: sawParsed ? 'missing' : 'unknown' };
}
