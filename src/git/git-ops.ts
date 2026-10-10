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
