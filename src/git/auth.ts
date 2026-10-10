import { getSecret, type KeystorePaths } from '../config/keystore';
import type { GitRunner } from './git-ops';

/** Keep the helper's username shell-safe; fall back to a generic value. */
function safeUsername(input: string | undefined): string {
  const trimmed = (input ?? '').trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._@-]/g, '');
  return sanitized || 'oauth2';
}

/**
 * Build the git environment for an account. The PAT is passed via
 * `LARK_GIT_TOKEN` and consumed by a `credential.helper` configured through
 * `GIT_CONFIG_*` env vars, so it never appears in the process command line.
 * With no account (or no stored secret) only `GIT_TERMINAL_PROMPT=0` is set.
 */
export async function gitEnvForAccount(
  accountId: string | undefined,
  storePaths: KeystorePaths,
  username?: string,
): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (!accountId) return base;
  const token = await getSecret(`git-account:${accountId}`, storePaths).catch(() => undefined);
  if (!token) return base;
  const helper = `!f() { echo "username=${safeUsername(username)}"; echo "password=$LARK_GIT_TOKEN"; }; f`;
  return {
    ...base,
    LARK_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: helper,
  };
}

/** Wrap a runner so every call carries the account env (per-call env wins). */
export function withGitEnv(run: GitRunner, env: NodeJS.ProcessEnv): GitRunner {
  return (args, opts = {}) => run(args, { ...opts, env: { ...env, ...(opts.env ?? {}) } });
}
