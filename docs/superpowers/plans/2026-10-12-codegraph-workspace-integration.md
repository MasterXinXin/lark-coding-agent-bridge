# CodeGraph 工作空间集成 —— 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在控制台「工作空间」页集成 CodeGraph：检测/安装 CLI、接入 MCP、按项目初始化索引、git 更新后增量同步。

**Architecture:** 新增纯逻辑模块 `src/workspace/codegraph.ts`（进程 runner + 探测 + 作业侧 `CodegraphHook` 抽象），`git-jobs.ts` 扩展出 `codegraph` 作业类型并把 hook 注入 `addProjects`/`pullProjects`；HTTP 层新增 `/api/codegraph*` 端点；前端新增 `CodegraphCard` 并在项目行加索引徽章。行级状态只做文件系统探测（`<dir>/.codegraph/codegraph.db`），**绝不对未索引目录 spawn `codegraph status`**（实测会卡死）。

**Tech Stack:** TypeScript (ESM, Node ≥20) + vitest；控制台为 React 19 + Vite + Tailwind + Radix。

**Spec:** `docs/superpowers/specs/2026-10-12-codegraph-workspace-integration-design.md`

**Repository:** `D:\code\lark-coding-agent-bridge`（Windows / pwsh）

**通用约定**

- 每个任务严格 TDD：先写失败测试 → 跑红 → 实现 → 跑绿 → 提交。
- 单文件测试：`pnpm exec vitest run <path>`。
- 收尾必跑：`pnpm typecheck`；改动前端必跑 `pnpm build:web`。
- 提交信息用 conventional commits，一次任务一个提交。
- 代码风格跟随周围文件：`import type` 分离（`verbatimModuleSyntax`）、`...(cond ? { k: v } : {})` 可选字段、`noUncheckedIndexedAccess` 下用 `!` 或 `?? 0` 兜底。

---

## 文件结构

**新增**

| 文件 | 责任 |
|---|---|
| `src/workspace/codegraph.ts` | CodeGraph 核心：进程 runner、CLI 检测、MCP 配置探测、索引探测/统计、init/sync、安装命令、`CodegraphHook` |
| `src/ui/codegraph-api.ts` | 控制台只读视图：`codegraphSystemView()`、`codegraphProjectStatsView()` |
| `web/src/components/CodegraphCard.tsx` | 控制台 CodeGraph 卡片（三态） |
| `tests/unit/workspace/codegraph.test.ts` | 核心模块单测 |
| `tests/integration/ui/codegraph-views.test.ts` | `projectsView` 的 codegraph 字段 + 统计视图 |
| `tests/integration/workspace/codegraph-jobs.test.ts` | 自动 init / 按更新同步 / codegraph 作业 |

**修改**

| 文件 | 改动 |
|---|---|
| `src/workspace/git-jobs.ts` | `beginJob` 扩展 `codegraph` kind 与 hook 注入；新增 `startCodegraphJob` |
| `src/ui/workspace-api.ts` | `ProjectView.codegraph`、`listProjectTargets`、`projectDirById`；`addProjects`/`pullProjects` 接 hook |
| `src/workspace/scheduler.ts` | 定时拉取自动带上 codegraph hook |
| `src/ui/server.ts` | 新增 `/api/codegraph*` 路由；作业 deps 统一 |
| `src/ui/types.ts` | `UiServerDeps` 增加 codegraph 注入点 |
| `web/src/lib/types.ts` | codegraph 类型 + `ProjectView.codegraph` |
| `web/src/views/WorkspaceView.tsx` | 挂 `CodegraphCard`、项目行徽章与按钮 |
| `README.md` / `README.zh.md` | 文档补一句控制台 CodeGraph 能力 |

---

## Task 1: 核心模块 —— runner 与 CLI 检测

**Files**
- Create: `src/workspace/codegraph.ts`
- Test: `tests/unit/workspace/codegraph.test.ts`

**Step 1: 写失败测试**

创建 `tests/unit/workspace/codegraph.test.ts`：

```ts
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
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
```

预期：导入失败（模块不存在）。

**Step 3: 实现**

创建 `src/workspace/codegraph.ts`：

```ts
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
```

**Step 4: 跑绿**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
```

**Step 5: 提交**

```
git add src/workspace/codegraph.ts tests/unit/workspace/codegraph.test.ts
git commit -m "feat(codegraph): add the CLI runner and detection"
```

---

## Task 2: MCP 配置探测（含 JSONC 容错）

**Files**
- Modify: `src/workspace/codegraph.ts`
- Modify: `tests/unit/workspace/codegraph.test.ts`

**Step 1: 追加失败测试**

在测试文件顶部补导入：

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { hasCodegraphMcp, mcpStatus, parseJsonc } from '../../../src/workspace/codegraph';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});
```

追加：

```ts
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
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
```

**Step 3: 实现**

在 `src/workspace/codegraph.ts` 末尾追加：

```ts
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

/** Strip `//`, `/* *\/` comments and trailing commas so JSONC parses as JSON. */
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
```

**Step 4: 跑绿 + 提交**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
git add src/workspace/codegraph.ts tests/unit/workspace/codegraph.test.ts
git commit -m "feat(codegraph): detect the opencode MCP entry with a JSONC parser"
```

---

## Task 3: 索引探测与统计（绝不误 spawn）

**Files**
- Modify: `src/workspace/codegraph.ts`
- Modify: `tests/unit/workspace/codegraph.test.ts`

**Step 1: 追加失败测试**

补导入 `mkdir` 与 `EMPTY_CODEGRAPH_STATS, projectIndexInfo, projectStats`，追加：

```ts
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
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
```

**Step 3: 实现**

在 `src/workspace/codegraph.ts` 追加：

```ts
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
```

