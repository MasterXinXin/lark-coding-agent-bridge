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
