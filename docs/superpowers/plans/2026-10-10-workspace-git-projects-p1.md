# 工作空间与项目管理 (P1) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让控制台可以浏览本机目录并设置 profile 的工作空间根目录、以 `git` 管理多个项目（手动添加 / clone·关联 / 改分支 / 移除 / 手动拉取 / 查看状态），全部落到磁盘并可测试。

**Architecture:** 复用 supervisor 托管的控制台。新增 `src/git/git-ops.ts`（可注入 runner 的 git CLI 包装）、`src/workspace/projects.ts`（per-profile 项目清单）、`src/workspace/history.ts`（拉取记录）、`src/workspace/dir-browse.ts`（目录浏览）、`src/ui/workspace-api.ts`（API 逻辑），在 `src/ui/server.ts` 注册路由，前端新增 `web/src/views/WorkspaceView.tsx` 并挂到 `ProfileDetail`。工作空间根目录沿用现有 `workspaces.default`。

**Tech Stack:** TypeScript (ESM, Node 20+), vitest, cross-spawn, React 19 + Vite + shadcn/ui, tsup。

**规格来源:** `docs/superpowers/specs/2026-10-10-workspace-git-projects-design.md`（本计划只做其中的 **P1**；P2 = Git 账号 + 仓库列表，P3 = supervisor 定时任务 + `/config` 卡片 + 失败通知，各自另立计划）。

---

## 文件结构

**新增**
- `src/git/git-ops.ts` — git CLI 包装（runner、查询、clone、status、pull、ensureCheckout）
- `src/workspace/projects.ts` — 项目清单 + 计划配置的读写/规范化
- `src/workspace/history.ts` — 拉取记录追加/读取/截断
- `src/workspace/dir-browse.ts` — 服务端目录浏览
- `src/ui/workspace-api.ts` — 控制台工作空间 API 逻辑
- `web/src/views/WorkspaceView.tsx` — 控制台「工作空间」页 + 弹框
- 测试：`tests/unit/git/git-ops.test.ts`、`tests/unit/workspace/projects.test.ts`、`tests/unit/workspace/history.test.ts`、`tests/unit/workspace/dir-browse.test.ts`、`tests/integration/ui/workspace-api.test.ts`

**修改**
- `src/config/app-paths.ts` — 新增 `projectsFile`、`pullHistoryFile`
- `src/config/config-ops.ts` — 新增 `saveWorkspaceConfig`
- `src/ui/server.ts` — 新增路由
- `web/src/lib/types.ts`、`web/src/views/ProfileDetail.tsx`
- `tests/unit/config/app-paths.test.ts`（如断言精确字段则同步）

---

## Task 1: 扩展 AppPaths

**Files:**
- Modify: `src/config/app-paths.ts`
- Test: `tests/unit/config/app-paths.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/config/app-paths.test.ts` 的 `describe` 内追加：

```ts
it('exposes per-profile projects and pull-history paths', () => {
  const p = resolveAppPaths({ rootDir: '/tmp/root', profile: 'work' });
  expect(p.projectsFile).toBe(join('/tmp/root', 'profiles', 'work', 'projects.json'));
  expect(p.pullHistoryFile).toBe(join('/tmp/root', 'profiles', 'work', 'pull-history.jsonl'));
});
```

确保文件顶部有 `import { join } from 'node:path';` 与 `resolveAppPaths` 的导入。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts -v`
Expected: FAIL（`projectsFile` 为 `undefined`）

- [ ] **Step 3: 实现**

在 `src/config/app-paths.ts` 的 `AppPaths` 接口中，`workspacesFile` 之后加：

```ts
  projectsFile: string;
  pullHistoryFile: string;
```

在 `resolveAppPaths` 返回对象中，`workspacesFile` 之后加：

```ts
    projectsFile: join(profileDir, 'projects.json'),
    pullHistoryFile: join(profileDir, 'pull-history.jsonl'),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config/app-paths.ts tests/unit/config/app-paths.test.ts
git commit -m "feat(config): add projects and pull-history app paths"
```

---

## Task 2: 拉取记录 history.ts

**Files:**
- Create: `src/workspace/history.ts`
- Test: `tests/unit/workspace/history.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendPullRecord, MAX_RECORDS, readPullRecords, type PullRecord } from '../../../src/workspace/history';

const cleanups: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-history-'));
  cleanups.push(dir);
  return join(dir, 'pull-history.jsonl');
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function record(i: number): PullRecord {
  return {
    ts: new Date(i * 1000).toISOString(),
    projectId: 'p1', name: 'repo', branch: 'main',
    result: 'updated', detail: 'ok', durationMs: 10, trigger: 'manual',
  };
}