**Step 4: 跑绿 + 提交**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
git add src/workspace/codegraph.ts tests/unit/workspace/codegraph.test.ts
git commit -m "feat(codegraph): probe index state and stats without hanging on status"
```

---

## Task 4: init / sync / 安装 / Hook 组装

**Files**
- Modify: `src/workspace/codegraph.ts`
- Modify: `tests/unit/workspace/codegraph.test.ts`

**Step 1: 追加失败测试**

补导入 `buildInstallCommand, createCodegraphHook, initProject, syncProject`，追加：

```ts
describe('initProject / syncProject', () => {
  it('runs init then sync against a directory', async () => {
    const { runner, calls } = recordingRunner(() => ({ code: 0 }));
    expect(await initProject(runner, '/p')).toEqual({ ok: true });
    expect(await syncProject(runner, '/p')).toEqual({ ok: true });
    expect(calls).toEqual([['init', '/p'], ['sync', '/p']]);
  });

  it('surfaces stderr as the failure detail', async () => {
    const { runner } = recordingRunner(() => ({ code: 2, stderr: 'nope' }));
    expect(await initProject(runner, '/p')).toEqual({ ok: false, detail: 'nope' });
  });
});

describe('buildInstallCommand', () => {
  it('uses npm for the npm method', () => {
    expect(buildInstallCommand('npm', 'darwin')).toEqual({
      command: 'npm',
      args: ['i', '-g', '@colbymchenry/codegraph'],
    });
  });

  it('uses powershell on Windows and sh elsewhere', () => {
    expect(buildInstallCommand('script', 'win32').args.join(' ')).toContain('install.ps1');
    const posix = buildInstallCommand('script', 'darwin');
    expect(posix.command).toBe('sh');
    expect(posix.args.join(' ')).toContain('install.sh');
  });
});

