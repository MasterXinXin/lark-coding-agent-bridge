import { readdir, stat } from 'node:fs/promises';
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
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

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