describe('pull history', () => {
  it('appends and reads records newest-first', async () => {
    const path = await tmpFile();
    await appendPullRecord(path, record(1));
    await appendPullRecord(path, record(2));
    const rows = await readPullRecords(path, 10);
    expect(rows.map((r) => r.ts)).toEqual([record(2).ts, record(1).ts]);
  });

  it('caps stored records at MAX_RECORDS', async () => {
    const path = await tmpFile();
    for (let i = 0; i < MAX_RECORDS + 5; i++) await appendPullRecord(path, record(i));
    const rows = await readPullRecords(path, MAX_RECORDS + 100);
    expect(rows).toHaveLength(MAX_RECORDS);
    expect(rows[0]!.ts).toBe(record(MAX_RECORDS + 4).ts);
  });

  it('skips corrupt lines', async () => {
    const path = await tmpFile();
    await writeFile(path, `not json\n${JSON.stringify(record(1))}\n`, 'utf8');
    const rows = await readPullRecords(path, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(record(1).ts);
  });

  it('returns [] when the file is missing', async () => {
    expect(await readPullRecords(await tmpFile(), 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/workspace/history.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type PullResult = 'updated' | 'up-to-date' | 'skipped' | 'failed';
export type PullTrigger = 'schedule' | 'manual';

export interface PullRecord {
  ts: string;
  projectId: string;
  name: string;
  branch: string;
  result: PullResult;
  detail: string;
  durationMs: number;
  trigger: PullTrigger;
}

/** Hard cap so the JSONL file can't grow without bound. */
export const MAX_RECORDS = 500;

function isRecord(value: unknown): value is PullRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<PullRecord>;
  return (
    typeof r.ts === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.branch === 'string' &&
    (r.result === 'updated' || r.result === 'up-to-date' || r.result === 'skipped' || r.result === 'failed') &&
    typeof r.detail === 'string' &&
    typeof r.durationMs === 'number' &&
    (r.trigger === 'schedule' || r.trigger === 'manual')
  );
}

/** Append one record, trimming to the newest {@link MAX_RECORDS}. */
export async function appendPullRecord(path: string, record: PullRecord): Promise<void> {
  const existing = await readRaw(path);
  const next = [...existing, record].slice(-MAX_RECORDS);
  await writeFileAtomic(path, `${next.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
}

/** Newest-first records, capped at `limit`. Corrupt lines are skipped. */
export async function readPullRecords(path: string, limit = 50): Promise<PullRecord[]> {
  const all = await readRaw(path);
  return all.slice(-Math.max(0, limit)).reverse();
}

async function readRaw(path: string): Promise<PullRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PullRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/workspace/history.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workspace/history.ts tests/unit/workspace/history.test.ts
git commit -m "feat(workspace): add pull-history store"
```

---

## Task 3: git 包装（runner + 查询）

**Files:**
- Create: `src/git/git-ops.ts`
- Test: `tests/unit/git/git-ops.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  currentBranch,
  isGitRepo,
  normalizeRemote,
  remoteUrl,
  type GitResult,
  type GitRunner,
} from '../../../src/git/git-ops';

/** Build a fake runner from a map of `argv.join(' ')` → result. */
function fakeRunner(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): GitRunner {
  return async (args): Promise<GitResult> => {
    const key = args.join(' ');
    const hit = map[key];
    if (!hit) return { code: 128, stdout: '', stderr: `unexpected: ${key}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
}

describe('git-ops basic queries', () => {
  it('detects a git work tree', async () => {
    const run = fakeRunner({ 'rev-parse --is-inside-work-tree': { stdout: 'true\n' } });
    expect(await isGitRepo(run, '/repo')).toBe(true);
  });

  it('returns undefined for a non-repo', async () => {
    const run = fakeRunner({ 'rev-parse --is-inside-work-tree': { code: 128 } });
    expect(await isGitRepo(run, '/repo')).toBe(false);
  });

  it('reads the origin remote', async () => {
    const run = fakeRunner({ 'remote get-url origin': { stdout: 'https://x/y.git\n' } });
    expect(await remoteUrl(run, '/repo')).toBe('https://x/y.git');
  });

  it('reads the current branch', async () => {
    const run = fakeRunner({ 'rev-parse --abbrev-ref HEAD': { stdout: 'develop\n' } });
    expect(await currentBranch(run, '/repo')).toBe('develop');
  });

  it('normalizes remote urls for comparison', () => {
    expect(normalizeRemote('https://github.com/a/b.git')).toBe('github.com/a/b');
    expect(normalizeRemote('git@github.com:a/b.git')).toBe('github.com/a/b');
    expect(normalizeRemote('https://GitHub.com/a/b/')).toBe('github.com/a/b');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/git-ops.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（本任务只写 runner + 查询；clone/status/pull 在 Task 4）**

```ts
import { stat, readdir } from 'node:fs/promises';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type GitRunner = (args: string[], opts?: GitRunOptions) => Promise<GitResult>;

/** Spawn the real `git` binary. Extra env is merged case-insensitively. */
export function createGitRunner(bin = 'git'): GitRunner {
  return (args, opts = {}) =>
    new Promise<GitResult>((resolve) => {
      const child = spawnProcess(bin, args, {
        cwd: opts.cwd,
        env: mergeProcessEnv(process.env, opts.env ?? {}),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill(), opts.timeoutMs)
        : undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
      };
      child.on('error', (err) => {
        done();
        // A spawn failure (missing cwd, git not installed) is surfaced as a
        // non-zero exit so probes like `isGitRepo` can degrade instead of
        // rejecting — a not-yet-cloned project directory is a normal case.
        resolve({ code: -1, stdout, stderr: stderr || String(err) });
      });
      child.on('close', (code) => {
        done();
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

export async function isGitRepo(run: GitRunner, dir: string): Promise<boolean> {
  const r = await run(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function remoteUrl(run: GitRunner, dir: string): Promise<string | undefined> {
  const r = await run(['remote', 'get-url', 'origin'], { cwd: dir });
  if (r.code !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

export async function currentBranch(run: GitRunner, dir: string): Promise<string | undefined> {
  const r = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  if (r.code !== 0) return undefined;
  const branch = r.stdout.trim();
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/**
 * Reduce a remote URL to `host/path` for equality checks: drop the scheme or
 * `user@`, the `.git` suffix, and a trailing slash; lowercase the rest.
 */
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    // SCP-style `host:owner/repo` → `host/owner/repo`.
    .replace(/^([^/]+):/, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/git-ops.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git/git-ops.ts tests/unit/git/git-ops.test.ts
git commit -m "feat(git): add git runner and basic queries"
```

---

## Task 4: git 包装（clone / status / pull / ensureCheckout）

**Files:**
- Modify: `src/git/git-ops.ts`
- Test: `tests/unit/git/git-ops.test.ts`（追加）；真实 git 冒烟：`tests/integration/git/git-ops-real.test.ts`

- [ ] **Step 1: 写失败测试（追加到 git-ops.test.ts）**

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { ensureCheckout, pullRepo, repoStatus } from '../../../src/git/git-ops';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('git-ops status/pull', () => {
  it('parses dirty + ahead/behind from git output', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: ' M src/a.ts\n' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '2\t3\n' },
    });
    expect(await repoStatus(run, '/repo')).toEqual({
      branch: 'main', dirty: true, behind: 2, ahead: 3, hasUpstream: true,
    });
  });

  it('treats a missing upstream as 0/0', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: '' },
      'rev-list --left-right --count @{upstream}...HEAD': { code: 128, stderr: 'no upstream' },
    });
    expect(await repoStatus(run, '/repo')).toMatchObject({ ahead: 0, behind: 0, hasUpstream: false });
  });

  it('skips a dirty tree under ff-only', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: ' M a\n' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '0\t0\n' },
    });
    const out = await pullRepo(run, '/repo', 'ff-only');
    expect(out.status).toBe('skipped');
  });

  it('reports up-to-date when git says so', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: '' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '1\t0\n' },
      'pull --ff-only': { stdout: 'Already up to date.\n' },
    });
    expect((await pullRepo(run, '/repo', 'ff-only')).status).toBe('up-to-date');
  });
});