describe('createCodegraphHook', () => {
  const fakeCli = (available: boolean) =>
    recordingRunner(() => (available ? { code: 0, stdout: '0.9.9\n' } : { code: 1 }));

  it('is unavailable when the CLI is missing', async () => {
    const hook = await createCodegraphHook({
      runner: fakeCli(false).runner,
      resolve: async () => '/x/codegraph',
    });
    expect(hook.available).toBe(false);
  });

  it('runs init and sync against the project directory', async () => {
    const cli = fakeCli(true);
    const hook = await createCodegraphHook({ runner: cli.runner, resolve: async () => '/x/codegraph' });
    expect(hook.available).toBe(true);
    expect(await hook.init('/p')).toEqual({ ok: true });
    expect(await hook.sync('/p')).toEqual({ ok: true });
    expect(cli.calls).toEqual([['--version'], ['init', '/p'], ['sync', '/p']]);
  });

  it('installs via npm and wires the MCP when it is missing', async () => {
    const cli = fakeCli(true);
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const hook = await createCodegraphHook({
      runner: cli.runner,
      resolve: async () => '/x/codegraph',
      mcp: async () => ({ state: 'missing' }),
      commandRunner: async (command, args) => {
        commandCalls.push({ command, args: [...args] });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect((await hook.installCli('npm')).ok).toBe(true);
    expect(commandCalls).toEqual([{ command: 'npm', args: ['i', '-g', '@colbymchenry/codegraph'] }]);
    expect(cli.calls).toEqual([['--version'], ['--version'], ['install', '--yes']]);
  });

  it('skips wiring when the MCP is already present', async () => {
    const cli = fakeCli(true);
    const hook = await createCodegraphHook({
      runner: cli.runner,
      resolve: async () => '/x/codegraph',
      mcp: async () => ({ state: 'installed', configPath: '/c.jsonc' }),
      commandRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    await hook.installCli('script');
    expect(cli.calls).toEqual([['--version'], ['--version']]);
  });
});
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
```

**Step 3: 实现**

在 `src/workspace/codegraph.ts` 追加：

```ts
export interface CodegraphOpResult {
  ok: boolean;
  detail?: string;
}

const OP_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

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
  return result.code === 0 ? { ok: true } : { ok: false, detail: failureDetail(result, 'codegraph init 失败') };
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
  return result.code === 0 ? { ok: true } : { ok: false, detail: failureDetail(result, 'codegraph sync 失败') };
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
      const result = await commandRunner(command, args, { timeoutMs: INSTALL_TIMEOUT_MS, ...stream });
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
```

**Step 4: 跑绿 + 提交**

```
pnpm exec vitest run tests/unit/workspace/codegraph.test.ts
git add src/workspace/codegraph.ts tests/unit/workspace/codegraph.test.ts
git commit -m "feat(codegraph): add init/sync, install commands, and the job hook"
```

---

## Task 5: `projectsView` 暴露 codegraph 状态 + 目标解析

**Files**
- Modify: `src/ui/workspace-api.ts`
- Test: `tests/integration/ui/codegraph-views.test.ts`

**Step 1: 写失败测试**

创建 `tests/integration/ui/codegraph-views.test.ts`：

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { ProjectStore } from '../../../src/workspace/projects';
import {
  listProjectTargets,
  projectDirById,
  projectsView,
} from '../../../src/ui/workspace-api';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cgviews-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig(
    'claude',
    createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
  );
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function addStoredProject(name: string): Promise<string> {
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  const entry = store.add({ repoUrl: `https://example.com/${name}.git`, name, localPath: name });
  await store.flush();
  await mkdir(join(workspace, name), { recursive: true });
  return entry.id;
}

describe('projectsView codegraph state', () => {
  it('marks an indexed project and leaves an unindexed one false', async () => {
    const indexedId = await addStoredProject('indexed');
    await addStoredProject('plain');
    await mkdir(join(workspace, 'indexed', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'indexed', '.codegraph', 'codegraph.db'), 'x');

    const view = await projectsView('claude', rootDir);
    const byId = new Map(view.projects.map((p) => [p.id, p]));
    expect(byId.get(indexedId)!.codegraph.indexed).toBe(true);
    expect(byId.get(indexedId)!.codegraph.dbSizeBytes).toBe(1);
  });
});

describe('project targets', () => {
  it('lists targets and resolves a directory by id', async () => {
    const id = await addStoredProject('alpha');
    const targets = await listProjectTargets('claude', rootDir);
    expect(targets).toEqual([{ id, name: 'alpha', dir: join(workspace, 'alpha') }]);
    expect(await projectDirById('claude', rootDir, id)).toBe(join(workspace, 'alpha'));
  });

  it('throws 404 for an unknown id', async () => {
    await expect(projectDirById('claude', rootDir, 'missing')).rejects.toThrow(/项目不存在/);
  });
});
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/integration/ui/codegraph-views.test.ts
```

**Step 3: 实现**

在 `src/ui/workspace-api.ts`：

1. 顶部加导入：

```ts
import { projectIndexInfo, type CodegraphIndexInfo } from '../workspace/codegraph';
```

2. `ProjectView` 增加字段：

```ts
export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  accountId?: string;
  absolutePath: string;
  exists: boolean;
  status: RepoStatus;
  lastPullAt?: string;
  codegraph: CodegraphIndexInfo;
}
```

3. `projectsView` 循环里在解析 `absolutePath` 后探测索引：

```ts
  for (const project of store.list()) {
    let absolutePath = '';
    let exists = false;
    let status: RepoStatus = ZERO_STATUS;
    let codegraph: CodegraphIndexInfo = { indexed: false };
    try {
      absolutePath = resolveProjectDir(workspaceDir, project.localPath);
      codegraph = await projectIndexInfo(absolutePath);
      exists = await isGitRepo(run, absolutePath).catch(() => false);
      if (exists) status = await repoStatus(run, absolutePath).catch(() => ZERO_STATUS);
    } catch {
      // Stored path no longer lies within the workspace (e.g. the workspace
      // root was changed). Surface it as missing instead of failing the view.
    }
    projects.push({
      ...project,
      absolutePath,
      exists,
      status,
      codegraph,
      ...(lastByProject.get(project.id) ? { lastPullAt: lastByProject.get(project.id)! } : {}),
    });
  }
```

4. 文件末尾追加：

```ts
export interface ProjectTarget {
  id: string;
  name: string;
  dir: string;
}

/** Every project that resolves inside the workspace, paired with its checkout dir. */
export async function listProjectTargets(
  profile: string,
  rootDir?: string,
): Promise<ProjectTarget[]> {
  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const out: ProjectTarget[] = [];
  for (const project of store.list()) {
    try {
      out.push({
        id: project.id,
        name: project.name,
        dir: resolveProjectDir(workspaceDir, project.localPath),
      });
    } catch {
      // A stored path outside the workspace cannot be indexed here; skip it.
    }
  }
  return out;
}

/** Resolve one project's checkout dir by id, or 404. */
export async function projectDirById(
  profile: string,
  rootDir: string | undefined,
  id: string,
): Promise<string> {
  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const entry = store.get(id);
  if (!entry) throw new HttpError(404, `项目不存在：${id}`);
  return resolveProjectDir(workspaceDir, entry.localPath);
}
```

**Step 4: 跑绿 + typecheck + 提交**

```
pnpm exec vitest run tests/integration/ui/codegraph-views.test.ts
pnpm typecheck
git add src/ui/workspace-api.ts tests/integration/ui/codegraph-views.test.ts
git commit -m "feat(workspace): expose per-project codegraph state and targets"
```

---

## Task 6: `addProjects` clone 后自动 init

**Files**
- Modify: `src/ui/workspace-api.ts`
- Modify: `tests/integration/workspace/codegraph-jobs.test.ts`（新建）

**Step 1: 写失败测试**

创建 `tests/integration/workspace/codegraph-jobs.test.ts`（复用 `git-jobs.test.ts` 的真实本地 origin 模式）：

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { createGitRunner, type GitRunner } from '../../../src/git/git-ops';
import { addProjects, pullProjects } from '../../../src/ui/workspace-api';
import type { CodegraphHook, CodegraphOpResult } from '../../../src/workspace/codegraph';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-cgjobs-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig(
    'claude',
    createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
  );
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

async function makeOrigin(base: string): Promise<string> {
  const origin = join(base, 'origin.git');
  git(base, ['init', '--bare', origin]);
  const seed = join(base, 'seed');
  git(base, ['clone', origin, seed]);
  git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return origin;
}

function recordingHook(available = true): { hook: CodegraphHook; initDirs: string[]; syncDirs: string[] } {
  const initDirs: string[] = [];
  const syncDirs: string[] = [];
  const ok: CodegraphOpResult = { ok: true };
  const hook: CodegraphHook = {
    available,
    init: async (dir) => {
      initDirs.push(dir);
      return ok;
    },
    sync: async (dir) => {
      syncDirs.push(dir);
      return ok;
    },
    installCli: async () => ok,
    wireMcp: async () => ok,
  };
  return { hook, initDirs, syncDirs };
}

const runner = (): GitRunner => createGitRunner();

describe('codegraph hook wiring', { timeout: 60_000 }, () => {
  it('initialises a freshly cloned project once', async () => {
    const origin = await makeOrigin(rootDir);
    const { hook, initDirs } = recordingHook();
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] }, runner(), undefined, hook);
    expect(initDirs).toEqual([join(workspace, 'x')]);
  });

  it('skips init when codegraph is unavailable', async () => {
    const origin = await makeOrigin(rootDir);
    const { hook, initDirs } = recordingHook(false);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] }, runner(), undefined, hook);
    expect(initDirs).toEqual([]);
  });

  it('syncs only when a pull actually updated and the project is indexed', async () => {
    const origin = await makeOrigin(rootDir);
    const { hook, syncDirs } = recordingHook();
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] }, runner(), undefined, hook);
    // Not yet indexed -> an up-to-date pull must not sync.
    await pullProjects('claude', rootDir, {}, runner(), undefined, 'manual', hook);
    expect(syncDirs).toEqual([]);

    // Index it, then push a new commit so the next pull updates.
    await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
    await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');
    const seed = join(rootDir, 'seed');
    git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'more']);
    git(seed, ['push', 'origin', 'main']);
    await pullProjects('claude', rootDir, {}, runner(), undefined, 'manual', hook);
    expect(syncDirs).toEqual([join(workspace, 'x')]);
  });
});
```

**Step 2: 跑红**

```
pnpm exec vitest run tests/integration/workspace/codegraph-jobs.test.ts
```

预期：`addProjects`/`pullProjects` 第 6/7 参数类型报错或行为不触发。

**Step 3: 实现**

在 `src/ui/workspace-api.ts`：

1. 导入 hook 类型：

```ts
import { projectIndexInfo, type CodegraphHook, type CodegraphIndexInfo } from '../workspace/codegraph';
```

2. `addProjects` 增加末位参数并在 clone 成功后 init：

```ts
export async function addProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
  codegraph?: CodegraphHook,
): Promise<ProjectsView> {
```

在 `ensureCheckout` 的 `try` 之后（仍在 `for` 循环内、`store.flush` 之前）插入：

```ts
      if (codegraph?.available) {
        // Indexing is best-effort: a failure must not roll back a clone that
        // succeeded, so it only logs and the row shows "未索引" for a retry.
        try {
          if (!(await projectIndexInfo(dir)).indexed) {
            const indexed = await codegraph.init(dir);
            if (!indexed.ok) {
              log.warn('workspace', 'codegraph-init-failed', { id: entry.id, detail: indexed.detail });
            }
          }
        } catch (err) {
          log.warn('workspace', 'codegraph-init-failed', { id: entry.id, err: String(err) });
        }
      }
```

> 注意 `dir` 在循环里已由 `resolveProjectDir(workspaceDir, localPath)` 定义，此处可复用。

**Step 4: 跑绿（Task 7 的同步用例此时仍红）**

```
pnpm exec vitest run tests/integration/workspace/codegraph-jobs.test.ts -t "initialises"
```

提交（Task 7 一起提交，见下）。

---

## Task 7: `pullProjects` 仅在更新时同步

**Files**
- Modify: `src/ui/workspace-api.ts`

**Step 1: 实现**

`pullProjects` 增加末位参数：

```ts
export async function pullProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
  trigger: PullTrigger = 'manual',
  codegraph?: CodegraphHook,
): Promise<{ results: PullRunItem[] }> {
```

把原来 `pullRepo` 之后的分支改为：

```ts
        const outcome = await pullRepo(projectRun, dir, schedule.strategy);
        result = outcome.status;
        detail = outcome.detail;
        if (outcome.status === 'updated' && codegraph?.available) {
          // Only a real update needs re-indexing; "up-to-date"/"skipped" do not.
          // A sync failure must not downgrade a successful pull, so swallow+log.
          try {
            if ((await projectIndexInfo(dir)).indexed) {
              const synced = await codegraph.sync(dir);
              if (!synced.ok) {
                log.warn('workspace', 'codegraph-sync-failed', { id: project.id, detail: synced.detail });
              }
            } else {
              log.info('workspace', 'codegraph-sync-skipped', { id: project.id, reason: 'not-indexed' });
            }
          } catch (err) {
            log.warn('workspace', 'codegraph-sync-failed', { id: project.id, err: String(err) });
          }
        }
```

**Step 2: 跑绿 + typecheck + 提交**

```
pnpm exec vitest run tests/integration/workspace/codegraph-jobs.test.ts
pnpm typecheck
git add src/ui/workspace-api.ts tests/integration/workspace/codegraph-jobs.test.ts
git commit -m "feat(workspace): auto-init cloned projects and sync on updates"
```

---

## Task 8: 作业层 —— `codegraph` kind、hook 注入、定时拉取

**Files**
- Modify: `src/workspace/git-jobs.ts`
- Modify: `src/workspace/scheduler.ts`
- Modify: `tests/integration/workspace/git-jobs.test.ts`

**Step 1: 追加失败测试**

在 `tests/integration/workspace/git-jobs.test.ts` 追加：

```ts
it('runs a codegraph sync job and reports per-project results', async () => {
  const origin = await makeOrigin(rootDir);
  const registry = new JobRegistry();
  await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] }, makeRecording([]));
  await mkdir(join(workspace, 'x', '.codegraph'), { recursive: true });
  await writeFile(join(workspace, 'x', '.codegraph', 'codegraph.db'), 'x');

  const syncDirs: string[] = [];
  const hook: CodegraphHook = {
    available: true,
    init: async () => ({ ok: true }),
    sync: async (dir) => {
      syncDirs.push(dir);
      return { ok: true };
    },
    installCli: async () => ({ ok: true }),
    wireMcp: async () => ({ ok: true }),
  };

  const { id } = startCodegraphJob('claude', rootDir, { action: 'sync', all: true }, { registry, codegraph: hook });
  const snap = await waitForJob(registry, id);
  expect(snap.status).toBe('succeeded');
  expect(syncDirs).toEqual([join(workspace, 'x')]);
});
```

补导入：

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { addProjects } from '../../../src/ui/workspace-api';
import { startAddJob, startPullJob, startCodegraphJob } from '../../../src/workspace/git-jobs';
import type { CodegraphHook } from '../../../src/workspace/codegraph';
```

（`git-jobs.test.ts` 现有导入里 `addProjects` 未导入；按需合并。）

**Step 2: 跑红**

```
pnpm exec vitest run tests/integration/workspace/git-jobs.test.ts
```

**Step 3: 实现 `src/workspace/git-jobs.ts`**

替换导入与 `StartJobDeps`、`beginJob`、新增 codegraph 作业：

```ts
import { log } from '../core/logger';
import { createGitRunner, type GitRunner } from '../git/git-ops';
import { addProjects, listProjectTargets, pullProjects } from '../ui/workspace-api';
import {
  createCodegraphHook,
  projectIndexInfo,
  type CodegraphHook,
  type CodegraphRunner,
  type CommandRunner,
  type ExecutableResolver,
} from './codegraph';
import { HttpError } from '../ui/http';
import { JobRegistry } from './jobs';

/** Process-wide registry backing the console's `GET /api/jobs/:id` route. */
export const jobRegistry = new JobRegistry();

export interface StartJobDeps {
  /** Git runner to use; defaults to the real `git` binary. Tests inject a recorder. */
  runner?: GitRunner;
  /** Registry to record into; defaults to the process-wide `jobRegistry`. */
  registry?: JobRegistry;
  /** Strings to scrub from every log line / error message. */
  redact?: string[];
  /** Test seam: a fully fake hook that bypasses detection and spawning. */
  codegraph?: CodegraphHook;
  /** Test seam: a recorder used to build the real hook. */
  codegraphRunner?: CodegraphRunner;
  /** Test seam: a recorder for the CLI install command. */
  commandRunner?: CommandRunner;
  /** Override the codegraph binary name. */
  codegraphBin?: string;
  /** Test seam: override executable resolution inside the hook. */
  codegraphResolve?: ExecutableResolver;
}

type OnStep = (info: { id: string; name: string }) => void;
```

`beginJob` 改为：

```ts
function beginJob(
  kind: 'add' | 'pull' | 'codegraph',
  label: string,
  deps: StartJobDeps,
  work: (runner: GitRunner, onStep: OnStep, codegraph: CodegraphHook | undefined) => Promise<unknown>,
): { id: string } {
  const registry = deps.registry ?? jobRegistry;
  const base = deps.runner ?? createGitRunner();
  const { id: jobId } = registry.create({ kind, label, redact: deps.redact ?? [] });

  let currentStep: string | undefined;
  const runner: GitRunner = (args, opts) =>
    base(args, {
      ...(opts ?? {}),
      onOutput: (chunk) =>
        registry.append(jobId, {
          ...(currentStep ? { stepId: currentStep } : {}),
          stream: 'stderr',
          text: chunk,
        }),
    });

  const onStep: OnStep = (info) => {
    registry.addStep(jobId, info);
    currentStep = info.id;
    registry.append(jobId, { stepId: info.id, stream: 'info', text: `开始处理 ${info.name}` });
  };

  void (async () => {
    try {
      registry.append(jobId, { stream: 'info', text: `任务已启动：${label}` });
      const codegraph =
        deps.codegraph ??
        (await createCodegraphHook({
          ...(deps.codegraphRunner ? { runner: deps.codegraphRunner } : {}),
          ...(deps.commandRunner ? { commandRunner: deps.commandRunner } : {}),
          ...(deps.codegraphBin ? { bin: deps.codegraphBin } : {}),
          ...(deps.codegraphResolve ? { resolve: deps.codegraphResolve } : {}),
          onOutput: (chunk) => registry.append(jobId, { stream: 'stderr', text: chunk }),
        }).catch((err) => {
          log.fail('workspace', err, { step: 'codegraph-hook', jobId });
          return undefined;
        }));
      registry.finish(jobId, await work(runner, onStep, codegraph));
    } catch (err) {
      registry.fail(jobId, err instanceof Error ? err.message : String(err));
      log.fail('workspace', err, { step: 'workspace-job', jobId });
    }
  })().catch(() => undefined);

  return { id: jobId };
}
```

`startAddJob` / `startPullJob` 传入 hook：

```ts
export function startAddJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  return beginJob('add', addLabel(body), deps, (runner, onStep, codegraph) =>
    addProjects(profile, rootDir, body, runner, onStep, codegraph),
  );
}

export function startPullJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  return beginJob('pull', pullLabel(body), deps, (runner, onStep, codegraph) =>
    pullProjects(profile, rootDir, body, runner, onStep, 'manual', codegraph),
  );
}
```

新增 codegraph 作业：

```ts
interface CodegraphJobBody {
  action?: unknown;
  method?: unknown;
  id?: unknown;
  all?: unknown;
}

function codegraphLabel(raw: CodegraphJobBody): string {
  switch (raw.action) {
    case 'cli-install':
      return '安装 CodeGraph CLI';
    case 'mcp-install':
      return '接入 CodeGraph MCP';
    case 'init':
      return raw.all === true ? '初始化全部未索引项目' : '初始化项目索引';
    case 'sync':
      return raw.all === true ? '同步全部项目索引' : '同步项目索引';
    default:
      return 'CodeGraph 操作';
  }
}

async function runCodegraphAction(
  profile: string,
  rootDir: string | undefined,
  raw: CodegraphJobBody,
  codegraph: CodegraphHook | undefined,
  onStep: OnStep,
): Promise<unknown> {
  if (!codegraph) throw new Error('codegraph 不可用：请先安装 CodeGraph CLI');
  const action = typeof raw.action === 'string' ? raw.action : '';
  if (action === 'cli-install') return codegraph.installCli(raw.method === 'npm' ? 'npm' : 'script');
  if (action === 'mcp-install') return codegraph.wireMcp();
  if (action !== 'init' && action !== 'sync') {
    throw new HttpError(400, `未知的 codegraph 操作：${action}`);
  }

  const targets = await listProjectTargets(profile, rootDir);
  let selected = targets;
  if (raw.all !== true) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const found = targets.find((t) => t.id === id);
    if (!found) throw new HttpError(404, `项目不存在：${id}`);
    selected = [found];
  }

  const results: Array<{ id: string; name: string; ok: boolean; detail?: string }> = [];
  for (const target of selected) {
    const info = await projectIndexInfo(target.dir);
    if (action === 'sync' && !info.indexed) {
      results.push({ id: target.id, name: target.name, ok: false, detail: '未索引，已跳过（可先初始化）' });
      continue;
    }
    if (action === 'init' && info.indexed) {
      results.push({ id: target.id, name: target.name, ok: true, detail: '已索引，跳过' });
      continue;
    }
    onStep({ id: target.id, name: target.name });
    const outcome = action === 'init' ? await codegraph.init(target.dir) : await codegraph.sync(target.dir);
    results.push({ id: target.id, name: target.name, ...outcome });
  }
  return { results };
}

