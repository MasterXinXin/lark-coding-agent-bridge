import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { resolveAppPaths } from '../config/app-paths';
import {
  getSecret,
  listSecretIds,
  removeSecret,
  setSecret,
  type KeystorePaths,
} from '../config/keystore';
import { writeFileAtomic } from '../platform/atomic-write';

export type GitProvider = 'github' | 'gitlab' | 'gitea' | 'other';

export interface GitAccount {
  id: string;
  label: string;
  provider: GitProvider;
  baseUrl: string;
  username?: string;
  /** Keystore key holding the PAT, e.g. `git-account:gh-1`. */
  tokenRef: string;
}

/** Public shape for API responses — never carries the token. */
export interface GitAccountView {
  id: string;
  label: string;
  provider: GitProvider;
  baseUrl: string;
  username?: string;
  hasToken: boolean;
}

export interface GitAccountsFile {
  version: 1;
  accounts: GitAccount[];
}

export interface UpsertAccountInput {
  id?: string;
  label: string;
  provider: GitProvider;
  baseUrl: string;
  username?: string;
  /** Empty/omitted leaves any already-stored secret intact. */
  token?: string;
}

export function tokenRefFor(id: string): string {
  return `git-account:${id}`;
}

/** Host-level keystore paths (machine-wide, shared by every profile). */
export function hostStorePaths(rootDir?: string): KeystorePaths {
  const appPaths = resolveAppPaths({ rootDir });
  return { secretsFile: appPaths.hostSecretsFile, keystoreSaltFile: appPaths.hostKeystoreSaltFile };
}

export function isProvider(value: unknown): value is GitProvider {
  return value === 'github' || value === 'gitlab' || value === 'gitea' || value === 'other';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize a provider base URL by trimming whitespace and trailing slashes.
 * `other` may be empty; the API-backed providers require an http(s) URL.
 */
export function normalizeBaseUrl(provider: GitProvider, raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed && provider === 'other') return '';
  if (!trimmed) throw new Error('服务地址不能为空');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('服务地址必须以 http(s):// 开头');
  return trimmed;
}

export function toView(account: GitAccount, hasToken: boolean): GitAccountView {
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    baseUrl: account.baseUrl,
    ...(account.username ? { username: account.username } : {}),
    hasToken,
  };
}

function normalizeAccount(input: unknown): GitAccount | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<GitAccount>;
  const id = str(raw.id);
  const label = str(raw.label);
  const provider = isProvider(raw.provider) ? raw.provider : undefined;
  if (!id || !label || !provider) return undefined;
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(provider, str(raw.baseUrl));
  } catch {
    return undefined;
  }
  const username = str(raw.username);
  return {
    id,
    label,
    provider,
    baseUrl,
    ...(username ? { username } : {}),
    tokenRef: str(raw.tokenRef) || tokenRefFor(id),
  };
}

export function normalizeAccountsFile(input: unknown): GitAccountsFile {
  const raw = (input && typeof input === 'object' ? input : {}) as { accounts?: unknown };
  const accounts: GitAccount[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.accounts)) {
    for (const item of raw.accounts) {
      const account = normalizeAccount(item);
      if (!account || seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
    }
  }
  return { version: 1, accounts };
}

function generateAccountId(provider: GitProvider): string {
  const prefix =
    provider === 'github' ? 'gh' : provider === 'gitlab' ? 'gl' : provider === 'gitea' ? 'gt' : 'git';
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export class GitAccountStore {
  private data: GitAccountsFile = { version: 1, accounts: [] };
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly storePaths: KeystorePaths,
  ) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      this.data = normalizeAccountsFile(JSON.parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  list(): GitAccount[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  get(id: string): GitAccount | undefined {
    const found = this.data.accounts.find((a) => a.id === id);
    return found ? { ...found } : undefined;
  }

  /** Create or update an account. Tokens go straight to the host keystore. */
  async upsert(input: UpsertAccountInput): Promise<GitAccount> {
    const label = input.label.trim();
    if (!label) throw new Error('账号名称不能为空');
    if (!isProvider(input.provider)) throw new Error('不支持的代码平台');
    const baseUrl = normalizeBaseUrl(input.provider, input.baseUrl);
    const username = input.username?.trim() ?? '';
    const token = input.token?.trim() ?? '';
    const requestedId = input.id?.trim() ?? '';
    const existing = requestedId ? this.data.accounts.find((a) => a.id === requestedId) : undefined;
    if (requestedId && !existing) throw new Error(`账号不存在：${requestedId}`);

    const id = existing?.id ?? (requestedId || generateAccountId(input.provider));
    const entry: GitAccount = {
      id,
      label,
      provider: input.provider,
      baseUrl,
      ...(username ? { username } : {}),
      tokenRef: tokenRefFor(id),
    };
    if (token) await setSecret(entry.tokenRef, token, this.storePaths);

    if (existing) {
      const idx = this.data.accounts.findIndex((a) => a.id === id);
      this.data.accounts[idx] = entry;
    } else {
      this.data.accounts.push(entry);
    }
    this.schedulePersist();
    return { ...entry };
  }

  async remove(id: string): Promise<boolean> {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.accounts.length === before) return false;
    await removeSecret(tokenRefFor(id), this.storePaths).catch(() => false);
    this.schedulePersist();
    return true;
  }

  async getToken(id: string): Promise<string | undefined> {
    const account = this.get(id);
    if (!account) return undefined;
    return getSecret(account.tokenRef, this.storePaths);
  }

  /** Whether a token is stored, without decrypting it. */
  async hasToken(id: string): Promise<boolean> {
    const account = this.get(id);
    if (!account) return false;
    return (await listSecretIds(this.storePaths)).includes(account.tokenRef);
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() =>
        writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 }),
      )
      .catch((err: unknown) => {
        log.fail('git', err, { step: 'persist-accounts' });
        throw err;
      });
    // Keep an unawaited rejection handled (cannot crash the process) while
    // `flush()` still observes it — same contract as `ProjectStore`.
    void this.saving.catch(() => undefined);
  }
}