describe('ensureCheckout', () => {
  it('clones into a missing directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'bridge-ensure-'));
    cleanups.push(base);
    const dir = join(base, 'repo');
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(await ensureCheckout(run, { repoUrl: 'https://x/y.git', dir, branch: 'main' })).toBe('cloned');
    expect(calls.some((a) => a[0] === 'clone')).toBe(true);
  });

  it('throws when the target is non-empty and not a repo', async () => {
    const base = await mkdtemp(join(tmpdir(), 'bridge-ensure-'));
    cleanups.push(base);
    const dir = join(base, 'repo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'file.txt'), 'x', 'utf8');
    const run = fakeRunner({ 'rev-parse --is-inside-work-tree': { code: 128 } });
    await expect(ensureCheckout(run, { repoUrl: 'https://x/y.git', dir })).rejects.toThrow(/非空/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/git-ops.test.ts -v`
Expected: FAIL（`repoStatus`/`pullRepo`/`ensureCheckout` 未导出）

- [ ] **Step 3: 实现（追加到 git-ops.ts）**

```ts
export type PullStrategy = 'ff-only' | 'fetch-only' | 'reset-hard';

export interface RepoStatus {
  branch?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export type PullStatus = 'updated' | 'up-to-date' | 'skipped' | 'failed';

export interface PullOutcome {
  status: PullStatus;
  detail: string;
}

export async function repoStatus(run: GitRunner, dir: string): Promise<RepoStatus> {
  const branch = await currentBranch(run, dir);
  const porcelain = await run(['status', '--porcelain'], { cwd: dir });
  const dirty = porcelain.code === 0 && porcelain.stdout.trim().length > 0;
  const counts = await run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd: dir });
  const hasUpstream = counts.code === 0;
  let behind = 0;
  let ahead = 0;
  if (hasUpstream) {
    const [left, right] = counts.stdout.trim().split(/\s+/);
    behind = Number.isFinite(Number(left)) ? Number(left) : 0;
    ahead = Number.isFinite(Number(right)) ? Number(right) : 0;
  }
  return { branch, dirty, ahead, behind, hasUpstream };
}

function failure(out: GitResult): PullOutcome {
  return { status: 'failed', detail: (out.stderr.trim() || out.stdout.trim() || 'git 执行失败').slice(0, 500) };
}

export async function cloneRepo(
  run: GitRunner,
  opts: { repoUrl: string; dir: string; branch?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const args = ['clone'];
  if (opts.branch) args.push('--branch', opts.branch);
  args.push('--', opts.repoUrl, opts.dir);
  const r = await run(args, { env: opts.env, timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`git clone 失败：${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}`);
}

export async function pullRepo(run: GitRunner, dir: string, strategy: PullStrategy): Promise<PullOutcome> {
  const before = await repoStatus(run, dir);

  if (strategy !== 'fetch-only' && before.dirty) {
    return { status: 'skipped', detail: '有未提交的本地改动，已跳过' };
  }

  if (strategy === 'fetch-only') {
    const r = await run(['fetch', '--prune'], { cwd: dir, timeoutMs: 120_000 });
    return r.code === 0 ? { status: 'up-to-date', detail: '仅 fetch（未合并）' } : failure(r);
  }

  if (strategy === 'reset-hard') {
    const fetch = await run(['fetch', '--prune'], { cwd: dir, timeoutMs: 120_000 });
    if (fetch.code !== 0) return failure(fetch);
    const reset = await run(['reset', '--hard', `origin/${before.branch ?? 'HEAD'}`], { cwd: dir });
    return reset.code === 0
      ? { status: 'updated', detail: `已重置到 origin/${before.branch ?? 'HEAD'}` }
      : failure(reset);
  }

  const r = await run(['pull', '--ff-only'], { cwd: dir, timeoutMs: 120_000 });
  if (r.code !== 0) return failure(r);
  if (/already up[ -]?to[ -]?date/i.test(r.stdout)) return { status: 'up-to-date', detail: '已最新' };
  const summary = r.stdout.trim().split('\n').filter(Boolean).slice(0, 2).join(' ');
  return { status: 'updated', detail: summary || '已更新' };
}

export type CheckoutResult = 'cloned' | 'attached';

/** Clone into `dir`, or attach an existing repo whose origin matches `repoUrl`. */
export async function ensureCheckout(
  run: GitRunner,
  opts: { repoUrl: string; dir: string; branch?: string; env?: NodeJS.ProcessEnv },
): Promise<CheckoutResult> {
  if (await isGitRepo(run, opts.dir)) {
    const url = await remoteUrl(run, opts.dir);
    if (url && normalizeRemote(url) !== normalizeRemote(opts.repoUrl)) {
      throw new Error(`目录已是另一个仓库（remote: ${url}）`);
    }
    return 'attached';
  }
  if (await dirHasEntries(opts.dir)) {
    throw new Error(`目录非空且不是 git 仓库：${opts.dir}`);
  }
  await cloneRepo(run, opts);
  return 'cloned';
}

async function dirHasEntries(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  const entries = await readdir(dir).catch(() => []);
  return entries.length > 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/git-ops.test.ts -v`
Expected: PASS

- [ ] **Step 5: 真实 git 冒烟测试**

新建 `tests/integration/git/git-ops-real.test.ts`：

```ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneRepo, createGitRunner, isGitRepo, pullRepo, repoStatus } from '../../../src/git/git-ops';

const cleanups: string[] = [];
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('git-ops against real git', () => {
  it('clones, reports status, and pulls an update', async () => {
    const base = await mkdtemp(join(tmpdir(), 'bridge-real-'));
    cleanups.push(base);
    const origin = join(base, 'origin');
    git(base, ['init', '--bare', origin]);
    const seed = join(base, 'seed');
    git(base, ['clone', origin, seed]);
    git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
    git(seed, ['branch', '-M', 'main']);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const run = createGitRunner();
    const clone = join(base, 'clone');
    await cloneRepo(run, { repoUrl: origin, dir: clone, branch: 'main' });
    expect(await isGitRepo(run, clone)).toBe(true);
    expect((await repoStatus(run, clone)).dirty).toBe(false);

    git(seed, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'more']);
    git(seed, ['push']);
    const out = await pullRepo(run, clone, 'ff-only');
    expect(out.status).toBe('updated');

    // dirty tree is skipped
    await writeFile(join(clone, 'wip.txt'), 'x', 'utf8');
    expect((await pullRepo(run, clone, 'ff-only')).status).toBe('skipped');
  });
});
```

Run: `pnpm vitest run tests/integration/git/git-ops-real.test.ts -v`
Expected: PASS（CI 需要 `git` 可用；三平台 CI 均自带 git）

- [ ] **Step 6: 提交**

```bash
git add src/git/git-ops.ts tests/unit/git/git-ops.test.ts tests/integration/git/git-ops-real.test.ts
git commit -m "feat(git): add status, clone, pull and ensureCheckout"
```

---

## Task 5: 项目清单 projects.ts

**Files:**
- Create: `src/workspace/projects.ts`
- Test: `tests/unit/workspace/projects.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  normalizeProjectsData,
  ProjectStore,
} from '../../../src/workspace/projects';

const cleanups: string[] = [];
async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-projects-'));
  cleanups.push(dir);
  return join(dir, 'projects.json');
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('normalizeProjectsData', () => {
  it('returns defaults for junk input', () => {
    const data = normalizeProjectsData(null);
    expect(data.projects).toEqual([]);
    expect(data.schedule).toEqual(DEFAULT_SCHEDULE);
  });

  it('drops malformed projects and fills defaults', () => {
    const data = normalizeProjectsData({
      projects: [
        { name: 'ok', repoUrl: 'https://x/y.git' },
        { name: '', repoUrl: 'nope' },
      ],
      schedule: { intervalMinutes: 5 },
    });
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]).toMatchObject({ name: 'ok', branch: 'main', localPath: 'ok' });
    expect(data.schedule.intervalMinutes).toBe(5);
    expect(data.schedule.enabled).toBe(false);
  });
});

describe('ProjectStore', () => {
  it('adds, persists, updates branch and removes', async () => {
    const path = await tmpStorePath();
    const store = new ProjectStore(path);
    await store.load();

    const added = store.add({ repoUrl: 'https://x/y.git', branch: 'develop', name: 'y' });
    expect(added.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);

    store.updateBranch(added.id, 'main');
    store.setSchedule({ enabled: true, intervalMinutes: 15 });
    await store.flush();

    const reloaded = new ProjectStore(path);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ branch: 'main' });
    expect(reloaded.getSchedule()).toMatchObject({ enabled: true, intervalMinutes: 15 });

    expect(reloaded.remove(added.id)).toBe(true);
    expect(reloaded.remove('missing')).toBe(false);
    expect(reloaded.list()).toHaveLength(0);
  });

  it('rejects duplicate names and blank repo urls', async () => {
    const store = new ProjectStore(await tmpStorePath());
    await store.load();
    store.add({ repoUrl: 'https://x/y.git', name: 'y' });
    expect(() => store.add({ repoUrl: 'https://x/z.git', name: 'y' })).toThrow(/已存在/);
    expect(() => store.add({ repoUrl: '  ', name: 'z' })).toThrow(/仓库地址/);
  });

  it('clamps schedule interval', async () => {
    const store = new ProjectStore(await tmpStorePath());
    await store.load();
    expect(store.setSchedule({ intervalMinutes: 1 }).intervalMinutes).toBe(5);
    expect(store.setSchedule({ intervalMinutes: 99999 }).intervalMinutes).toBe(1440);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/workspace/projects.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { PullStrategy } from '../git/git-ops';

export interface ProjectEntry {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  accountId?: string;
}

export interface PullSchedule {
  enabled: boolean;
  intervalMinutes: number;
  strategy: PullStrategy;
  notifyOnFailure: boolean;
}

export interface ProjectsData {
  version: 1;
  projects: ProjectEntry[];
  schedule: PullSchedule;
}

export const DEFAULT_SCHEDULE: PullSchedule = {
  enabled: false,
  intervalMinutes: 30,
  strategy: 'ff-only',
  notifyOnFailure: true,
};

export interface AddProjectInput {
  repoUrl: string;
  branch?: string;
  name?: string;
  localPath?: string;
  accountId?: string;
}

const STRATEGIES: PullStrategy[] = ['ff-only', 'fetch-only', 'reset-hard'];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSchedule(input: unknown): PullSchedule {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<PullSchedule>;
  const n = Number(raw.intervalMinutes);
  const intervalMinutes = Number.isFinite(n)
    ? Math.min(1440, Math.max(5, Math.floor(n)))
    : DEFAULT_SCHEDULE.intervalMinutes;
  return {
    enabled: raw.enabled === true,
    intervalMinutes,
    strategy: STRATEGIES.includes(raw.strategy as PullStrategy)
      ? (raw.strategy as PullStrategy)
      : DEFAULT_SCHEDULE.strategy,
    notifyOnFailure: raw.notifyOnFailure !== false,
  };
}

function normalizeProject(input: unknown): ProjectEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<ProjectEntry>;
  const name = str(raw.name);
  const repoUrl = str(raw.repoUrl);
  if (!name || !repoUrl) return undefined;
  const branch = str(raw.branch) || 'main';
  const localPath = str(raw.localPath) || name;
  const accountId = str(raw.accountId);
  const id = str(raw.id) || randomUUID();
  return { id, name, repoUrl, localPath, branch, ...(accountId ? { accountId } : {}) };
}

export function normalizeProjectsData(input: unknown): ProjectsData {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    projects?: unknown;
    schedule?: unknown;
  };
  const projects: ProjectEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      const project = normalizeProject(item);
      if (!project || seen.has(project.name)) continue;
      seen.add(project.name);
      projects.push(project);
    }
  }
  return { version: 1, projects, schedule: normalizeSchedule(raw.schedule) };
}

