import { readFile, stat } from 'node:fs/promises';
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

export interface CodegraphIndexInfo {
  indexed: boolean;
  dbPath?: string;
  dbSizeBytes?: number;
  updatedAt?: string;
}

/**
 * Cheap, pure-filesystem index probe. Deliberately never runs
 * `codegraph status`: for an un-indexed directory that command blocks on an
 * interactive prompt (measured 60s+ hang), which would freeze a row render.
 */
export async function projectIndexInfo(dir: string): Promise<CodegraphIndexInfo> {
  const dbPath = join(dir, '.codegraph', 'codegraph.db');
  try {
    const info = await stat(dbPath);
    if (!info.isFile()) return { indexed: false };
    return { indexed: true, dbPath, dbSizeBytes: info.size, updatedAt: info.mtime.toISOString() };
  } catch {
    return { indexed: false };
  }
}

export interface CodegraphPendingChanges {
  added: number;
  modified: number;
  removed: number;
}

export interface CodegraphStats {
  initialized: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
  pendingChanges: CodegraphPendingChanges;
}

export const EMPTY_CODEGRAPH_STATS: CodegraphStats = {
  initialized: false,
  fileCount: 0,
  nodeCount: 0,
  edgeCount: 0,
  dbSizeBytes: 0,
  languages: [],
  pendingChanges: { added: 0, modified: 0, removed: 0 },
};

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Full stats for an indexed project; empty stats otherwise (never spawns). */
export async function projectStats(runner: CodegraphRunner, dir: string): Promise<CodegraphStats> {
  if (!(await projectIndexInfo(dir)).indexed) return EMPTY_CODEGRAPH_STATS;
  const result = await runner(['status', dir, '--json'], { timeoutMs: 30_000 }).catch(
    () => ({ code: -1, stdout: '', stderr: '' }) as CodegraphResult,
  );
  if (result.code !== 0) return EMPTY_CODEGRAPH_STATS;
  try {
    const raw = JSON.parse(result.stdout) as Record<string, unknown>;
    const pending = (
      raw.pendingChanges && typeof raw.pendingChanges === 'object' ? raw.pendingChanges : {}
    ) as Record<string, unknown>;
    return {
      initialized: raw.initialized === true,
      fileCount: asNumber(raw.fileCount),
      nodeCount: asNumber(raw.nodeCount),
      edgeCount: asNumber(raw.edgeCount),
      dbSizeBytes: asNumber(raw.dbSizeBytes),
      languages: Array.isArray(raw.languages)
        ? raw.languages.filter((l): l is string => typeof l === 'string')
        : [],
      pendingChanges: {
        added: asNumber(pending.added),
        modified: asNumber(pending.modified),
        removed: asNumber(pending.removed),
      },
    };
  } catch {
    return EMPTY_CODEGRAPH_STATS;
  }
}

export interface CodegraphOpResult {
  ok: boolean;
  detail?: string;
}

const OP_TIMEOUT_MS = 10 * 60_000;

function failureDetail(result: CodegraphResult, fallback: string): string {
  return (result.stderr || result.stdout).trim().slice(-500) || fallback;
}

export async function initProject(
  runner: CodegraphRunner,
  dir: string,
  onOutput?: (chunk: string) => void,
): Promise<CodegraphOpResult> {
  const result = await runner(['init', dir], {
    timeoutMs: OP_TIMEOUT_MS,
    ...(onOutput ? { onOutput } : {}),
  });
  return result.code === 0
    ? { ok: true }
    : { ok: false, detail: failureDetail(result, 'codegraph init 失败') };
}

export async function syncProject(
  runner: CodegraphRunner,
  dir: string,
  onOutput?: (chunk: string) => void,
): Promise<CodegraphOpResult> {
  const result = await runner(['sync', dir], {
    timeoutMs: OP_TIMEOUT_MS,
    ...(onOutput ? { onOutput } : {}),
  });
  return result.code === 0
    ? { ok: true }
    : { ok: false, detail: failureDetail(result, 'codegraph sync 失败') };
}

export type CodegraphInstallMethod = 'script' | 'npm';

/** The official install command for a platform, as `command` + `args`. */
export function buildInstallCommand(
  method: CodegraphInstallMethod,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (method === 'npm') return { command: 'npm', args: ['i', '-g', '@colbymchenry/codegraph'] };
  const sh = 'https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh';
  const ps1 = 'https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1';
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${ps1} | iex`],
    };
  }
  return { command: 'sh', args: ['-c', `curl -fsSL ${sh} | sh`] };
}

/**
 * The job-side surface `workspace-api` and `git-jobs` depend on. A plain object
 * so tests can inject a fake without spawning anything.
 */
export interface CodegraphHook {
  available: boolean;
  version?: string;
  init(dir: string): Promise<CodegraphOpResult>;
  sync(dir: string): Promise<CodegraphOpResult>;
  installCli(method: CodegraphInstallMethod): Promise<CodegraphOpResult>;
  wireMcp(): Promise<CodegraphOpResult>;
}

export interface CreateCodegraphHookOptions {
  bin?: string;
  runner?: CodegraphRunner;
  commandRunner?: CommandRunner;
  resolve?: ExecutableResolver;
  onOutput?: (chunk: string) => void;
  /** Override the MCP probe (tests). */
  mcp?: () => Promise<CodegraphMcpStatus>;
}

/**
 * Resolve everything needed to run codegraph, detecting the CLI once. The
 * returned hook's `installCli` chains MCP wiring, so a single console click
 * goes CLI → MCP in one job.
 */
export async function createCodegraphHook(
  opts: CreateCodegraphHookOptions = {},
): Promise<CodegraphHook> {
  const bin = opts.bin ?? defaultCodegraphBin();
  const runner = opts.runner ?? createCodegraphRunner(bin);
  const commandRunner = opts.commandRunner ?? createCommandRunner();
  const onOutput = opts.onOutput;
  const stream: CommandRunOptions = onOutput ? { onOutput } : {};
  const mcp = opts.mcp ?? (() => mcpStatus());
  const resolveOpt = opts.resolve ? { resolve: opts.resolve } : {};
  const cli = await detectCli({ runner, bin, ...resolveOpt });

  const wireMcp = async (): Promise<CodegraphOpResult> => {
    const result = await runner(['install', '--yes'], { timeoutMs: 5 * 60_000, ...stream });
    return result.code === 0
      ? { ok: true }
      : { ok: false, detail: failureDetail(result, 'codegraph install 失败') };
  };

  return {
    available: cli.installed,
    ...(cli.version ? { version: cli.version } : {}),
    init: (dir) => initProject(runner, dir, onOutput),
    sync: (dir) => syncProject(runner, dir, onOutput),
    wireMcp,
    installCli: async (method) => {
      const { command, args } = buildInstallCommand(method);
      const result = await commandRunner(command, args, { timeoutMs: OP_TIMEOUT_MS, ...stream });
      if (result.code !== 0) return { ok: false, detail: failureDetail(result, '安装失败') };
      const after = await detectCli({ runner, bin, ...resolveOpt });
      if (!after.installed) {
        return { ok: false, detail: '安装命令已执行，但未检测到 codegraph，请检查 PATH 后重试' };
      }
      const status = await mcp().catch(() => ({ state: 'unknown' }) as CodegraphMcpStatus);
      if (status.state !== 'installed') {
        const wired = await wireMcp();
        if (!wired.ok) {
          return { ok: true, detail: `CLI 已安装；MCP 接入失败：${wired.detail ?? '未知错误'}` };
        }
      }
      return { ok: true, detail: `已安装 codegraph ${after.version ?? ''}`.trim() };
    },
  };
}
