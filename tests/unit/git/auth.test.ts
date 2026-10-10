import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setSecret } from '../../../src/config/keystore';
import { gitEnvForAccount, withGitEnv } from '../../../src/git/auth';
import { hostStorePaths, tokenRefFor } from '../../../src/git/accounts';
import type { GitRunner } from '../../../src/git/git-ops';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function storePaths() {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-auth-'));
  cleanups.push(rootDir);
  return hostStorePaths(rootDir);
}

describe('gitEnvForAccount', () => {
  it('returns only GIT_TERMINAL_PROMPT when no account is given', async () => {
    const paths = await storePaths();
    expect(await gitEnvForAccount(undefined, paths)).toEqual({ GIT_TERMINAL_PROMPT: '0' });
  });

  it('injects the token and a credential helper into the env, not argv', async () => {
    const paths = await storePaths();
    await setSecret(tokenRefFor('gh-1'), 'ghp_secret', paths);
    const env = await gitEnvForAccount('gh-1', paths, 'octocat');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LARK_GIT_TOKEN).toBe('ghp_secret');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toContain('username=octocat');
    expect(env.GIT_CONFIG_VALUE_0).toContain('password=$LARK_GIT_TOKEN');
    // The secret lives only in LARK_GIT_TOKEN, never in the helper command.
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('ghp_secret');
  });

  it('sanitizes the username, falls back to oauth2, and skips injection without a secret', async () => {
    const paths = await storePaths();
    await setSecret(tokenRefFor('gh-sanitize'), 'tok', paths);
    const env = await gitEnvForAccount('gh-sanitize', paths, 'bad name/../x');
    expect(env.GIT_CONFIG_VALUE_0).toContain('username=badname..x');
    const fallback = await gitEnvForAccount('gh-sanitize', paths, '!!!');
    expect(fallback.GIT_CONFIG_VALUE_0).toContain('username=oauth2');
    const absent = await gitEnvForAccount('gh-no-secret', paths);
    expect(absent).toEqual({ GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('withGitEnv', () => {
  it('merges the account env into every git call', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const run: GitRunner = async (args, opts) => {
      calls.push({ args, env: opts?.env });
      return { code: 0, stdout: '', stderr: '' };
    };
    const wrapped = withGitEnv(run, { LARK_GIT_TOKEN: 't' });
    await wrapped(['fetch'], { cwd: '/repo', env: { GIT_TERMINAL_PROMPT: '0' } });
    expect(calls[0]!.args).toEqual(['fetch']);
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', LARK_GIT_TOKEN: 't' });
  });
});