export class ProjectStore {
  private data: ProjectsData = { version: 1, projects: [], schedule: { ...DEFAULT_SCHEDULE } };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      this.data = normalizeProjectsData(JSON.parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  list(): ProjectEntry[] {
    return this.data.projects.map((p) => ({ ...p }));
  }

  get(id: string): ProjectEntry | undefined {
    const found = this.data.projects.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  getSchedule(): PullSchedule {
    return { ...this.data.schedule };
  }

  add(input: AddProjectInput): ProjectEntry {
    const repoUrl = input.repoUrl.trim();
    if (!repoUrl) throw new Error('仓库地址不能为空');
    const name = input.name?.trim() || deriveName(repoUrl);
    if (!name) throw new Error('项目名不能为空');
    if (this.data.projects.some((p) => p.name === name)) {
      throw new Error(`项目名已存在：${name}`);
    }
    const entry: ProjectEntry = {
      id: randomUUID(),
      name,
      repoUrl,
      localPath: input.localPath?.trim() || name,
      branch: input.branch?.trim() || 'main',
      ...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
    };
    this.data.projects.push(entry);
    this.schedulePersist();
    return { ...entry };
  }

  updateBranch(id: string, branch: string): ProjectEntry {
    const trimmed = branch.trim();
    if (!trimmed) throw new Error('分支不能为空');
    const project = this.data.projects.find((p) => p.id === id);
    if (!project) throw new Error(`项目不存在：${id}`);
    project.branch = trimmed;
    this.schedulePersist();
    return { ...project };
  }

  remove(id: string): boolean {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length === before) return false;
    this.schedulePersist();
    return true;
  }

  setSchedule(patch: Partial<PullSchedule>): PullSchedule {
    this.data.schedule = normalizeSchedule({ ...this.data.schedule, ...patch });
    this.schedulePersist();
    return this.getSchedule();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() =>
        writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 }),
      )
      .catch(() => undefined);
  }
}

