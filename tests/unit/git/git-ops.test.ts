import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentBranch,
  ensureCheckout,
  isGitRepo,
  normalizeRemote,
  pullRepo,
  remoteUrl,
  repoStatus,
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
