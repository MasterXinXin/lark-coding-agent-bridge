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