function deriveName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '');
  return trimmed.split(/[/\\:]/).pop() ?? '';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/workspace/projects.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workspace/projects.ts tests/unit/workspace/projects.test.ts
git commit -m "feat(workspace): add project store"
```

---

## Task 6: 写工作空间根目录 saveWorkspaceConfig

**Files:**
- Modify: `src/config/config-ops.ts`
- Test: `tests/unit/config/config-ops-workspace.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { saveWorkspaceConfig } from '../../../src/config/config-ops';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it('persists workspaces.default and refreshes in-memory state', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-cfg-'));
  cleanups.push(rootDir);
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  const configPath = join(rootDir, 'config.json');
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } } })),
    configPath,
  );
  const root = (await loadRootConfig(configPath))!;
  const state = {
    configPath,
    profile: 'claude',
    cfg: runtimeProfileConfig(root, 'claude'),
    profileConfig: root.profiles.claude!,
  };

  await saveWorkspaceConfig(state, '/tmp/my-ws');

  expect(state.profileConfig.workspaces.default).toBe('/tmp/my-ws');
  const disk = (await loadRootConfig(configPath))!;
  expect(disk.profiles.claude.workspaces.default).toBe('/tmp/my-ws');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/config/config-ops-workspace.test.ts -v`
Expected: FAIL（`saveWorkspaceConfig` 未导出）

- [ ] **Step 3: 实现（追加到 `src/config/config-ops.ts` 末尾）**

```ts
/**
 * Persist the profile's default working directory (the "workspace root" the
 * console's directory picker edits), refreshing in-memory state under the
 * config file lock. Works for both online and disk-only profiles.
 */
export async function saveWorkspaceConfig(
  state: MutableProfileState,
  workspaceDir: string,
): Promise<void> {
  const dir = workspaceDir.trim();
  if (!dir) throw new Error('工作空间目录不能为空');
  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) {
      state.profileConfig.workspaces = { ...state.profileConfig.workspaces, default: dir };
      state.cfg.workspaces = state.profileConfig.workspaces;
      await saveConfig(state.cfg, state.configPath);
      return;
    }
    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    root.profiles[state.profile] = {
      ...profile,
      workspaces: { ...profile.workspaces, default: dir },
    };
    await saveRootConfig(root, state.configPath);
    state.profileConfig = root.profiles[state.profile]!;
    state.cfg = runtimeProfileConfig(root, state.profile);
  });
  log.info('config-ops', 'workspace-saved', { profile: state.profile });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/config/config-ops-workspace.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config/config-ops.ts tests/unit/config/config-ops-workspace.test.ts
git commit -m "feat(config): persist workspace default directory"
```

---

## Task 7: 目录浏览 dir-browse.ts

**Files:**
- Create: `src/workspace/dir-browse.ts`
- Test: `tests/unit/workspace/dir-browse.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browseDirectory } from '../../../src/workspace/dir-browse';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it('lists only subdirectories and reports the parent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bridge-browse-'));
  cleanups.push(base);
  await mkdir(join(base, 'alpha'), { recursive: true });
  await mkdir(join(base, 'beta'), { recursive: true });
  await writeFile(join(base, 'readme.txt'), 'x', 'utf8');

  const listing = await browseDirectory(base);
  expect(listing.dirs.map((d) => d.name)).toEqual(['alpha', 'beta']);
  expect(listing.path).toBe(await realpath(base));
  expect(listing.parent).toBeTruthy();
});

it('rejects a missing path', async () => {
  await expect(browseDirectory(join(tmpdir(), 'does-not-exist-xyz'))).rejects.toThrow();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/workspace/dir-browse.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: DirEntry[];
  /** Present only for the empty-path (drive picker) result on Windows. */
  roots?: DirEntry[];
}

/**
 * List a directory's immediate subdirectories for the console's picker. An
 * empty path returns the Windows drive list (or the home directory elsewhere).
 * Never reads file contents; localhost + UI-token gated at the server layer.
 */
export async function browseDirectory(input?: string): Promise<DirListing> {
  const requested = (input ?? '').trim();
  if (!requested) {
    if (platform() === 'win32') {
      return { path: '', dirs: [], roots: await windowsDrives() };
    }
    return listDir(homedir());
  }
  return listDir(requested);
}

async function listDir(requested: string): Promise<DirListing> {
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new Error(`目录不存在或不可访问：${requested}`);
  }
  const info = await stat(real).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`路径不是目录：${real}`);

  const entries = await readdir(real, { withFileTypes: true });
  const dirs: DirEntry[] = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(real);
  return { path: real, dirs, ...(parent && parent !== real ? { parent } : {}) };
}

async function windowsDrives(): Promise<DirEntry[]> {
  const drives: DirEntry[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      const info = await stat(root);
      if (info.isDirectory()) drives.push({ name: root, path: root });
    } catch {
      // drive not present
    }
  }
  return drives;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/workspace/dir-browse.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/workspace/dir-browse.ts tests/unit/workspace/dir-browse.test.ts