/** Start a background CodeGraph job (CLI install / MCP wire / init / sync). */
export function startCodegraphJob(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  deps: StartJobDeps = {},
): { id: string } {
  const raw = (body && typeof body === 'object' ? body : {}) as CodegraphJobBody;
  return beginJob('codegraph', codegraphLabel(raw), deps, (_runner, onStep, codegraph) =>
    runCodegraphAction(profile, rootDir, raw, codegraph, onStep),
  );
}
```

**Step 4: 实现 `src/workspace/scheduler.ts`**

补导入 `createCodegraphHook`，把默认 `runProfile` 改为：

```ts
    this.runProfile =
      deps.runProfile ??
      (async (profile) => {
        const codegraph = await createCodegraphHook().catch((err) => {
          log.warn('scheduler', 'codegraph-hook-failed', { profile, err: String(err) });
          return undefined;
        });
        const { results } = await pullProjects(
          profile,
          rootDir,
          {},
          undefined,
          undefined,
          'schedule',
          codegraph,
        );
        return results.map((r) => ({ name: r.name, result: r.result, detail: r.detail }));
      });
```

**Step 5: 跑绿 + typecheck + 提交**

```
pnpm exec vitest run tests/integration/workspace/git-jobs.test.ts tests/integration/workspace/codegraph-jobs.test.ts
pnpm exec vitest run tests/unit/workspace/scheduler.test.ts
pnpm typecheck
git add src/workspace/git-jobs.ts src/workspace/scheduler.ts tests/integration/workspace/git-jobs.test.ts
git commit -m "feat(workspace): add the codegraph job kind and scheduled sync"
```

---

## Task 9: HTTP 端点与状态视图

**Files**
- Create: `src/ui/codegraph-api.ts`
- Modify: `src/ui/server.ts`
- Modify: `src/ui/types.ts`
- Test: `tests/integration/ui/codegraph-routes.test.ts`

**Step 1: 写失败测试**

创建 `tests/integration/ui/codegraph-routes.test.ts`。先看 `tests/integration/ui/` 里现有“起服务 + 带 token 请求”的测试作为骨架（`server.test.ts` 或 `workspace-routes.test.ts`），复用其 `startUiServer` + fetch 辅助。核心断言：

```ts
import { describe, expect, it } from 'vitest';
import type { CodegraphHook } from '../../../src/workspace/codegraph';

