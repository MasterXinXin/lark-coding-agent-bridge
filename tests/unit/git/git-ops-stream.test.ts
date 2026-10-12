import { describe, expect, it } from 'vitest';
import { cloneRepo, createGitRunner, pullRepo, type GitResult, type GitRunner } from '../../../src/git/git-ops';

/** A fake runner that records every argv it is asked to run. */
function recordingRunner(
  answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = async (args): Promise<GitResult> => {
    calls.push(args);
    const hit = answers[args.join(' ')];
    return { code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' };
  };
  return { run, calls };
}

describe('createGitRunner onOutput', () => {
  it('streams stdout chunks while returning the full output', async () => {
    const chunks: string[] = [];
    const r = await createGitRunner()(['version'], { onOutput: (c) => chunks.push(c) });
    expect(r.code).toBe(0);
    expect(chunks.join('')).toContain('git version');
    expect(r.stdout).toContain('git version');
  });
});

describe('progress output args', () => {
  it('passes --progress to clone', async () => {
    const { run, calls } = recordingRunner();
    await cloneRepo(run, { repoUrl: 'https://x/y.git', dir: '/repo', branch: 'main' });
    const clone = calls.find((a) => a[0] === 'clone');
    expect(clone).toBeDefined();
    expect(clone).toContain('--progress');
  });

  it('passes --progress to pull --ff-only', async () => {
    const { run, calls } = recordingRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: '' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '0\t0\n' },
      'pull --ff-only --progress': { stdout: 'Already up to date.\n' },
    });
    const out = await pullRepo(run, '/repo', 'ff-only');
    expect(out.status).toBe('up-to-date');
    const pull = calls.find((a) => a[0] === 'pull');
    expect(pull).toBeDefined();
    expect(pull).toContain('--progress');
  });
});