git commit -m "feat(workspace): add directory browser"
```

---

## Task 8: 工作空间 API 逻辑 workspace-api.ts

**Files:**
- Create: `src/ui/workspace-api.ts`
- Test: `tests/integration/ui/workspace-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { HttpError } from '../../../src/ui/http';
import {
  addProjects,
  projectsView,
  pullProjects,
  removeProject,
  setWorkspaceDir,
  updateProjectBranch,
} from '../../../src/ui/workspace-api';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;
const cleanups: string[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-wsapi-'));
  cleanups.push(rootDir);
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Create a real local bare origin with one commit on `main`; return its path. */
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

describe('workspace-api', () => {
  it('adds a project and clones it into the workspace', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, branch: 'main', name: 'backend' }] });
    const view = await projectsView('claude', rootDir);
    expect(view.workspaceDir).toBe(workspace);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0]).toMatchObject({ name: 'backend', branch: 'main', exists: true });
  });

  it('rolls back an add when the repo cannot be cloned', async () => {
    await expect(
      addProjects('claude', rootDir, { projects: [{ repoUrl: join(rootDir, 'nope', 'missing.git'), name: 'bad' }] }),
    ).rejects.toBeInstanceOf(HttpError);
    expect((await projectsView('claude', rootDir)).projects).toHaveLength(0);
  });

  it('rejects a project path escaping the workspace', async () => {
    await expect(
      addProjects('claude', rootDir, { projects: [{ repoUrl: 'https://e/x.git', name: 'x', localPath: '../escape' }] }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('updates branch, sets workspace, and removes', async () => {
    const origin = await makeOrigin(rootDir);
    const added = await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    const id = added.projects[0]!.id;
    await updateProjectBranch('claude', rootDir, { id, branch: 'release' });
    expect((await projectsView('claude', rootDir)).projects[0]!.branch).toBe('release');

    await setWorkspaceDir('claude', rootDir, { path: workspace });
    await removeProject('claude', rootDir, { id });
    expect((await projectsView('claude', rootDir)).projects).toHaveLength(0);
  });

  it('records a failed manual pull when the checkout is missing', async () => {
    const origin = await makeOrigin(rootDir);
    await addProjects('claude', rootDir, { projects: [{ repoUrl: origin, name: 'x' }] });
    await rm(join(workspace, 'x'), { recursive: true, force: true });
    const run = await pullProjects('claude', rootDir, {});
    expect(run.results[0]!.result).toBe('failed');
    const view = await projectsView('claude', rootDir);
    expect(view.projects[0]!.lastPullAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/integration/ui/workspace-api.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { saveWorkspaceConfig } from '../config/config-ops';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import {
  createGitRunner,
  ensureCheckout,
  isGitRepo,
  repoStatus,
  pullRepo,
  type RepoStatus,
} from '../git/git-ops';
import { appendPullRecord, readPullRecords, type PullResult } from '../workspace/history';
import { browseDirectory } from '../workspace/dir-browse';
import { ProjectStore, type ProjectEntry, type PullSchedule } from '../workspace/projects';
import { HttpError } from './http';
import { loadProfileState } from './api';

const run = createGitRunner();

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
}

export interface ProjectsView {
  workspaceDir?: string;
  projects: ProjectView[];
  schedule: PullSchedule;
}

export interface PullRunItem {
  projectId: string;
  name: string;
  branch: string;
  result: PullResult;
  detail: string;
  durationMs: number;
}

async function statePaths(profile: string, rootDir?: string) {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const state = await loadProfileState(profile, rootDir);
  const workspaceDir = state.profileConfig.workspaces.default ?? appPaths.defaultWorkspaceDir;
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  return { appPaths, state, workspaceDir, store };
}

/** Resolve a project's checkout path and refuse one that escapes the workspace. */
export function resolveProjectDir(workspaceDir: string, localPath: string): string {
  const abs = isAbsolute(localPath) ? resolve(localPath) : resolve(workspaceDir, localPath);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new HttpError(400, `项目目录必须位于工作空间内：${localPath}`);
  }
  return abs;
}

export async function projectsView(profile: string, rootDir?: string): Promise<ProjectsView> {
  const { appPaths, workspaceDir, store } = await statePaths(profile, rootDir);
  const history = await readPullRecords(appPaths.pullHistoryFile, 200);
  const lastByProject = new Map<string, string>();
  for (const rec of history) {
    if (!lastByProject.has(rec.projectId)) lastByProject.set(rec.projectId, rec.ts);
  }

  const projects: ProjectView[] = [];
  for (const project of store.list()) {
    const absolutePath = resolveProjectDir(workspaceDir, project.localPath);
    const exists = await isGitRepo(run, absolutePath).catch(() => false);
    const status: RepoStatus = exists
      ? await repoStatus(run, absolutePath).catch(() => ({ branch: undefined, dirty: false, ahead: 0, behind: 0, hasUpstream: false }))
      : { branch: undefined, dirty: false, ahead: 0, behind: 0, hasUpstream: false };
    projects.push({
      ...project,
      absolutePath,
      exists,
      status,
      ...(lastByProject.get(project.id) ? { lastPullAt: lastByProject.get(project.id)! } : {}),
    });
  }
  return { ...(workspaceDir ? { workspaceDir } : {}), projects, schedule: store.getSchedule() };
}

export async function addProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const raw = body as { projects?: unknown };
  const items = Array.isArray(raw?.projects) ? raw.projects : [];
  if (items.length === 0) throw new HttpError(400, 'projects is required');
  await mkdir(workspaceDir, { recursive: true });

  for (const item of items) {
    const input = item as { repoUrl?: unknown; branch?: unknown; name?: unknown; localPath?: unknown; accountId?: unknown };
    const repoUrl = typeof input.repoUrl === 'string' ? input.repoUrl.trim() : '';
    if (!repoUrl) throw new HttpError(400, '仓库地址不能为空');
    const name = (typeof input.name === 'string' && input.name.trim()) || deriveName(repoUrl);
    if (!name) throw new HttpError(400, '项目名不能为空');
    // Default the checkout folder to the project name so the stored localPath
    // and the directory we clone into are always the same value.
    const localPath = (typeof input.localPath === 'string' && input.localPath.trim()) || name;
    const dir = resolveProjectDir(workspaceDir, localPath);
    let entry: ProjectEntry;
    try {
      entry = store.add({
        repoUrl,
        name,
        localPath,
        ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
        ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}),
      });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    try {
      await ensureCheckout(run, { repoUrl: entry.repoUrl, dir, branch: entry.branch });
    } catch (err) {
      store.remove(entry.id);
      await store.flush();
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function removeProject(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const { store } = await statePaths(profile, rootDir);
  const id = readId(body);
  if (!store.remove(id)) throw new HttpError(404, `项目不存在：${id}`);
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function updateProjectBranch(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const { store } = await statePaths(profile, rootDir);
  const raw = body as { branch?: unknown };
  const branch = typeof raw?.branch === 'string' ? raw.branch : '';
  try {
    store.updateBranch(readId(body), branch);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function setWorkspaceDir(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const raw = body as { path?: unknown };
  const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
  if (!path) throw new HttpError(400, 'path is required');
  const { state } = await statePaths(profile, rootDir);
  const listing = await browseDirectory(path).catch(() => undefined);
  if (!listing) throw new HttpError(400, `目录不存在或不可访问：${path}`);
  await saveWorkspaceConfig(state, listing.path);
  return projectsView(profile, rootDir);
}

export async function pullProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<{ results: PullRunItem[] }> {
  const { appPaths, workspaceDir, store } = await statePaths(profile, rootDir);
  const schedule = store.getSchedule();
  const raw = body as { id?: unknown };
  const onlyId = typeof raw?.id === 'string' ? raw.id : undefined;
  const targets = store.list().filter((p) => !onlyId || p.id === onlyId);
  if (onlyId && targets.length === 0) throw new HttpError(404, `项目不存在：${onlyId}`);

  const results: PullRunItem[] = [];
  for (const project of targets) {
    const dir = resolveProjectDir(workspaceDir, project.localPath);
    const startedAt = Date.now();
    let result: PullResult;
    let detail: string;
    if (!(await isGitRepo(run, dir).catch(() => false))) {
      result = 'failed';
      detail = '目录不存在或不是 git 仓库，请重新添加项目';
    } else {
      const outcome = await pullRepo(run, dir, schedule.strategy);
      result = outcome.status;
      detail = outcome.detail;
    }
    const entry: PullRunItem = {
      projectId: project.id,
      name: project.name,
      branch: project.branch,
      result,
      detail,
      durationMs: Date.now() - startedAt,
    };
    results.push(entry);
    await appendPullRecord(appPaths.pullHistoryFile, {
      ts: new Date().toISOString(),
      ...entry,
      trigger: 'manual',
    });
  }
  return { results };
}

export async function getSchedule(profile: string, rootDir?: string): Promise<PullSchedule> {
  const { store } = await statePaths(profile, rootDir);
  return store.getSchedule();
}

export async function setSchedule(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<PullSchedule> {
  const { store } = await statePaths(profile, rootDir);
  const raw = (body && typeof body === 'object' ? body : {}) as Partial<PullSchedule>;
  const next = store.setSchedule(raw);
  await store.flush();
  return next;
}

function readId(body: unknown): string {
  const raw = body as { id?: unknown };
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) throw new HttpError(400, 'id is required');
  return id;
}

function deriveName(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/integration/ui/workspace-api.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/workspace-api.ts tests/integration/ui/workspace-api.test.ts
git commit -m "feat(ui): add workspace API logic"
```

---

## Task 9: 注册 server 路由

**Files:**
- Modify: `src/ui/server.ts`
- Test: `tests/integration/ui/workspace-routes.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let handle: UiServerHandle;
let rootDir: string;
let workspace: string;
let base: string;

const supervisor: UiSupervisor = {
  isOnline: () => false,
  controlsFor: () => undefined,
  channelFor: () => undefined,
  list: () => [],
  startProfile: async () => {},
  stopProfile: async () => {},
  restartProfile: async () => {},
};

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-wsroute-'));
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
  handle = await startUiServer({ supervisor, version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Real local bare origin with one commit on `main`. */
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

function get(path: string) {
  return fetch(`${base}${path}`, { headers: { 'x-ui-token': handle.token } });
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': handle.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('workspace routes', () => {
  it('browses a directory', async () => {
    const res = await get(`/api/workspace/dir?path=${encodeURIComponent(workspace)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(await realpath(workspace));
  });

  it('adds, lists and removes a project', async () => {
    const origin = await makeOrigin(rootDir);
    const added = await (await post('/api/projects', { projects: [{ repoUrl: origin, name: 'x' }] })).json();
    expect(added.projects).toHaveLength(1);
    const id = added.projects[0].id;

    const removed = await (await post('/api/projects/remove', { id })).json();
    expect(removed.projects).toHaveLength(0);
  });

  it('sets the workspace root override', async () => {
    const other = join(rootDir, 'ws2');
    await mkdir(other, { recursive: true });
    const view = await (await post('/api/workspace/root', { path: other })).json();
    expect(view.workspaceDir).toBe(await realpath(other));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/integration/ui/workspace-routes.test.ts -v`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

在 `src/ui/server.ts` 顶部导入区加：

```ts
import {
  addProjects,
  projectsView,
  pullProjects,
  removeProject,
  setSchedule,
  getSchedule,
  setWorkspaceDir,
  updateProjectBranch,
} from './workspace-api';
import { browseDirectory } from '../workspace/dir-browse';
```

在 `route()` 内、`// --- in-meeting agent` 之前插入：

```ts
  // --- workspace & git projects ---
  if (path === '/api/workspace/dir' && g) {
    const target = url.searchParams.get('path') ?? undefined;
    try {
      sendJson(res, 200, await browseDirectory(target));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (path === '/api/workspace/root' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await setWorkspaceDir(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/projects' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await projectsView(profile, deps.rootDir));
    return;
  }
  if (path === '/api/projects' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await addProjects(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/projects/remove' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await removeProject(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/projects/branch' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await updateProjectBranch(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/projects/pull' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await pullProjects(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/schedule' && g) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await getSchedule(profile, deps.rootDir));
    return;
  }
  if (path === '/api/schedule' && p) {
    const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
    if (!profile) throw new HttpError(400, 'no profile');
    sendJson(res, 200, await setSchedule(profile, deps.rootDir, await readJsonBody(req)));
    return;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/integration/ui/workspace-routes.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/server.ts tests/integration/ui/workspace-routes.test.ts
git commit -m "feat(ui): register workspace and project routes"
```

---

## Task 10: 前端类型

**Files:**
- Modify: `web/src/lib/types.ts`

- [ ] **Step 1: 追加类型**

```ts
// ── workspace & git projects ─────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  dirs: DirEntry[];
  roots?: DirEntry[];
}

export interface RepoStatus {
  branch?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export type PullStrategy = "ff-only" | "fetch-only" | "reset-hard";

export interface PullSchedule {
  enabled: boolean;
  intervalMinutes: number;
  strategy: PullStrategy;
  notifyOnFailure: boolean;
}

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
}

export interface ProjectsView {
  workspaceDir?: string;
  projects: ProjectView[];
  schedule: PullSchedule;
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --dir web exec tsc --noEmit -p tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 3: 提交**

```bash
git add web/src/lib/types.ts
git commit -m "feat(web): add workspace types"
```

---

## Task 11: 控制台「工作空间」页

**Files:**
- Create: `web/src/views/WorkspaceView.tsx`

- [ ] **Step 1: 实现组件（完整文件）**

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { DirListing, ProjectView, ProjectsView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

export function WorkspaceView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<ProjectsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(
    () =>
      apiGet<ProjectsView>(`/api/projects?${q}`)
        .then((v) => { setView(v); setError(null); })
        .catch((e) => setError(String(e.message ?? e))),
    [q],
  );
  useEffect(() => { void load(); }, [load]);

  async function setRoot(path: string) {
    setBusy(true);
    try {
      await apiPost(`/api/workspace/root?${q}`, { path });
      toast.success("已设置工作空间目录");
      setPickerOpen(false);
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function pull(id?: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/pull?${q}`, id ? { id } : {});
      toast.success("已拉取");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/remove?${q}`, { id });
      toast.success("已移除（未删除磁盘目录）");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  }

  async function setBranch(id: string, branch: string) {
    try {
      await apiPost(`/api/projects/branch?${q}`, { id, branch });
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!view) return <p className="text-muted-foreground text-sm">加载中…</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>工作空间目录</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>更换目录…</Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
            {view.workspaceDir ?? "（未设置）"}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            项目仓库默认克隆到该目录下；默认值来自启动参数 <code>--workspace</code>，可修改。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>项目（{view.projects.length}）</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => pull()}>全部拉取</Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>+ 添加项目</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {view.projects.length === 0 && (
            <p className="text-sm text-muted-foreground">还没有项目，点「添加项目」填入仓库地址。</p>
          )}
          {view.projects.map((p) => <ProjectRow key={p.id} project={p} busy={busy} onPull={pull} onRemove={remove} onBranch={setBranch} />)}
        </CardContent>
      </Card>

      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} busy={busy} onPick={setRoot} />
      <AddProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        busy={busy}
        onAdd={async (repoUrl, branch) => {
          setBusy(true);
          try {
            await apiPost(`/api/projects?${q}`, { projects: [{ repoUrl, branch }] });
            toast.success("已添加并检出");
            setAddOpen(false);
            await load();
          } catch (e) {
            toast.error(String((e as Error).message ?? e));
          } finally { setBusy(false); }
        }}
      />
    </div>
  );
}

function statusBadge(p: ProjectView) {
  if (!p.exists) return <Badge variant="destructive">未检出</Badge>;
  if (p.status.dirty) return <Badge variant="secondary">有本地改动</Badge>;
  if (p.status.behind > 0) return <Badge variant="secondary">落后 {p.status.behind}</Badge>;
  return <Badge variant="success">已最新</Badge>;
}

function ProjectRow({ project, busy, onPull, onRemove, onBranch }: {
  project: ProjectView;
  busy: boolean;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onBranch: (id: string, branch: string) => void;
}) {
  const [branch, setBranch] = useState(project.branch);
  useEffect(() => { setBranch(project.branch); }, [project.branch]);
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{project.name} {statusBadge(project)}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{project.repoUrl}</div>
      </div>
      <Input
        className="h-8 w-[130px]"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onBlur={() => { if (branch.trim() && branch !== project.branch) onBranch(project.id, branch.trim()); }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onPull(project.id)}>拉取</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(project.id)}>移除</Button>
    </div>
  );
}

function DirectoryPicker({ open, onOpenChange, busy, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback((path?: string) => {
    setError(null);
    apiGet<DirListing>(`/api/workspace/dir${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then(setListing)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => { if (open) browse(); }, [open, browse]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription>从本机磁盘选择工作空间根目录。</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {listing && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Button variant="outline" size="sm" onClick={() => listing.parent && browse(listing.parent)} disabled={!listing.parent}>
                ↑ 上一级
              </Button>
              <span className="truncate font-mono text-xs text-muted-foreground">{listing.path || "此电脑"}</span>
            </div>
            <div className="max-h-[46vh] divide-y overflow-y-auto rounded-md border">
              {(listing.roots ?? listing.dirs).map((d) => (
                <button
                  key={d.path}
                  className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => browse(d.path)}
                >
                  📁 {d.name}
                </button>
              ))}
              {(listing.roots ?? listing.dirs).length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">（没有子目录）</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">已选：<span className="font-mono">{listing.path || "—"}</span></p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => listing?.path && onPick(listing.path)} disabled={busy || !listing?.path}>
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddProjectDialog({ open, onOpenChange, busy, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onAdd: (repoUrl: string, branch: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  useEffect(() => { if (open) { setRepoUrl(""); setBranch("main"); } }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>填入仓库地址与分支，保存后会 clone 到工作空间目录下。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>仓库地址</Label>
            <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://… 或 git@…" />
          </div>
          <div className="space-y-1.5">
            <Label>分支</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => onAdd(repoUrl.trim(), branch.trim() || "main")} disabled={busy || !repoUrl.trim()}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --dir web exec tsc --noEmit -p tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 3: 提交**

```bash
git add web/src/views/WorkspaceView.tsx
git commit -m "feat(web): add workspace view"
```

---

## Task 12: 挂载入口、文档与整体校验

**Files:**
- Modify: `web/src/views/ProfileDetail.tsx`
- Modify: `README.md`（数据目录表新增两行）

- [ ] **Step 1: 在 ProfileDetail 用 Tabs 挂载**

在 `web/src/views/ProfileDetail.tsx` 顶部导入区加（`ConfigView` 已有导入，勿重复添加）：

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspaceView } from "./WorkspaceView";
```

把原来的：

```tsx
      <ConfigView profile={profile} />
```

替换为：

```tsx
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="workspace">工作空间</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="mt-4">
          <ConfigView profile={profile} />
        </TabsContent>
        <TabsContent value="workspace" className="mt-4">
          <WorkspaceView profile={profile} />
        </TabsContent>
      </Tabs>
```

- [ ] **Step 2: README 数据目录表追加两行**

在 `README.md` 的「Data directories」表格中，`workspaces.json` 一行之后插入：

```markdown
| `~/.lark-channel/profiles/<profile>/projects.json` | Workspace git projects + pull schedule |
| `~/.lark-channel/profiles/<profile>/pull-history.jsonl` | Recent pull-execution records |
```

- [ ] **Step 3: 全量校验**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全部通过（`build` 会先 `build:web` 再 `tsup`）

- [ ] **Step 4: 提交**

```bash
git add web/src/views/ProfileDetail.tsx README.md
git commit -m "feat(web): mount workspace view and document data files"
```

---

## 验收（P1）

1. `pnpm vitest run` 全绿；新增单测/集成测试覆盖 git-ops、projects、history、dir-browse、workspace-api、routes。
2. `pnpm typecheck` 通过（含 `web`）。
3. `pnpm build` 产出内联控制台。
4. 控制台某 profile 的「工作空间」页可：浏览本机目录并设置根目录（默认来自 `--workspace`）；添加项目（clone 到工作空间、或关联已存在的仓库）；改分支；移除（不删目录）；全部/单个拉取；看到「已最新 / 落后 N / 有本地改动 / 未检出」状态。
5. 所有写操作落 `projects.json` / `workspaces.default` / `pull-history.jsonl`，且 0600。

## 后续（不在本计划）

- **P2**：全局 Git 账号（`git-accounts.json` + 主机级 keystore）、provider 列仓库、从账号添加。
- **P3**：supervisor 定时任务、执行记录 UI、`/config` 卡片与斜杠命令、失败通知。
