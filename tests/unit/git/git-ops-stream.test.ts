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

  it('forwards stderr fragments to onOutput (not just stdout)', async () => {
    const chunks: string[] = [];
    // An unknown top-level flag makes git write only to stderr, so anything
    // onOutput sees must have come from the stderr stream.
    const r = await createGitRunner()(['--not-a-real-flag'], { onOutput: (c) => chunks.push(c) });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown option');
    expect(chunks.join('')).toContain('unknown option');
  });

  it('contains a throwing onOutput instead of rejecting the call', async () => {
    const r = await createGitRunner()(['version'], {
      onOutput: () => {
        throw new Error('consumer boom');
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('git version');
    expect(r.stderr).toContain('onOutput error');
  });
});

describe('progress output args', () => {
  it('passes --progress to clone before the -- separator', async () => {
    const { run, calls } = recordingRunner();
    await cloneRepo(run, { repoUrl: 'https://x/y.git', dir: '/repo', branch: 'main' });
    const clone = calls.find((a) => a[0] === 'clone');
    expect(clone).toEqual(['clone', '--progress', '--branch', 'main', '--', 'https://x/y.git', '/repo']);
    expect(clone!.indexOf('--progress')).toBeLessThan(clone!.indexOf('--'));
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
    expect(pull).toEqual(['pull', '--ff-only', '--progress']);
  });

  it('passes --progress to fetch in the fetch-only branch', async () => {
    const { run, calls } = recordingRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: '' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '0\t0\n' },
      'fetch --prune --progress': { stdout: '' },
    });
    const out = await pullRepo(run, '/repo', 'fetch-only');
    expect(out.status).toBe('up-to-date');
    const fetches = calls.filter((a) => a[0] === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(['fetch', '--prune', '--progress']);
  });

  it('passes --progress to fetch in the reset-hard branch', async () => {
    const { run, calls } = recordingRunner({
      'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: '' },
      'rev-list --left-right --count @{upstream}...HEAD': { stdout: '0\t0\n' },
      'fetch --prune --progress': { stdout: '' },
      'reset --hard origin/main': { stdout: '' },
    });
    const out = await pullRepo(run, '/repo', 'reset-hard');
    expect(out.status).toBe('updated');
    const fetches = calls.filter((a) => a[0] === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(['fetch', '--prune', '--progress']);
  });
});

describe('pullRepo failure detail', () => {
  const statusAnswers = {
    'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    'status --porcelain': { stdout: '' },
    'rev-list --left-right --count @{upstream}...HEAD': { stdout: '0\t0\n' },
  };

  it('strips CR progress frames and keeps the fatal line', async () => {
    const progress = [
      'remote: Enumerating objects: 12, done.',
      'remote: Counting objects: 100% (12/12), done.',
      'Receiving objects:  42% (5/12)\rReceiving objects:  83% (10/12)\rReceiving objects: 100% (12/12), done.',
    ].join('\n');
    const { run } = recordingRunner({
      ...statusAnswers,
      'pull --ff-only --progress': {
        code: 1,
        stdout: '',
        stderr: `${progress}\nfatal: refusing to merge unrelated histories\n`,
      },
    });
    const out = await pullRepo(run, '/repo', 'ff-only');
    expect(out.status).toBe('failed');
    expect(out.detail).toContain('fatal: refusing to merge unrelated histories');
    expect(out.detail).not.toContain('Receiving objects');
  });

  it('keeps the trailing fatal line even when non-progress noise exceeds 500 chars', async () => {
    const noise = Array.from({ length: 60 }, (_, i) => `remote: diagnostic line ${String(i).padStart(3, '0')}`).join(
      '\n',
    );
    const { run } = recordingRunner({
      ...statusAnswers,
      'pull --ff-only --progress': {
        code: 1,
        stdout: '',
        stderr: `${noise}\nfatal: authentication failed for 'https://x/y.git/'\n`,
      },
    });
    const out = await pullRepo(run, '/repo', 'ff-only');
    expect(out.status).toBe('failed');
    expect(out.detail).toContain("fatal: authentication failed for 'https://x/y.git/'");
    expect(out.detail.length).toBeLessThanOrEqual(500);
  });
});