// 假设 helper: startServer(deps) -> { url, token, close }, get(path)/post(path, body) 带 x-ui-token
describe('codegraph routes', () => {
  it('GET /api/codegraph returns the injected system view', async () => {
    const server = await startServer({
      codegraphStatus: async () => ({
        cli: { installed: true, version: '0.9.9' },
        mcp: { state: 'installed', configPath: '/c.jsonc' },
      }),
    });
    const view = await get(server, '/api/codegraph?profile=claude');
    expect(view).toEqual({
      cli: { installed: true, version: '0.9.9' },
      mcp: { state: 'installed', configPath: '/c.jsonc' },
    });
  });

  it('POST /api/codegraph/init returns 202 with a job id and runs the hook', async () => {
    const initDirs: string[] = [];
    const hook: CodegraphHook = {
      available: true,
      init: async (dir) => {
        initDirs.push(dir);
        return { ok: true };
      },
      sync: async () => ({ ok: true }),
      installCli: async () => ({ ok: true }),
      wireMcp: async () => ({ ok: true }),
    };
    const server = await startServer({ codegraph: hook });
    // 前置：workspace 里已有一个项目（复用 helper 创建 tmp profile + 项目）
    const res = await post(server, '/api/codegraph/init?profile=claude', { all: true });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    // 轮询 /api/jobs/:id 直到 succeeded
    await waitForJob(server, res.body.jobId);
    expect(initDirs).toHaveLength(1);
  });

  it('POST /api/codegraph/cli/install returns 202', async () => {
    const hook: CodegraphHook = {
      available: false,
      init: async () => ({ ok: true }),
      sync: async () => ({ ok: true }),
      installCli: async () => ({ ok: true }),
      wireMcp: async () => ({ ok: true }),
    };
    const server = await startServer({ codegraph: hook });
    const res = await post(server, '/api/codegraph/cli/install?profile=claude', { method: 'npm' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
  });
});
```

> 实现时按 `tests/integration/ui/` 现有 helper 的实际形状调整 `startServer` / `get` / `post`（若尚无通用 helper，就照抄最近一个 route 测试的 `startUiServer({ supervisor: ..., version: 'test', rootDir })` 与 `fetch(url, { headers: { 'x-ui-token': token } })` 写法）。

**Step 2: 跑红**

```
pnpm exec vitest run tests/integration/ui/codegraph-routes.test.ts
```

**Step 3: 实现 `src/ui/codegraph-api.ts`**

```ts
import {
  createCodegraphRunner,
  detectCli,
  mcpStatus,
  projectStats,
  type CodegraphCliStatus,
  type CodegraphMcpStatus,
  type CodegraphRunner,
  type CodegraphStats,
} from '../workspace/codegraph';
import { projectDirById } from './workspace-api';

export interface CodegraphSystemView {
  cli: CodegraphCliStatus;
  mcp: CodegraphMcpStatus;
}

export async function codegraphSystemView(): Promise<CodegraphSystemView> {
  const [cli, mcp] = await Promise.all([detectCli(), mcpStatus()]);
  return { cli, mcp };
}

export async function codegraphProjectStatsView(
  profile: string,
  rootDir: string | undefined,
  id: string,
  runner: CodegraphRunner = createCodegraphRunner(),
): Promise<CodegraphStats> {
  const dir = await projectDirById(profile, rootDir, id);
  return projectStats(runner, dir);
}
```

**Step 4: 实现 `src/ui/types.ts`**

补导入：

```ts
import type {
  CodegraphHook,
  CodegraphRunner,
  CommandRunner,
} from '../workspace/codegraph';
import type { CodegraphSystemView } from './codegraph-api';
```

`UiServerDeps` 追加：

```ts
  /** Injectable codegraph hook for jobs (tests pass a fake). */
  codegraph?: CodegraphHook;
  /** Injectable codegraph runner (tests pass a recorder). */
  codegraphRunner?: CodegraphRunner;
  /** Injectable command runner for CLI install (tests pass a recorder). */
  commandRunner?: CommandRunner;
  /** Override the system-status probe (tests pass a stub). */
  codegraphStatus?: () => Promise<CodegraphSystemView>;
```

**Step 5: 实现 `src/ui/server.ts`**

补导入：

```ts
import { codegraphProjectStatsView, codegraphSystemView } from './codegraph-api';
import { jobRegistry, startAddJob, startCodegraphJob, startPullJob, type StartJobDeps } from '../workspace/git-jobs';
```

文件内加一个 deps 归并函数（放在 `route` 之前）：

```ts
function jobDeps(deps: UiServerDeps): StartJobDeps {
  return {
    ...(deps.gitRunner ? { runner: deps.gitRunner } : {}),
    registry: deps.jobRegistry ?? jobRegistry,
    ...(deps.codegraph ? { codegraph: deps.codegraph } : {}),
    ...(deps.codegraphRunner ? { codegraphRunner: deps.codegraphRunner } : {}),
    ...(deps.commandRunner ? { commandRunner: deps.commandRunner } : {}),
  };
}
```

把现有 `startAddJob` / `startPullJob` 的 deps 字面量替换为 `jobDeps(deps)`：

```ts
    const { id: jobId } = startAddJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
```

```ts
    const { id: jobId } = startPullJob(profile, deps.rootDir, await readJsonBody(req), jobDeps(deps));
```

在 `/api/projects/pull` 路由块之后、`/api/schedule` 之前插入 codegraph 路由：

```ts
  // --- codegraph (per-project code index) ---
  if (path === '/api/codegraph' && g) {
    const status = deps.codegraphStatus ?? codegraphSystemView;
    sendJson(res, 200, await status());
    return;
  }
  if (path === '/api/codegraph/project' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const id = url.searchParams.get('id') ?? '';
    if (!id) throw new HttpError(400, 'id is required');
    sendJson(res, 200, await codegraphProjectStatsView(profile, deps.rootDir, id, deps.codegraphRunner));
    return;
  }
  if (path === '/api/codegraph/cli/install' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'cli-install' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/mcp/install' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { action: 'mcp-install' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/init' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'init' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
  if (path === '/api/codegraph/sync' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { id: jobId } = startCodegraphJob(profile, deps.rootDir, { ...body, action: 'sync' }, jobDeps(deps));
    sendJson(res, 202, { jobId });
    return;
  }
```

**Step 6: 跑绿 + typecheck + 提交**

```
pnpm exec vitest run tests/integration/ui/codegraph-routes.test.ts
pnpm typecheck
git add src/ui/codegraph-api.ts src/ui/server.ts src/ui/types.ts tests/integration/ui/codegraph-routes.test.ts
git commit -m "feat(ui): add the codegraph API routes"
```

---

## Task 10: 前端类型与 `CodegraphCard`

**Files**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/components/CodegraphCard.tsx`

**Step 1: 扩展 `web/src/lib/types.ts`**

`ProjectView` 增加字段（放在 `lastPullAt?` 之后）：

```ts
  codegraph: CodegraphIndexInfo;
```

并在 `ProjectView` 之前新增：

```ts
export interface CodegraphIndexInfo {
  indexed: boolean;
  dbPath?: string;
  dbSizeBytes?: number;
  updatedAt?: string;
}

export interface CodegraphCliStatus {
  installed: boolean;
  version?: string;
  binaryPath?: string;
}

export type CodegraphMcpState = "installed" | "missing" | "unknown";

export interface CodegraphMcpStatus {
  state: CodegraphMcpState;
  configPath?: string;
}

export interface CodegraphSystemView {
  cli: CodegraphCliStatus;
  mcp: CodegraphMcpStatus;
}

export interface CodegraphStats {
  initialized: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
  pendingChanges: { added: number; modified: number; removed: number };
}
```

**Step 2: 创建 `web/src/components/CodegraphCard.tsx`**

```tsx
import { useState } from "react";
import { apiPost } from "@/lib/api";
import type { CodegraphSystemView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

type InstallMethod = "script" | "npm";

export function CodegraphCard({
  profile,
  system,
  busy,
  unindexedCount,
  onJob,
  onRefresh,
}: {
  profile: string;
  system: CodegraphSystemView | null;
  busy: boolean;
  unindexedCount: number;
  onJob: (jobId: string) => void;
  onRefresh: () => void;
}) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [method, setMethod] = useState<InstallMethod>("script");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [posting, setPosting] = useState(false);

  async function post(path: string, body: unknown) {
    setPosting(true);
    try {
      const { jobId } = await apiPost<{ jobId: string }>(`${path}?${q}`, body);
      setConfirmOpen(false);
      onJob(jobId);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setPosting(false);
    }
  }

  const installed = system?.cli.installed ?? false;
  const mcpState = system?.mcp.state ?? "unknown";
  const disabled = busy || posting;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>CodeGraph 代码索引</CardTitle>
        <div className="flex items-center gap-2">
          {installed ? (
            <Badge variant="success">CLI {system?.cli.version ?? ""}</Badge>
          ) : (
            <Badge variant="destructive">CLI 未安装</Badge>
          )}
          {installed &&
            (mcpState === "installed" ? (
              <Badge variant="success">MCP 已接入</Badge>
            ) : mcpState === "missing" ? (
              <Badge variant="secondary">MCP 未接入</Badge>
            ) : (
              <Badge variant="secondary">MCP 未知</Badge>
            ))}
          <Button variant="outline" size="sm" disabled={disabled} onClick={onRefresh}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!installed && (
          <>
            <p className="text-xs text-muted-foreground">
              未检测到 codegraph CLI。安装后可为每个项目建立本地代码知识图谱，供 opencode / codex 等
              agent 查询。
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label>安装方式</Label>
                <Select
                  value={method}
                  onValueChange={(v) => setMethod(v as InstallMethod)}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="script">官方安装脚本（推荐）</SelectItem>
                    <SelectItem value="npm">npm 全局安装</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={disabled} onClick={() => setConfirmOpen(true)}>
                安装 CodeGraph
              </Button>
            </div>
          </>
        )}

        {installed && mcpState !== "installed" && (
          <>
            <p className="text-xs text-muted-foreground">
              CLI 已安装，但本机 agent 尚未接入 codegraph MCP。接入后需重启 bridge / opencode 才生效。
            </p>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => void post("/api/codegraph/mcp/install", {})}
            >
              接入 CodeGraph MCP
            </Button>
          </>
        )}

        {installed && mcpState === "installed" && (
          <>
            <p className="text-xs text-muted-foreground">
              MCP 已接入
              {system?.mcp.configPath ? `（${system.mcp.configPath}）` : ""}
              。新项目 clone 后会自动建立索引；git 有更新时自动增量同步。
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={disabled || unindexedCount === 0}
                onClick={() => void post("/api/codegraph/init", { all: true })}
              >
                初始化全部未索引项目{unindexedCount > 0 ? `（${unindexedCount}）` : ""}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void post("/api/codegraph/sync", { all: true })}
              >
                全部同步
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>安装 CodeGraph</DialogTitle>
            <DialogDescription>
              {method === "npm"
                ? "将执行 npm i -g @colbymchenry/codegraph。"
                : "将执行 codegraph 官方安装脚本，需要联网。"}
              安装完成后会自动尝试接入本机 agent（codegraph install --yes）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={disabled}>
              取消
            </Button>
            <Button
              onClick={() => void post("/api/codegraph/cli/install", { method })}
              disabled={disabled}
            >
              确认安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
```

**Step 3: 验证编译**

```
pnpm build:web
```

**Step 4: 提交**

```
git add web/src/lib/types.ts web/src/components/CodegraphCard.tsx
git commit -m "feat(web): add the CodeGraph card and codegraph types"
```

---

## Task 11: 接入 `WorkspaceView`（卡片 + 项目行徽章）

**Files**
- Modify: `web/src/views/WorkspaceView.tsx`

**Step 1: 挂载卡片**

1. 类型导入追加 `CodegraphSystemView`；组件导入追加 `CodegraphCard`。
2. state 增加：

```tsx
  const [system, setSystem] = useState<CodegraphSystemView | null>(null);
```

3. `load` 的 `Promise.all` 增加第 4 项（系统状态为 advisory，失败降级为 `null`）：

```tsx
        apiGet<CodegraphSystemView>(`/api/codegraph?${q}`).catch(() => null),
```

并把回调改为 `([v, a, h, s]) => { ...; setSystem(s); ... }`。

4. 在 `<GitAccountCard ... />` 之后插入：

```tsx
      <CodegraphCard
        profile={profile}
        system={system}
        busy={busy || jobRunning}
        unindexedCount={view.projects.filter((p) => !p.codegraph?.indexed).length}
        onJob={(id) => {
          localStorage.setItem(activeJobKey, id);
          setJobId(id);
          setJobOpen(true);
        }}
        onRefresh={() => void load()}
      />
```

**Step 2: 项目行**

1. 在 `ProjectRow` 的调用处传入 `system`：

```tsx
            <ProjectRow
              key={p.id}
              project={p}
              cliInstalled={system?.cli.installed ?? false}
              busy={busy || jobRunning}
              onPull={pull}
              onRemove={(p) => setRemoveTarget(p)}
              onBranch={setBranch}
              onCodegraph={codegraphAction}
            />
```

2. `WorkspaceView` 内新增：

```tsx
  async function codegraphAction(id: string, action: "init" | "sync") {
    setBusy(true);
    try {
      const { jobId } = await apiPost<StartJobResponse>(`/api/codegraph/${action}?${q}`, { id });
      localStorage.setItem(activeJobKey, jobId);
      setJobId(jobId);
      setJobOpen(true);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }
```

3. `ProjectRow` 增加 props 与徽章/按钮：

```tsx
function codegraphBadge(p: ProjectView, cliInstalled: boolean) {
  if (!cliInstalled) return <Badge variant="destructive">CodeGraph 不可用</Badge>;
  if (p.codegraph?.indexed) return <Badge variant="success">已索引</Badge>;
  return <Badge variant="secondary">未索引</Badge>;
}

function ProjectRow({
  project,
  cliInstalled,
  busy,
  onPull,
  onRemove,
  onBranch,
  onCodegraph,
}: {
  project: ProjectView;
  cliInstalled: boolean;
  busy: boolean;
  onPull: (id: string) => void;
  onRemove: (project: ProjectView) => void;
  onBranch: (id: string, branch: string) => void;
  onCodegraph: (id: string, action: "init" | "sync") => void;
}) {
```

在 `最后拉取：...` 那一行之后补一行：

```tsx
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {codegraphBadge(project, cliInstalled)}
          {project.codegraph?.indexed && (
            <span>索引更新：{formatTime(project.codegraph.updatedAt)}</span>
          )}
        </div>
```

在「拉取」按钮前插入：

```tsx
      {cliInstalled && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onCodegraph(project.id, project.codegraph?.indexed ? "sync" : "init")}
        >
          {project.codegraph?.indexed ? "同步索引" : "建索引"}
        </Button>
      )}
```

**Step 3: 验证**

```
pnpm build:web
pnpm typecheck
```

**Step 4: 提交**

```
git add web/src/views/WorkspaceView.tsx
git commit -m "feat(web): show codegraph state on the workspace page"
```

---

## Task 12: 文档

**Files**
- Modify: `README.zh.md`
- Modify: `README.md`

**Step 1: 补一句控制台能力**

在中文 README 的「工作空间 / 项目」控制台段落（提到“定时拉取 / 拉取记录”的地方）追加一条：

```md
- **CodeGraph 代码索引**：检测并可一键安装 codegraph CLI（官方脚本或 npm），接入本机 agent 的 codegraph MCP；新项目 clone 后自动建立索引，git 有更新时自动增量同步，项目行显示「已索引 / 未索引」。
```

在英文 README 对应段落追加：

```md
- **CodeGraph index**: detects/installs the codegraph CLI (script or npm), wires the codegraph MCP, auto-indexes new clones, and syncs on updates. Each project row shows its index state.
```

**Step 2: 验证**

```
pnpm exec vitest run tests/unit/docs/readme-contract.test.ts
```

**Step 3: 提交**

```
git add README.md README.zh.md
git commit -m "docs: document the console CodeGraph integration"
```

---

## 最终验证

```
pnpm test
pnpm typecheck
pnpm build
git status --short
```

预期：全绿，工作区干净。

手动冒烟（本机已装 codegraph）：

1. `pnpm build && node ./bin/lark-channel-bridge.mjs`（或按仓库既有方式启动控制台），打开「工作空间」页。
2. 确认出现「CodeGraph 代码索引」卡片，CLI 与 MCP 徽章显示正确状态。
3. 对未索引项目点「建索引」，进度弹窗实时滚动，结束后行变「已索引」。
4. 对已索引项目触发一次「拉取」，若确有更新，作业日志出现 `codegraph sync` 输出。

---

## 备注 / 风险

- **`codegraph status` 卡死**：任何行级渲染都不得调用它。只有 `projectStats`（详情按需）在 `projectIndexInfo().indexed === true` 之后才 spawn，且带 30s 超时。
- **MCP 生效时机**：`codegraph install --yes` 写的是 opencode 全局配置，已运行的 `opencode serve` 不会热加载；卡片文案明确提示需重启 bridge/opencode。
- **安装提权**：安装按钮执行远程脚本 / 全局 npm，属用户显式点击的本地操作，前端二次确认 + 后端现有 localhost/token 保护已足够。
- **`--yes` 会写全部被检测到的 agent**（claude/codex/opencode），这是 spec §12 的明确决定，因本项目同时桥接 codex 等。
