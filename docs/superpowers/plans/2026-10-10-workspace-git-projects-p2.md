# Workspace & Git Projects — P2 (Global Git Accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-wide Git accounts (metadata in `~/.lark-channel/git-accounts.json`, PAT in the host keystore), provider-backed repo/branch listing, the "从账号添加" flow, and token injection into `git` clone/pull without the token ever appearing in argv.

**Architecture:** A host-level `GitAccountStore` (`src/git/accounts.ts`) persists account metadata to `git-accounts.json` and tokens to the host keystore via the existing `keystore.ts` `setSecret/getSecret/removeSecret` with host-level `storePaths`. `src/git/auth.ts` builds a `GIT_CONFIG_*` credential-helper environment plus `LARK_GIT_TOKEN`; `src/git/providers.ts` calls each platform's REST API through an injectable `fetch`. `src/ui/git-api.ts` exposes REST logic behind `src/ui/server.ts` routes, and `src/ui/workspace-api.ts` threads the account env into `ensureCheckout`/`pullRepo`. The console gains a "Git 账号" card and a two-tab add-project dialog.

**Tech Stack:** TypeScript (ESM, strict + `noUncheckedIndexedAccess`), Node 20+ (`fetch`/`AbortController`/`Response` built in), vitest, React 19 + Vite + shadcn/ui, tsup.

**规格来源:** `docs/superpowers/specs/2026-10-10-workspace-git-projects-design.md`（§13 P2 = 「全局 Git 账号 + 仓库列表 + 从账号添加 + token 注入拉取」；关联 §4.1、§5、§6.2、§8、§11、§14、§15）。

**范围（本计划只做 P2）：** AppPaths 主机级路径；全局账号 store；provider 适配（列表/分支/测试连接）；`/api/git/*` 路由；token 环境注入到 clone/pull；控制台 Git 账号卡片与「从账号添加」；README。

**明确不做（留待 P3 或后续）：** supervisor 定时任务 `src/workspace/scheduler.ts`、执行记录 UI、`/config` 卡片区块、斜杠命令（`/ws`、`/project`）、失败飞书通知。P2 保持可独立发布、可独立测试。

---

## File Structure

**Create**
- `src/git/accounts.ts` — 主机级 Git 账号 store（CRUD + 主机 keystore 读写，永不回显 token）
- `src/git/auth.ts` — 由账号构建 git 凭证环境（env 注入）+ `withGitEnv` 包装 runner
- `src/git/providers.ts` — GitHub/GitLab/Gitea/other 适配：列仓库、列分支、测试连接（可注入 fetch）
- `src/ui/git-api.ts` — 控制台 `/api/git/*` 的 REST 逻辑
- `web/src/components/GitAccountCard.tsx` — 「Git 账号」卡片 + `AccountDialog`
- `web/src/components/AddProjectDialog.tsx` — 两 Tab 的添加项目弹框（从账号选择 / 手动输入地址）
- 测试：`tests/unit/git/accounts.test.ts`、`tests/unit/git/auth.test.ts`、`tests/unit/git/providers.test.ts`、`tests/integration/ui/git-api.test.ts`、`tests/integration/ui/git-routes.test.ts`、`tests/integration/ui/workspace-git-auth.test.ts`

**Modify**
- `src/config/app-paths.ts` — 新增 `gitAccountsFile`、`hostSecretsFile`、`hostKeystoreSaltFile`
- `src/ui/types.ts` — `UiServerDeps.fetchImpl?`（测试可注入 mock fetch）
- `src/ui/server.ts` — `DELETE` 支持 + `/api/git/*` 路由
- `src/ui/workspace-api.ts` — add/pull 时解析账号环境并注入
- `web/src/lib/types.ts` — `GitProvider`/`GitAccount`/`AccountsView`/`RemoteRepo`/`ReposView`/`AccountTestResult`
- `web/src/lib/api.ts` — `apiDelete`
- `web/src/views/WorkspaceView.tsx` — 挂载账号卡片 + 用新的添加弹框替换内联实现
- `tests/unit/config/app-paths.test.ts` — 主机级路径断言
- `README.md`、`README.zh.md` — 数据目录表新增主机级账号/密钥行

---

## Task 1: 扩展 AppPaths（主机级账号与密钥路径）

**Files:**
- Modify: `src/config/app-paths.ts`
- Test: `tests/unit/config/app-paths.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/config/app-paths.test.ts` 的 `describe('resolveAppPaths', ...)` 内追加：

```ts
  it('exposes host-level git account and keystore paths', () => {
    const p = resolveAppPaths({ rootDir: '/tmp/root', profile: 'work' });
    expect(p.gitAccountsFile).toBe(join('/tmp/root', 'git-accounts.json'));
    expect(p.hostSecretsFile).toBe(join('/tmp/root', 'secrets.enc'));
    expect(p.hostKeystoreSaltFile).toBe(join('/tmp/root', '.keystore.salt'));
  });
```

（文件顶部已有 `import { join } from 'node:path';` 与 `resolveAppPaths` 导入，无需新增。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts -v`
Expected: FAIL（`gitAccountsFile` 为 `undefined`，断言 `expected undefined to be '/tmp/root/git-accounts.json'`）

- [ ] **Step 3: 实现**

在 `src/config/app-paths.ts` 的 `AppPaths` 接口中，`pullHistoryFile` 之后加：

```ts
  gitAccountsFile: string;
  hostSecretsFile: string;
  hostKeystoreSaltFile: string;
```

在 `resolveAppPaths` 返回对象中，`pullHistoryFile` 之后加：

```ts
    gitAccountsFile: join(rootDir, 'git-accounts.json'),
    hostSecretsFile: join(rootDir, 'secrets.enc'),
    hostKeystoreSaltFile: join(rootDir, '.keystore.salt'),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config/app-paths.ts tests/unit/config/app-paths.test.ts
git commit -m "feat(config): add host-level git account and keystore paths"
```

---

## Task 2: 全局账号 store（`src/git/accounts.ts`）

**Files:**
- Create: `src/git/accounts.ts`
- Test: `tests/unit/git/accounts.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { listSecretIds } from '../../../src/config/keystore';
import {
  GitAccountStore,
  hostStorePaths,
  normalizeBaseUrl,
  tokenRefFor,
} from '../../../src/git/accounts';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStore() {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-accounts-'));
  cleanups.push(rootDir);
  const file = resolveAppPaths({ rootDir, profile: 'claude' }).gitAccountsFile;
  const storePaths = hostStorePaths(rootDir);
  const store = new GitAccountStore(file, storePaths);
  await store.load();
  return { rootDir, file, storePaths, store };
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and allows an empty base only for "other"', () => {
    expect(normalizeBaseUrl('github', 'https://api.github.com/')).toBe('https://api.github.com');
    expect(normalizeBaseUrl('other', '  ')).toBe('');
    expect(() => normalizeBaseUrl('gitlab', '')).toThrow(/不能为空/);
    expect(() => normalizeBaseUrl('gitea', 'gitlab.com')).toThrow(/http/);
  });
});

describe('GitAccountStore', () => {
  it('creates an account with a generated id and stores the token as a secret', async () => {
    const { store } = await makeStore();
    const created = await store.upsert({
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    expect(created.id).toMatch(/^gh-[0-9a-f]{8}$/);
    expect(created.tokenRef).toBe(tokenRefFor(created.id));
    expect(await store.getToken(created.id)).toBe('ghp_secret');
    expect(await store.hasToken(created.id)).toBe(true);
  });

  it('preserves the stored token when an update omits it', async () => {
    const { store } = await makeStore();
    const created = await store.upsert({
      label: 'GH',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const updated = await store.upsert({
      id: created.id,
      label: 'GH renamed',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: '',
    });
    expect(updated).toMatchObject({ id: created.id, label: 'GH renamed' });
    expect(await store.getToken(created.id)).toBe('ghp_secret');
  });

  it('removes the account and its secret', async () => {
    const { store, storePaths } = await makeStore();
    const created = await store.upsert({
      label: 'Gitea',
      provider: 'gitea',
      baseUrl: 'https://gitea.com/',
      token: 't',
    });
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
    expect(await listSecretIds(storePaths)).not.toContain(tokenRefFor(created.id));
    expect(store.list()).toHaveLength(0);
  });

  it('reloads persisted accounts from disk', async () => {
    const { store, file, storePaths } = await makeStore();
    await store.upsert({
      label: 'GitLab',
      provider: 'gitlab',
      baseUrl: 'https://gitlab.com',
      username: 'me',
      token: 't',
    });
    await store.flush();

    const reloaded = new GitAccountStore(file, storePaths);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({
      label: 'GitLab',
      provider: 'gitlab',
      username: 'me',
      baseUrl: 'https://gitlab.com',
    });
  });

  it('rejects an unknown provider and a blank label', async () => {
    const { store } = await makeStore();
    await expect(
      store.upsert({ label: 'X', provider: 'bitbucket' as never, baseUrl: 'https://x', token: '' }),
    ).rejects.toThrow(/平台/);
    await expect(
      store.upsert({ label: '  ', provider: 'github', baseUrl: 'https://api.github.com', token: '' }),
    ).rejects.toThrow(/名称/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/accounts.test.ts -v`
Expected: FAIL（模块不存在：`Failed to resolve import "../../../src/git/accounts"`）

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/accounts.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git/accounts.ts tests/unit/git/accounts.test.ts
git commit -m "feat(git): add host-level git account store"
```

---

## Task 3: git 凭证环境（`src/git/auth.ts`）

**Files:**
- Create: `src/git/auth.ts`
- Test: `tests/unit/git/auth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
    const wrapped = withGitEnv(run, { LARK_GIT_TOKEN: 't', GIT_TERMINAL_PROMPT: '0' });
    await wrapped(['fetch'], { cwd: '/repo', env: { GIT_TERMINAL_PROMPT: '1' } });
    expect(calls[0]!.args).toEqual(['fetch']);
    // Account env is merged in, but a per-call env key wins.
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '1', LARK_GIT_TOKEN: 't' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/auth.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/auth.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git/auth.ts tests/unit/git/auth.test.ts
git commit -m "feat(git): build credential-injecting git env per account"
```

---

## Task 4: provider 适配 — 列仓库（`listRepos`）

**Files:**
- Create: `src/git/providers.ts`
- Test: `tests/unit/git/providers.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import type { GitAccount } from '../../../src/git/accounts';
import { listRepos, type FetchLike } from '../../../src/git/providers';

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const github: GitAccount = {
  id: 'gh-1',
  label: 'GitHub',
  provider: 'github',
  baseUrl: 'https://api.github.com',
  tokenRef: 'git-account:gh-1',
};

describe('listRepos', () => {
  it('maps GitHub repos and follows the Link header for more pages', async () => {
    let seenUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      seenUrl = String(input);
      return jsonResponse(
        [
          {
            id: 1,
            name: 'api',
            full_name: 'acme/api',
            clone_url: 'https://github.com/acme/api.git',
            ssh_url: 'git@github.com:acme/api.git',
            default_branch: 'main',
            private: true,
          },
        ],
        { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      );
    };
    const page = await listRepos(github, 'tok', { page: 1 }, fetchImpl);
    expect(seenUrl).toContain('/user/repos');
    expect(seenUrl).toContain('per_page=100');
    expect(page.repos[0]).toMatchObject({
      name: 'api',
      fullName: 'acme/api',
      private: true,
      defaultBranch: 'main',
    });
    expect(page.hasMore).toBe(true);
  });

  it('uses the PRIVATE-TOKEN header for GitLab and x-next-page pagination', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_input, init) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse(
        [
          {
            id: 7,
            name: 'svc',
            path_with_namespace: 'team/svc',
            http_url_to_repo: 'https://gitlab.com/team/svc.git',
            ssh_url_to_repo: 'git@gitlab.com:team/svc.git',
            default_branch: 'dev',
            visibility: 'private',
          },
        ],
        { 'x-next-page': '2' },
      );
    };
    const page = await listRepos(
      { ...github, provider: 'gitlab', baseUrl: 'https://gitlab.com' },
      'tok',
      {},
      fetchImpl,
    );
    expect(headers['PRIVATE-TOKEN']).toBe('tok');
    expect(page.repos[0]).toMatchObject({ fullName: 'team/svc', defaultBranch: 'dev', private: true });
    expect(page.hasMore).toBe(true);
  });

  it('uses the token header for Gitea and passes the page param', async () => {
    let seenUrl = '';
    let headers: Record<string, string> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      seenUrl = String(input);
      headers = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse([
        {
          id: 3,
          name: 'repo',
          full_name: 'me/repo',
          clone_url: 'https://gitea.com/me/repo.git',
          ssh_url: 'git@gitea.com:me/repo.git',
          default_branch: 'main',
          private: false,
        },
      ]);
    };
    const page = await listRepos(
      { ...github, provider: 'gitea', baseUrl: 'https://gitea.com' },
      'tok',
      { page: 2 },
      fetchImpl,
    );
    expect(seenUrl).toContain('page=2');
    expect(headers.Authorization).toBe('token tok');
    expect(page.repos[0]).toMatchObject({ fullName: 'me/repo' });
  });

  it('rejects providers that do not support listing', async () => {
    await expect(
      listRepos({ ...github, provider: 'other', baseUrl: '' }, 'tok', {}, async () => jsonResponse([])),
    ).rejects.toThrow(/不支持/);
  });

  it('maps 401 to a token error', async () => {
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 401 });
    await expect(listRepos(github, 'tok', {}, fetchImpl)).rejects.toThrow(/令牌无效或权限不足/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/providers.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import type { GitAccount } from './accounts';

export interface RemoteRepo {
  id: string;
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface RepoListPage {
  repos: RemoteRepo[];
  hasMore: boolean;
}

export interface AccountTestResult {
  ok: boolean;
  username?: string;
  repoCount?: number;
  message?: string;
}

/** `fetch` shape we depend on, injectable so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const GITHUB_PER_PAGE = 100;
const GITEA_PER_PAGE = 50;

export class GitProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitProviderError';
  }
}

async function request(url: string, init: RequestInit, fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new GitProviderError('请求超时（10 秒）');
    throw new GitProviderError(`网络错误：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new GitProviderError('令牌无效或权限不足', res.status);
  if (res.status === 404) throw new GitProviderError('仓库或用户不存在', res.status);
  if (!res.ok) throw new GitProviderError(`请求失败（HTTP ${res.status}）`, res.status);
  return res;
}

function authHeaders(provider: GitAccount['provider'], token: string | undefined): Record<string, string> {
  if (!token) return {};
  if (provider === 'gitlab') return { 'PRIVATE-TOKEN': token };
  if (provider === 'gitea') return { Authorization: `token ${token}` };
  return { Authorization: `Bearer ${token}` };
}

/** Encode `owner/repo` for a URL path while preserving the separating slash. */
function encodePath(fullName: string): string {
  return fullName.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function mapGitHubRepo(r: Record<string, unknown>): RemoteRepo {
  const full = stringField(r.full_name);
  const name = stringField(r.name, full.split('/').pop() ?? '');
  return {
    id: String(r.id ?? full),
    name,
    fullName: full || name,
    httpsUrl: stringField(r.clone_url),
    sshUrl: stringField(r.ssh_url),
    defaultBranch: stringField(r.default_branch, 'main'),
    private: r.private === true,
  };
}

function mapGitLabRepo(r: Record<string, unknown>): RemoteRepo {
  const full = stringField(r.path_with_namespace);
  const name = stringField(r.name, full.split('/').pop() ?? '');
  return {
    id: String(r.id ?? full),
    name,
    fullName: full || name,
    httpsUrl: stringField(r.http_url_to_repo),
    sshUrl: stringField(r.ssh_url_to_repo),
    defaultBranch: stringField(r.default_branch, 'main'),
    private: r.visibility === 'private',
  };
}

function mapGiteaRepo(r: Record<string, unknown>): RemoteRepo {
  const full = stringField(r.full_name);
  const name = stringField(r.name, full.split('/').pop() ?? '');
  return {
    id: String(r.id ?? full),
    name,
    fullName: full || name,
    httpsUrl: stringField(r.clone_url),
    sshUrl: stringField(r.ssh_url),
    defaultBranch: stringField(r.default_branch, 'main'),
    private: r.private === true,
  };
}

async function listGitHub(account: GitAccount, token: string | undefined, page: number, fetchImpl: FetchLike): Promise<RepoListPage> {
  const url = new URL(`${account.baseUrl}/user/repos`);
  url.searchParams.set('per_page', String(GITHUB_PER_PAGE));
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('page', String(page));
  const res = await request(url.toString(), { headers: authHeaders('github', token) }, fetchImpl);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new GitProviderError('返回数据格式不正确');
  const repos = data.map(mapGitHubRepo);
  const link = res.headers.get('link') ?? '';
  return { repos, hasMore: /rel="next"/.test(link) || repos.length >= GITHUB_PER_PAGE };
}

async function listGitLab(account: GitAccount, token: string | undefined, page: number, fetchImpl: FetchLike): Promise<RepoListPage> {
  const url = new URL(`${account.baseUrl}/api/v4/projects`);
  url.searchParams.set('membership', 'true');
  url.searchParams.set('per_page', String(GITHUB_PER_PAGE));
  url.searchParams.set('page', String(page));
  const res = await request(url.toString(), { headers: authHeaders('gitlab', token) }, fetchImpl);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new GitProviderError('返回数据格式不正确');
  const repos = data.map(mapGitLabRepo);
  const next = res.headers.get('x-next-page') ?? '';
  return { repos, hasMore: Boolean(next) || repos.length >= GITHUB_PER_PAGE };
}

async function listGitea(account: GitAccount, token: string | undefined, page: number, fetchImpl: FetchLike): Promise<RepoListPage> {
  const url = new URL(`${account.baseUrl}/api/v1/user/repos`);
  url.searchParams.set('limit', String(GITEA_PER_PAGE));
  url.searchParams.set('page', String(page));
  const res = await request(url.toString(), { headers: authHeaders('gitea', token) }, fetchImpl);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new GitProviderError('返回数据格式不正确');
  const repos = data.map(mapGiteaRepo);
  return { repos, hasMore: repos.length >= GITEA_PER_PAGE };
}

/** List one page of repositories for an account. Throws GitProviderError. */
export async function listRepos(
  account: GitAccount,
  token: string | undefined,
  opts: { page?: number } = {},
  fetchImpl: FetchLike,
): Promise<RepoListPage> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  switch (account.provider) {
    case 'github':
      return listGitHub(account, token, page, fetchImpl);
    case 'gitlab':
      return listGitLab(account, token, page, fetchImpl);
    case 'gitea':
      return listGitea(account, token, page, fetchImpl);
    default:
      throw new GitProviderError('该平台不支持自动获取仓库列表，请手动填写仓库地址');
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/providers.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git/providers.ts tests/unit/git/providers.test.ts
git commit -m "feat(git): add provider repo listing"
```

---

## Task 5: provider 适配 — 列分支与测试连接

**Files:**
- Modify: `src/git/providers.ts`
- Test: `tests/unit/git/providers.test.ts`

- [ ] **Step 1: 写失败测试**

把 `tests/unit/git/providers.test.ts` 顶部的导入改为：

```ts
import { listBranches, listRepos, testConnection, type FetchLike } from '../../../src/git/providers';
```

然后在文件末尾追加：

```ts
describe('listBranches', () => {
  it('returns branch names for GitHub', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([{ name: 'main' }, { name: 'dev' }]);
    expect(await listBranches(github, 'tok', { fullName: 'acme/api' }, fetchImpl)).toEqual(['main', 'dev']);
  });

  it('returns [] for unsupported providers instead of throwing', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse([]);
    expect(
      await listBranches({ ...github, provider: 'other', baseUrl: '' }, undefined, { fullName: 'x/y' }, fetchImpl),
    ).toEqual([]);
  });
});

describe('testConnection', () => {
  it('reports ok with the repo count and username', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse([{ id: 1, name: 'a', full_name: 'x/a', default_branch: 'main' }]);
    expect(await testConnection({ ...github, username: 'octocat' }, 'tok', fetchImpl)).toEqual({
      ok: true,
      username: 'octocat',
      repoCount: 1,
    });
  });

  it('maps a 403 to a token error result', async () => {
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 403 });
    const result = await testConnection(github, 'tok', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/令牌无效或权限不足/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/git/providers.test.ts -v`
Expected: FAIL（`listBranches`/`testConnection` 未导出：`does not provide an export named`）

- [ ] **Step 3: 实现（追加到 `src/git/providers.ts` 末尾）**

```ts
function branchNames(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((b) => (b && typeof b === 'object' ? (b as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** List branch names. `other`/unsupported providers return an empty list. */
export async function listBranches(
  account: GitAccount,
  token: string | undefined,
  repo: { fullName: string },
  fetchImpl: FetchLike,
): Promise<string[]> {
  switch (account.provider) {
    case 'github': {
      const url = `${account.baseUrl}/repos/${encodePath(repo.fullName)}/branches?per_page=100`;
      const res = await request(url, { headers: authHeaders('github', token) }, fetchImpl);
      return branchNames(await res.json());
    }
    case 'gitlab': {
      const idOrPath = encodeURIComponent(repo.fullName);
      const url = `${account.baseUrl}/api/v4/projects/${idOrPath}/repository/branches?per_page=100`;
      const res = await request(url, { headers: authHeaders('gitlab', token) }, fetchImpl);
      return branchNames(await res.json());
    }
    case 'gitea': {
      const url = `${account.baseUrl}/api/v1/repos/${encodePath(repo.fullName)}/branches?limit=100`;
      const res = await request(url, { headers: authHeaders('gitea', token) }, fetchImpl);
      return branchNames(await res.json());
    }
    default:
      return [];
  }
}

/** Probe an account: returns ok+repoCount, or ok:false with a mapped message. */
export async function testConnection(
  account: GitAccount,
  token: string | undefined,
  fetchImpl: FetchLike,
): Promise<AccountTestResult> {
  try {
    const page = await listRepos(account, token, { page: 1 }, fetchImpl);
    return {
      ok: true,
      ...(account.username ? { username: account.username } : {}),
      repoCount: page.repos.length,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/git/providers.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/git/providers.ts tests/unit/git/providers.test.ts
git commit -m "feat(git): add branch listing and connection test"
```

---

## Task 6: 控制台 REST 逻辑（`src/ui/git-api.ts`）

**Files:**
- Create: `src/ui/git-api.ts`
- Test: `tests/integration/ui/git-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/git/providers';
import { HttpError } from '../../../src/ui/http';
import {
  accountsView,
  branchesView,
  deleteAccount,
  reposView,
  saveAccount,
  testAccount,
} from '../../../src/ui/git-api';

const cleanups: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-gitapi-'));
  cleanups.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('git-api accounts', () => {
  it('creates, lists and removes an account without exposing the token', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    expect(created.accounts).toHaveLength(1);
    expect(created.accounts[0]).toMatchObject({
      label: 'GitHub',
      provider: 'github',
      username: 'octocat',
      hasToken: true,
    });
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    const id = created.accounts[0]!.id;

    const listed = await accountsView(root);
    expect(listed.accounts[0]!.id).toBe(id);
    expect(JSON.stringify(listed)).not.toContain('ghp_secret');

    const removed = await deleteAccount(root, { id });
    expect(removed.accounts).toHaveLength(0);
  });

  it('preserves a stored token when an update omits it', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GH',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const id = created.accounts[0]!.id;
    const updated = await saveAccount(root, {
      id,
      label: 'GH 2',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: '',
    });
    expect(updated.accounts[0]).toMatchObject({ id, label: 'GH 2', hasToken: true });
  });

  it('404s when removing a missing account', async () => {
    const root = await tempRoot();
    await expect(deleteAccount(root, { id: 'gh-missing' })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('git-api provider endpoints', () => {
  it('lists repos and branches and tests the connection with an injected fetch', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    const id = created.accounts[0]!.id;

    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/branches')) return ok([{ name: 'main' }, { name: 'dev' }]);
      return ok([
        {
          id: 1,
          name: 'api',
          full_name: 'acme/api',
          clone_url: 'https://github.com/acme/api.git',
          ssh_url: 'git@github.com:acme/api.git',
          default_branch: 'main',
          private: true,
        },
      ]);
    };

    const repos = await reposView(root, { accountId: id }, fetchImpl);
    expect(repos.repos[0]).toMatchObject({ fullName: 'acme/api', defaultBranch: 'main' });

    const branches = await branchesView(root, { accountId: id, repo: 'acme/api' }, fetchImpl);
    expect(branches.branches).toEqual(['main', 'dev']);

    const tested = await testAccount(
      root,
      { id, provider: 'github', baseUrl: 'https://api.github.com', token: '' },
      fetchImpl,
    );
    expect(tested).toMatchObject({ ok: true, username: 'octocat', repoCount: 1 });
  });

  it('maps provider errors to 400 for repo listing', async () => {
    const root = await tempRoot();
    const created = await saveAccount(root, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 't',
    });
    const id = created.accounts[0]!.id;
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 401 });
    await expect(reposView(root, { accountId: id }, fetchImpl)).rejects.toThrow(/令牌无效或权限不足/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/integration/ui/git-api.test.ts -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
import { resolveAppPaths } from '../config/app-paths';
import {
  GitAccountStore,
  hostStorePaths,
  isProvider,
  normalizeBaseUrl,
  toView,
  type GitAccount,
  type GitAccountView,
  type GitProvider,
} from '../git/accounts';
import {
  GitProviderError,
  listBranches,
  listRepos,
  testConnection,
  type AccountTestResult,
  type FetchLike,
  type RemoteRepo,
} from '../git/providers';
import { HttpError } from './http';

/** Resolve the global fetch lazily so tests can inject a mock instead. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface AccountsView {
  accounts: GitAccountView[];
}

export interface ReposView {
  repos: RemoteRepo[];
  hasMore: boolean;
  page: number;
}

async function loadStore(rootDir?: string): Promise<GitAccountStore> {
  const appPaths = resolveAppPaths({ rootDir });
  const store = new GitAccountStore(appPaths.gitAccountsFile, hostStorePaths(rootDir));
  await store.load();
  return store;
}

async function views(store: GitAccountStore): Promise<GitAccountView[]> {
  const out: GitAccountView[] = [];
  for (const account of store.list()) out.push(toView(account, await store.hasToken(account.id)));
  return out;
}

export async function accountsView(rootDir?: string): Promise<AccountsView> {
  return { accounts: await views(await loadStore(rootDir)) };
}

export async function saveAccount(rootDir: string | undefined, body: unknown): Promise<AccountsView> {
  const store = await loadStore(rootDir);
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const label = typeof raw.label === 'string' ? raw.label : '';
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
  const username = typeof raw.username === 'string' ? raw.username : '';
  const token = typeof raw.token === 'string' ? raw.token : '';
  try {
    await store.upsert({
      ...(id ? { id } : {}),
      label,
      provider: provider as GitProvider,
      baseUrl,
      ...(username ? { username } : {}),
      token,
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  await store.flush();
  return { accounts: await views(store) };
}

export async function deleteAccount(rootDir: string | undefined, body: unknown): Promise<AccountsView> {
  const store = await loadStore(rootDir);
  const raw = body as { id?: unknown };
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) throw new HttpError(400, 'id is required');
  if (!(await store.remove(id))) throw new HttpError(404, `账号不存在：${id}`);
  await store.flush();
  return { accounts: await views(store) };
}

export async function testAccount(
  rootDir: string | undefined,
  body: unknown,
  fetchImpl: FetchLike = defaultFetch,
): Promise<AccountTestResult> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const store = await loadStore(rootDir);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const existing = id ? store.get(id) : undefined;
  const providerRaw = typeof raw.provider === 'string' && raw.provider ? raw.provider : existing?.provider ?? '';
  if (!isProvider(providerRaw)) throw new HttpError(400, '不支持的代码平台');
  const baseUrlRaw =
    typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl : existing?.baseUrl ?? '';
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(providerRaw, baseUrlRaw);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const username = (typeof raw.username === 'string' ? raw.username : existing?.username ?? '').trim();
  const tokenInput = typeof raw.token === 'string' ? raw.token.trim() : '';
  const token = tokenInput || (existing ? (await store.getToken(existing.id)) ?? '' : '');
  const account: GitAccount = {
    id: existing?.id ?? (id || 'test'),
    label: existing?.label ?? 'test',
    provider: providerRaw,
    baseUrl,
    ...(username ? { username } : {}),
    tokenRef: `git-account:${existing?.id ?? (id || 'test')}`,
  };
  return testConnection(account, token || undefined, fetchImpl);
}

export async function reposView(
  rootDir: string | undefined,
  opts: { accountId?: string; query?: string; page?: number },
  fetchImpl: FetchLike = defaultFetch,
): Promise<ReposView> {
  const accountId = opts.accountId?.trim() ?? '';
  if (!accountId) throw new HttpError(400, 'account is required');
  const store = await loadStore(rootDir);
  const account = store.get(accountId);
  if (!account) throw new HttpError(404, `账号不存在：${accountId}`);
  const token = await store.getToken(accountId);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  try {
    const result = await listRepos(account, token, { page }, fetchImpl);
    const query = (opts.query ?? '').trim().toLowerCase();
    const repos = query
      ? result.repos.filter((r) => r.fullName.toLowerCase().includes(query))
      : result.repos;
    return { repos, hasMore: result.hasMore, page };
  } catch (err) {
    if (err instanceof GitProviderError) throw new HttpError(400, err.message);
    throw err;
  }
}

export async function branchesView(
  rootDir: string | undefined,
  opts: { accountId?: string; repo?: string },
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ branches: string[] }> {
  const accountId = opts.accountId?.trim() ?? '';
  const repo = opts.repo?.trim() ?? '';
  if (!accountId) throw new HttpError(400, 'account is required');
  if (!repo) throw new HttpError(400, 'repo is required');
  const store = await loadStore(rootDir);
  const account = store.get(accountId);
  if (!account) throw new HttpError(404, `账号不存在：${accountId}`);
  const token = await store.getToken(accountId);
  try {
    return { branches: await listBranches(account, token, { fullName: repo }, fetchImpl) };
  } catch (err) {
    if (err instanceof GitProviderError) throw new HttpError(400, err.message);
    throw err;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/integration/ui/git-api.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/git-api.ts tests/integration/ui/git-api.test.ts
git commit -m "feat(ui): add git account REST logic"
```

---

## Task 7: server 路由（`DELETE` + `/api/git/*`）

**Files:**
- Modify: `src/ui/types.ts`
- Modify: `src/ui/server.ts`
- Test: `tests/integration/ui/git-routes.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/git/providers';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

let handle: UiServerHandle;
let rootDir: string;
let base: string;

const supervisor: UiSupervisor = {
  isOnline: () => false,
  controlsFor: () => undefined,
  channelFor: () => undefined,
  list: () => [],
  startProfile: async () => {},
  stopProfile: async () => {},
  restartProfile: async () => {},
};

const fetchImpl: FetchLike = async (input) => {
  const url = String(input);
  const body = url.includes('/branches')
    ? [{ name: 'main' }, { name: 'dev' }]
    : [
        {
          id: 1,
          name: 'api',
          full_name: 'acme/api',
          clone_url: 'https://github.com/acme/api.git',
          ssh_url: 'git@github.com:acme/api.git',
          default_branch: 'main',
          private: true,
        },
      ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-gitroute-'));
  handle = await startUiServer({ supervisor, version: 'test', rootDir, fetchImpl });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function get(path: string) {
  return fetch(`${base}${path}`, { headers: { 'x-ui-token': handle.token } });
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': handle.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function del(path: string) {
  return fetch(`${base}${path}`, { method: 'DELETE', headers: { 'x-ui-token': handle.token } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

describe('git routes', { timeout: 30_000 }, () => {
  it('manages accounts and lists repos/branches without leaking tokens', async () => {
    const created = await json(
      await post('/api/git/accounts', {
        label: 'GitHub',
        provider: 'github',
        baseUrl: 'https://api.github.com',
        username: 'octocat',
        token: 'ghp_secret',
      }),
    );
    expect(created.accounts).toHaveLength(1);
    expect(created.accounts[0].hasToken).toBe(true);
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    const id = created.accounts[0].id;

    const listed = await json(await get('/api/git/accounts'));
    expect(JSON.stringify(listed)).not.toContain('ghp_secret');
    expect(listed.accounts[0].id).toBe(id);

    const tested = await json(
      await post('/api/git/accounts/test', {
        id,
        provider: 'github',
        baseUrl: 'https://api.github.com',
        token: '',
      }),
    );
    expect(tested).toMatchObject({ ok: true, repoCount: 1 });

    const repos = await json(await get(`/api/git/repos?account=${id}`));
    expect(repos.repos[0]).toMatchObject({ fullName: 'acme/api' });

    const branches = await json(
      await get(`/api/git/branches?account=${id}&repo=${encodeURIComponent('acme/api')}`),
    );
    expect(branches.branches).toEqual(['main', 'dev']);

    const removed = await json(await del(`/api/git/accounts?id=${id}`));
    expect(removed.accounts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm build:web && pnpm vitest run tests/integration/ui/git-routes.test.ts -v`
Expected: FAIL（`/api/git/accounts` 返回 404，`created.accounts` 为 `undefined`）
（`build:web` 是必需的：`src/ui/server.ts` 导入构建产物 `src/ui/generated/index.html`。）

- [ ] **Step 3: 实现**

先在 `src/ui/types.ts` 顶部加导入，并在 `UiServerDeps` 中新增字段：

```ts
import type { FetchLike } from '../git/providers';
```

```ts
  /** Injectable fetch for git-provider calls (tests pass a mock; defaults to global fetch). */
  fetchImpl?: FetchLike;
```

再在 `src/ui/server.ts` 顶部导入区加：

```ts
import {
  accountsView,
  branchesView,
  deleteAccount,
  reposView,
  saveAccount,
  testAccount,
} from './git-api';
```

在 `route()` 内、`const p = method === 'POST';` 之后加：

```ts
  const d = method === 'DELETE';
```

在 `// --- in-meeting agent (智能体入会) ---` 之前插入：

```ts
  // --- global git accounts & provider repos ---
  if (path === '/api/git/accounts' && g) {
    sendJson(res, 200, await accountsView(deps.rootDir));
    return;
  }
  if (path === '/api/git/accounts' && p) {
    sendJson(res, 200, await saveAccount(deps.rootDir, await readJsonBody(req)));
    return;
  }
  if (path === '/api/git/accounts' && d) {
    const id = url.searchParams.get('id') ?? '';
    sendJson(res, 200, await deleteAccount(deps.rootDir, { id }));
    return;
  }
  if (path === '/api/git/accounts/test' && p) {
    sendJson(res, 200, await testAccount(deps.rootDir, await readJsonBody(req), deps.fetchImpl));
    return;
  }
  if (path === '/api/git/repos' && g) {
    const account = url.searchParams.get('account') ?? undefined;
    const query = url.searchParams.get('query') ?? undefined;
    const page = Number(url.searchParams.get('page') ?? '1') || 1;
    sendJson(
      res,
      200,
      await reposView(
        deps.rootDir,
        { ...(account ? { accountId: account } : {}), ...(query ? { query } : {}), page },
        deps.fetchImpl,
      ),
    );
    return;
  }
  if (path === '/api/git/branches' && g) {
    const account = url.searchParams.get('account') ?? undefined;
    const repo = url.searchParams.get('repo') ?? undefined;
    sendJson(
      res,
      200,
      await branchesView(
        deps.rootDir,
        { ...(account ? { accountId: account } : {}), ...(repo ? { repo } : {}) },
        deps.fetchImpl,
      ),
    );
    return;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm build:web && pnpm vitest run tests/integration/ui/git-routes.test.ts -v`
Expected: PASS

- [ ] **Step 5: 回归既有 server 测试**

Run: `pnpm vitest run tests/integration/ui/workspace-routes.test.ts tests/integration/ui/server.test.ts -v`
Expected: PASS（新增可选 `fetchImpl` 不改变既有行为）

- [ ] **Step 6: 提交**

```bash
git add src/ui/types.ts src/ui/server.ts tests/integration/ui/git-routes.test.ts
git commit -m "feat(ui): register git account and provider routes"
```

---

## Task 8: 把账号环境接入 add/pull（`src/ui/workspace-api.ts`）

**Files:**
- Modify: `src/ui/workspace-api.ts`
- Test: `tests/integration/ui/workspace-git-auth.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../../src/config/profile-store';
import type { GitRunner, GitRunOptions } from '../../../src/git/git-ops';
import { saveAccount } from '../../../src/ui/git-api';
import { addProjects, pullProjects } from '../../../src/ui/workspace-api';
import { ProjectStore } from '../../../src/workspace/projects';

const app = { id: 'cli_test', secret: 's', tenant: 'feishu' as const };
let rootDir: string;
let workspace: string;
const cleanups: string[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-gitauth-'));
  cleanups.push(rootDir);
  workspace = join(rootDir, 'ws');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const root = createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }));
  root.profiles.claude!.workspaces = { default: workspace };
  await saveRootConfig(root, join(rootDir, 'config.json'));
  await writeActiveProfile(rootDir, 'claude');
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Captured = { args: string[]; env?: NodeJS.ProcessEnv };

function runnerFrom(
  handler: (args: string[], opts?: GitRunOptions) => { code: number; stdout?: string; stderr?: string },
): GitRunner {
  return async (args, opts) => {
    const r = handler(args, opts);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('account-scoped git env', () => {
  it('injects the account token into git for project checkout', async () => {
    const { accounts } = await saveAccount(rootDir, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      username: 'octocat',
      token: 'ghp_secret',
    });
    const id = accounts[0]!.id;
    const calls: Captured[] = [];
    const runner = runnerFrom((args, opts) => {
      calls.push({ args, env: opts?.env });
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { code: 128 };
      return { code: 0 };
    });

    await addProjects(
      'claude',
      rootDir,
      { projects: [{ repoUrl: 'https://example.com/acme/api.git', name: 'api', branch: 'main', accountId: id }] },
      runner,
    );

    const clone = calls.find((c) => c.args[0] === 'clone');
    expect(clone).toBeTruthy();
    expect(clone!.env?.LARK_GIT_TOKEN).toBe('ghp_secret');
    expect(clone!.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(clone!.env?.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(String(clone!.env?.GIT_CONFIG_VALUE_0)).toContain('username=octocat');
  });

  it('injects the account token into git for pull', async () => {
    const { accounts } = await saveAccount(rootDir, {
      label: 'GitHub',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 'ghp_secret',
    });
    const id = accounts[0]!.id;
    const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
    const store = new ProjectStore(appPaths.projectsFile);
    await store.load();
    store.add({ repoUrl: 'https://example.com/acme/api.git', name: 'api', accountId: id });
    await store.flush();

    const calls: Captured[] = [];
    const runner = runnerFrom((args, opts) => {
      calls.push({ args, env: opts?.env });
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n' };
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return { code: 0, stdout: 'main\n' };
      if (args[0] === 'rev-list') return { code: 0, stdout: '0\t0\n' };
      if (args[0] === 'status') return { code: 0, stdout: '' };
      if (args[0] === 'pull') return { code: 0, stdout: 'Already up to date.\n' };
      return { code: 0 };
    });

    await pullProjects('claude', rootDir, {}, runner);

    const pull = calls.find((c) => c.args[0] === 'pull');
    expect(pull).toBeTruthy();
    expect(pull!.env?.LARK_GIT_TOKEN).toBe('ghp_secret');
    expect(String(pull!.env?.GIT_CONFIG_VALUE_0)).toContain('password=$LARK_GIT_TOKEN');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/integration/ui/workspace-git-auth.test.ts -v`
Expected: FAIL（`addProjects`/`pullProjects` 不接受第 4 个参数，且未注入 env：`clone.env.LARK_GIT_TOKEN` 为 `undefined`）
（本测试不导入 `src/ui/server.ts`，因此无需 `build:web`。）

- [ ] **Step 3: 实现**

在 `src/ui/workspace-api.ts` 顶部导入区加：

```ts
import { GitAccountStore, hostStorePaths } from '../git/accounts';
import { gitEnvForAccount, withGitEnv } from '../git/auth';
```

并把 `git-ops` 的导入补上 `GitRunner` 类型：

```ts
import {
  createGitRunner,
  ensureCheckout,
  isGitRepo,
  repoStatus,
  pullRepo,
  type GitRunner,
  type RepoStatus,
} from '../git/git-ops';
```

在 `const run = createGitRunner();` 之后加：

```ts
/** Usernames for all accounts (used to build the credential helper). */
async function accountUsernames(rootDir?: string): Promise<Map<string, string | undefined>> {
  const appPaths = resolveAppPaths({ rootDir });
  const store = new GitAccountStore(appPaths.gitAccountsFile, hostStorePaths(rootDir));
  try {
    await store.load();
  } catch (err) {
    // A corrupt/unreadable account file must not block project add/pull. Token
    // injection still works via the keystore; the username falls back to oauth2.
    log.fail('workspace', err, { step: 'load-git-accounts' });
    return new Map();
  }
  const map = new Map<string, string | undefined>();
  for (const account of store.list()) map.set(account.id, account.username);
  return map;
}
```

把 `addProjects` 的签名与 `ensureCheckout` 调用改为：

```ts
export async function addProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
): Promise<ProjectsView> {
  const raw = body as { projects?: unknown };
  const items = Array.isArray(raw?.projects) ? raw.projects : [];
  if (items.length === 0) throw new HttpError(400, 'projects is required');
  const usernames = await accountUsernames(rootDir);

  await withProjectStore(profile, rootDir, async (store, workspaceDir) => {
    await mkdir(workspaceDir, { recursive: true });

    for (const item of items) {
      const input = item as { repoUrl?: unknown; branch?: unknown; name?: unknown; localPath?: unknown; accountId?: unknown };
      const repoUrl = typeof input.repoUrl === 'string' ? input.repoUrl.trim() : '';
      if (!repoUrl) throw new HttpError(400, '仓库地址不能为空');
      const name = (typeof input.name === 'string' && input.name.trim()) || deriveName(repoUrl);
      if (!name) throw new HttpError(400, '项目名不能为空');
      // Default the checkout folder to the project name so the stored localPath
      // and the directory we clone into are always the same value.
      const localPath = (typeof input.localPath === 'string' && input.localPath.trim()) || name;
      const dir = resolveProjectDir(workspaceDir, localPath);
      let entry: ProjectEntry;
      try {
        entry = store.add({
          repoUrl,
          name,
          localPath,
          ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
          ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}),
        });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const env = entry.accountId
        ? await gitEnvForAccount(entry.accountId, hostStorePaths(rootDir), usernames.get(entry.accountId))
        : undefined;
      try {
        await ensureCheckout(runner, {
          repoUrl: entry.repoUrl,
          dir,
          branch: entry.branch,
          ...(env ? { env } : {}),
        });
      } catch (err) {
        store.remove(entry.id);
        await store.flush().catch(() => undefined);
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    await store.flush();
  });
  return projectsView(profile, rootDir);
}
```

把 `pullProjects` 的签名与循环体改为：

```ts
export async function pullProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
): Promise<{ results: PullRunItem[] }> {
  const { appPaths, workspaceDir, store } = await statePaths(profile, rootDir);
  const schedule = store.getSchedule();
  const usernames = await accountUsernames(rootDir);
  const raw = body as { id?: unknown };
  const onlyId = typeof raw?.id === 'string' ? raw.id : undefined;
  const targets = store.list().filter((p) => !onlyId || p.id === onlyId);
  if (onlyId && targets.length === 0) throw new HttpError(404, `项目不存在：${onlyId}`);

  const results: PullRunItem[] = [];
  for (const project of targets) {
    const startedAt = Date.now();
    let result: PullResult;
    let detail: string;
    try {
      const dir = resolveProjectDir(workspaceDir, project.localPath);
      const env = project.accountId
        ? await gitEnvForAccount(project.accountId, hostStorePaths(rootDir), usernames.get(project.accountId))
        : undefined;
      const projectRun = env ? withGitEnv(runner, env) : runner;
      if (!(await isGitRepo(projectRun, dir).catch(() => false))) {
        result = 'failed';
        detail = '目录不存在或不是 git 仓库，请重新添加项目';
      } else {
        const outcome = await pullRepo(projectRun, dir, schedule.strategy);
        result = outcome.status;
        detail = outcome.detail;
      }
    } catch (err) {
      result = 'failed';
      detail = err instanceof Error ? err.message : String(err);
    }
    const entry: PullRunItem = {
      projectId: project.id,
      name: project.name,
      branch: project.branch,
      result,
      detail,
      durationMs: Date.now() - startedAt,
    };
    results.push(entry);
    await appendPullRecord(appPaths.pullHistoryFile, {
      ts: new Date().toISOString(),
      ...entry,
      trigger: 'manual',
    });
  }
  return { results };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/integration/ui/workspace-git-auth.test.ts -v`
Expected: PASS

- [ ] **Step 5: 回归既有工作空间测试**

Run: `pnpm vitest run tests/integration/ui/workspace-api.test.ts tests/unit/workspace/projects.test.ts -v`
Expected: PASS（无账号时行为不变）

- [ ] **Step 6: 提交**

```bash
git add src/ui/workspace-api.ts tests/integration/ui/workspace-git-auth.test.ts
git commit -m "feat(ui): inject account credentials into clone and pull"
```

---

## Task 9: 前端类型与 `apiDelete`

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: 追加类型**

在 `web/src/lib/types.ts` 末尾追加：

```ts
// ── global git accounts & provider repos ─────────────────────────────────────

export type GitProvider = "github" | "gitlab" | "gitea" | "other";

export interface GitAccount {
  id: string;
  label: string;
  provider: GitProvider;
  baseUrl: string;
  username?: string;
  /** True when a token is stored; the token itself is never returned. */
  hasToken: boolean;
}

export interface AccountsView {
  accounts: GitAccount[];
}

export interface RemoteRepo {
  id: string;
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface ReposView {
  repos: RemoteRepo[];
  hasMore: boolean;
  page: number;
}

export interface AccountTestResult {
  ok: boolean;
  username?: string;
  repoCount?: number;
  message?: string;
}
```

- [ ] **Step 2: 追加 `apiDelete`**

在 `web/src/lib/api.ts` 末尾追加：

```ts
export const apiDelete = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 4: 提交**

```bash
git add web/src/lib/types.ts web/src/lib/api.ts
git commit -m "feat(web): add git account types and apiDelete"
```

---

## Task 10: 「Git 账号」卡片与弹框（`web/src/components/GitAccountCard.tsx`）

**Files:**
- Create: `web/src/components/GitAccountCard.tsx`

- [ ] **Step 1: 实现组件（完整文件）**

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import type { AccountTestResult, AccountsView, GitAccount, GitProvider } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";

export const PROVIDER_OPTIONS: { value: GitProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitea", label: "Gitea" },
  { value: "other", label: "其他（仅手动地址）" },
];

export function providerLabel(provider: GitProvider): string {
  return PROVIDER_OPTIONS.find((p) => p.value === provider)?.label ?? provider;
}

export function GitAccountCard({ onChanged }: { onChanged?: (accounts: GitAccount[]) => void }) {
  const [accounts, setAccounts] = useState<GitAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GitAccount | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const apply = useCallback(
    (next: GitAccount[]) => {
      setAccounts(next);
      onChanged?.(next);
    },
    [onChanged],
  );

  const load = useCallback(
    () =>
      apiGet<AccountsView>("/api/git/accounts")
        .then((v) => {
          apply(v.accounts);
          setError(null);
        })
        .catch((e) => setError(String((e as Error).message ?? e))),
    [apply],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    setBusy(true);
    try {
      const v = await apiDelete<AccountsView>(`/api/git/accounts?id=${encodeURIComponent(id)}`);
      apply(v.accounts);
      toast.success("已移除账号");
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Git 账号（{accounts.length}）</CardTitle>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          + 添加账号
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          账号全局共享（机器级），令牌只存本机加密库，不会回显；私有仓库拉取时自动注入。
        </p>
        {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
        {accounts.length === 0 && <p className="text-sm text-muted-foreground">还没有账号。</p>}
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 truncate text-sm font-medium">
                <span className="truncate">{a.label}</span>
                <Badge variant="outline">{providerLabel(a.provider)}</Badge>
                {a.hasToken ? (
                  <Badge variant="success">已保存令牌</Badge>
                ) : (
                  <Badge variant="secondary">无令牌</Badge>
                )}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {a.baseUrl || "—"}
                {a.username ? ` · ${a.username}` : ""}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(a);
                setDialogOpen(true);
              }}
            >
              编辑
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(a.id)}>
              移除
            </Button>
          </div>
        ))}
      </CardContent>
      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        onSaved={(v) => {
          apply(v.accounts);
          setDialogOpen(false);
        }}
      />
    </Card>
  );
}

function AccountDialog({
  open,
  onOpenChange,
  account,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: GitAccount | null;
  onSaved: (v: AccountsView) => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<GitProvider>("github");
  const [baseUrl, setBaseUrl] = useState("https://api.github.com");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<AccountTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(account?.label ?? "");
    setProvider(account?.provider ?? "github");
    setBaseUrl(account?.baseUrl ?? "https://api.github.com");
    setUsername(account?.username ?? "");
    setToken("");
    setTest(null);
  }, [open, account]);

  function onProviderChange(next: GitProvider) {
    setProvider(next);
    setTest(null);
    if (!account) {
      setBaseUrl(
        next === "github"
          ? "https://api.github.com"
          : next === "gitlab"
            ? "https://gitlab.com"
            : next === "gitea"
              ? "https://gitea.com"
              : "",
      );
    }
  }

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await apiPost<AccountTestResult>("/api/git/accounts/test", {
        ...(account ? { id: account.id } : {}),
        provider,
        baseUrl,
        username,
        token,
      });
      setTest(r);
    } catch (e) {
      setTest({ ok: false, message: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const v = await apiPost<AccountsView>("/api/git/accounts", {
        ...(account ? { id: account.id } : {}),
        label,
        provider,
        baseUrl,
        username,
        token,
      });
      toast.success(account ? "已更新账号" : "已添加账号");
      onSaved(v);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = label.trim().length > 0 && (provider === "other" || baseUrl.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? "编辑 Git 账号" : "添加 Git 账号"}</DialogTitle>
          <DialogDescription>
            PAT 只存本机加密库，保存后不再回显；留空表示不修改已保存的令牌。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>平台</Label>
            <Select value={provider} onValueChange={(v) => onProviderChange(v as GitProvider)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>账号名称</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：GitHub 工作号" />
          </div>
          <div className="space-y-1.5">
            <Label>服务地址</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={provider === "github" ? "https://api.github.com" : "https://gitlab.example.com"}
            />
          </div>
          <div className="space-y-1.5">
            <Label>用户名（可选）</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="仅用于展示与凭证提示" />
          </div>
          <div className="space-y-1.5">
            <Label>访问令牌（PAT）{account ? "（留空不改）" : ""}</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… / glpat-…"
              autoComplete="new-password"
            />
          </div>
          {test && (
            <p className={test.ok ? "text-sm text-success" : "text-sm text-destructive"}>
              {test.ok
                ? `连接成功${test.username ? `（${test.username}）` : ""}${
                    test.repoCount !== undefined ? `，可见 ${test.repoCount} 个仓库` : ""
                  }`
                : `连接失败：${test.message ?? "未知错误"}`}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={runTest}>
            测试连接
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !canSave} onClick={save}>
            {account ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 3: 提交**

```bash
git add web/src/components/GitAccountCard.tsx
git commit -m "feat(web): add git account card and dialog"
```

---

## Task 11: 添加项目弹框（从账号选择 / 手动输入地址）+ 挂载

**Files:**
- Create: `web/src/components/AddProjectDialog.tsx`
- Modify: `web/src/views/WorkspaceView.tsx`

- [ ] **Step 1: 实现添加项目弹框（完整文件）**

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { GitAccount, RemoteRepo, ReposView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { providerLabel } from "@/components/GitAccountCard";

export interface AddProjectItem {
  repoUrl: string;
  branch: string;
  name?: string;
  accountId?: string;
}

export function AddProjectDialog({
  open,
  onOpenChange,
  accounts,
  busy,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: GitAccount[];
  busy: boolean;
  onAdd: (items: AddProjectItem[]) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string[]>>({});

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [manualAccountId, setManualAccountId] = useState("");

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setRepos([]);
    setReposError(null);
    setSelected({});
    setBranches({});
    setRepoUrl("");
    setBranch("main");
    setManualAccountId("");
  }, [open, accounts]);

  const loadRepos = useCallback(async (id: string) => {
    if (!id) return;
    setReposLoading(true);
    setReposError(null);
    try {
      const v = await apiGet<ReposView>(`/api/git/repos?account=${encodeURIComponent(id)}`);
      setRepos(v.repos);
    } catch (e) {
      setReposError(String((e as Error).message ?? e));
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && accountId) void loadRepos(accountId);
  }, [open, accountId, loadRepos]);

  async function loadBranches(repo: RemoteRepo) {
    if (branches[repo.id]) return;
    try {
      const v = await apiGet<{ branches: string[] }>(
        `/api/git/branches?account=${encodeURIComponent(accountId)}&repo=${encodeURIComponent(repo.fullName)}`,
      );
      setBranches((prev) => ({ ...prev, [repo.id]: v.branches }));
    } catch {
      setBranches((prev) => ({ ...prev, [repo.id]: [] }));
    }
  }

  function toggle(repo: RemoteRepo) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[repo.id] !== undefined) {
        delete next[repo.id];
      } else {
        next[repo.id] = repo.defaultBranch || "main";
        void loadBranches(repo);
      }
      return next;
    });
  }

  function addFromAccount() {
    const items: AddProjectItem[] = [];
    for (const repo of repos) {
      const b = selected[repo.id];
      if (b === undefined) continue;
      items.push({
        repoUrl: repo.httpsUrl || repo.sshUrl,
        branch: b || repo.defaultBranch || "main",
        name: repo.name,
        accountId,
      });
    }
    if (items.length === 0) {
      toast.error("请先勾选仓库");
      return;
    }
    onAdd(items);
  }

  function addManual() {
    if (!repoUrl.trim()) {
      toast.error("请填写仓库地址");
      return;
    }
    onAdd([
      {
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || "main",
        ...(manualAccountId ? { accountId: manualAccountId } : {}),
      },
    ]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>从已保存的 Git 账号选择仓库，或手动填写仓库地址。</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="account">
          <TabsList>
            <TabsTrigger value="account">从账号选择</TabsTrigger>
            <TabsTrigger value="manual">手动输入地址</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="space-y-3">
            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                还没有 Git 账号，请先在「Git 账号」卡片添加，或切到「手动输入地址」。
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>账号</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择账号" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label}（{providerLabel(a.provider)}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {reposLoading && <p className="text-sm text-muted-foreground">正在获取仓库…</p>}
                {reposError && <p className="text-sm text-destructive">{reposError}</p>}
                {!reposLoading && !reposError && repos.length === 0 && (
                  <p className="text-sm text-muted-foreground">该账号没有可见仓库。</p>
                )}
                <div className="max-h-[40vh] divide-y overflow-y-auto rounded-md border">
                  {repos.map((repo) => {
                    const checked = selected[repo.id] !== undefined;
                    const current = selected[repo.id] ?? repo.defaultBranch ?? "main";
                    const options = branches[repo.id] ?? [];
                    return (
                      <div key={repo.id} className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer"
                          checked={checked}
                          onChange={() => toggle(repo)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 truncate text-sm font-medium">
                            <span className="truncate">{repo.fullName}</span>
                            {repo.private && <Badge variant="secondary">私有</Badge>}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {repo.httpsUrl || repo.sshUrl}
                          </div>
                        </div>
                        {checked &&
                          (options.length > 0 ? (
                            <Select
                              value={current}
                              onValueChange={(v) => setSelected((p) => ({ ...p, [repo.id]: v }))}
                            >
                              <SelectTrigger className="w-[150px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {!options.includes(current) && <SelectItem value={current}>{current}</SelectItem>}
                                {options.map((b) => (
                                  <SelectItem key={b} value={b}>
                                    {b}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              className="h-8 w-[150px]"
                              value={current}
                              onChange={(e) => setSelected((p) => ({ ...p, [repo.id]: e.target.value }))}
                              placeholder="分支"
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
                <DialogFooter>
                  <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button
                    disabled={busy || Object.keys(selected).length === 0}
                    onClick={addFromAccount}
                  >
                    添加选中（{Object.keys(selected).length}）
                  </Button>
                </DialogFooter>
              </>
            )}
          </TabsContent>

          <TabsContent value="manual" className="space-y-3">
            <div className="space-y-1.5">
              <Label>仓库地址</Label>
              <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://… 或 git@…" />
            </div>
            <div className="space-y-1.5">
              <Label>分支</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </div>
            {accounts.length > 0 && (
              <div className="space-y-1.5">
                <Label>账号（可选，私有仓库拉取用）</Label>
                <Select
                  value={manualAccountId || "none"}
                  onValueChange={(v) => setManualAccountId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不使用账号</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button disabled={busy || !repoUrl.trim()} onClick={addManual}>
                添加
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 重写 `web/src/views/WorkspaceView.tsx`（完整文件）**

```tsx
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AccountsView, DirListing, GitAccount, ProjectView, ProjectsView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { GitAccountCard } from "@/components/GitAccountCard";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import type { AddProjectItem } from "@/components/AddProjectDialog";

export function WorkspaceView({ profile }: { profile: string }) {
  const q = `profile=${encodeURIComponent(profile)}`;
  const [view, setView] = useState<ProjectsView | null>(null);
  const [accounts, setAccounts] = useState<GitAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([
        apiGet<ProjectsView>(`/api/projects?${q}`),
        apiGet<AccountsView>("/api/git/accounts"),
      ])
        .then(([v, a]) => {
          setView(v);
          setAccounts(a.accounts);
          setError(null);
        })
        .catch((e) => setError(String((e as Error).message ?? e))),
    [q],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function setRoot(path: string) {
    setBusy(true);
    try {
      await apiPost(`/api/workspace/root?${q}`, { path });
      toast.success("已设置工作空间目录");
      setPickerOpen(false);
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function pull(id?: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/pull?${q}`, id ? { id } : {});
      toast.success("已拉取");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await apiPost(`/api/projects/remove?${q}`, { id });
      toast.success("已移除（未删除磁盘目录）");
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function setBranch(id: string, branch: string) {
    try {
      await apiPost(`/api/projects/branch?${q}`, { id, branch });
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    }
  }

  async function addItems(items: AddProjectItem[]) {
    setBusy(true);
    try {
      await apiPost(`/api/projects?${q}`, { projects: items });
      toast.success("已添加并检出");
      setAddOpen(false);
      await load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-destructive text-sm">加载失败：{error}</p>;
  if (!view) return <p className="text-muted-foreground text-sm">加载中…</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>工作空间目录</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
            更换目录…
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
            {view.workspaceDir ?? "（未设置）"}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            项目仓库默认克隆到该目录下；默认值来自启动参数 <code>--workspace</code>，可修改。
          </p>
        </CardContent>
      </Card>

      <GitAccountCard onChanged={setAccounts} />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>项目（{view.projects.length}）</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => pull()}>
              全部拉取
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              + 添加项目
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {view.projects.length === 0 && (
            <p className="text-sm text-muted-foreground">还没有项目，点「添加项目」填入仓库地址。</p>
          )}
          {view.projects.map((p) => (
            <ProjectRow key={p.id} project={p} busy={busy} onPull={pull} onRemove={remove} onBranch={setBranch} />
          ))}
        </CardContent>
      </Card>

      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} busy={busy} onPick={setRoot} />
      <AddProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accounts={accounts}
        busy={busy}
        onAdd={addItems}
      />
    </div>
  );
}

function statusBadge(p: ProjectView) {
  if (!p.exists) return <Badge variant="destructive">未检出</Badge>;
  if (p.status.dirty) return <Badge variant="secondary">有本地改动</Badge>;
  if (p.status.behind > 0) return <Badge variant="secondary">落后 {p.status.behind}</Badge>;
  return <Badge variant="success">已最新</Badge>;
}

function ProjectRow({
  project,
  busy,
  onPull,
  onRemove,
  onBranch,
}: {
  project: ProjectView;
  busy: boolean;
  onPull: (id: string) => void;
  onRemove: (id: string) => void;
  onBranch: (id: string, branch: string) => void;
}) {
  const [branch, setBranch] = useState(project.branch);
  useEffect(() => {
    setBranch(project.branch);
  }, [project.branch]);
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {project.name} {statusBadge(project)}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{project.repoUrl}</div>
      </div>
      <Input
        className="h-8 w-[130px]"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onBlur={() => {
          if (branch.trim() && branch !== project.branch) onBranch(project.id, branch.trim());
        }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onPull(project.id)}>
        拉取
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRemove(project.id)}>
        移除
      </Button>
    </div>
  );
}

function DirectoryPicker({
  open,
  onOpenChange,
  busy,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback((path?: string) => {
    setError(null);
    apiGet<DirListing>(`/api/workspace/dir${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then(setListing)
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, []);

  useEffect(() => {
    if (open) browse();
  }, [open, browse]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription>从本机磁盘选择工作空间根目录。</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {listing && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Button
                variant="outline"
                size="sm"
                onClick={() => listing.parent && browse(listing.parent)}
                disabled={!listing.parent}
              >
                ↑ 上一级
              </Button>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {listing.path || "此电脑"}
              </span>
            </div>
            <div className="max-h-[46vh] divide-y overflow-y-auto rounded-md border">
              {(listing.roots ?? listing.dirs).map((d) => (
                <button
                  key={d.path}
                  className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => browse(d.path)}
                >
                  📁 {d.name}
                </button>
              ))}
              {(listing.roots ?? listing.dirs).length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">（没有子目录）</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              已选：<span className="font-mono">{listing.path || "—"}</span>
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => listing?.path && onPick(listing.path)} disabled={busy || !listing?.path}>
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit -p web/tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 4: 构建前端确认可打包**

Run: `pnpm build:web`
Expected: PASS（Vite 产出 `src/ui/generated/index.html`）

- [ ] **Step 5: 提交**

```bash
git add web/src/components/AddProjectDialog.tsx web/src/views/WorkspaceView.tsx
git commit -m "feat(web): add account-based project picker and git account card"
```

---

## Task 12: README 数据目录与全量校验

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: README.md 数据目录表新增主机级行**

在 `README.md` 的「Data directories」表中、`~/.lark-channel/active-profile` 一行之后插入：

```markdown
| `~/.lark-channel/git-accounts.json` | Global Git accounts (tokens live in the host keystore) |
| `~/.lark-channel/secrets.enc` | Host-level encrypted secrets (Git account tokens) |
| `~/.lark-channel/.keystore.salt` | Host keystore salt |
```

- [ ] **Step 2: README.zh.md 数据目录表新增主机级行**

在 `README.zh.md` 的「数据目录」表中、`~/.lark-channel/active-profile` 一行之后插入：

```markdown
| `~/.lark-channel/git-accounts.json` | 全局 Git 账号（令牌存主机级加密库） |
| `~/.lark-channel/secrets.enc` | 主机级加密密钥（Git 账号令牌） |
| `~/.lark-channel/.keystore.salt` | 主机级密钥盐值 |
```

- [ ] **Step 3: 全量校验**

Run: `pnpm build:web && pnpm vitest run --no-file-parallelism && pnpm typecheck && pnpm build`
Expected: 全部通过（不要用并行 `vitest run`：本机 Windows 上并行模式会让 `tests/integration/commands/profile-config-command.test.ts` 因 `writeFileAtomic` 的 `rename EPERM` 偶发失败；`tests/integration/cli/start-codex-legacy-config.test.ts` 有 3 个与本改动无关的已知环境失败，可在具备 `sh`/codex 的环境复验）。

- [ ] **Step 4: 回归 README 契约测试**

Run: `pnpm vitest run tests/unit/docs/readme-contract.test.ts -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add README.md README.zh.md
git commit -m "docs: document host-level git account storage"
```

---

## Self-Review

**Spec coverage（P2 §13 item 2 = 全局 Git 账号 + 仓库列表 + 从账号添加 + token 注入拉取）：**

- §4.1 `git-accounts.json`（0600）+ 主机级 keystore（键 `git-account:<id>`）→ Task 1、Task 2。
- §4.1 列表/详情永不返回 token，只返回 `hasToken` → Task 2 `toView`、Task 6 `accountsView`/`saveAccount`、Task 7 路由测试断言 `not.toContain('ghp_secret')`。
- §5.1 provider 表格（github Link / gitlab `x-next-page`、`PRIVATE-TOKEN` / gitea `page`、`token` / other 不支持）→ Task 4。
- §5.1 分支列表 + 失败降级手动输入 → Task 5 `listBranches`、Task 11 分支 Select 空则回退 Input。
- §5.1 统一 10s 超时、401/403 映射 → Task 4 `request`/`GitProviderError`、Task 5 `testConnection`。
- §5.2 / §11 token 经环境变量 + `GIT_CONFIG_*` 注入、不出现在命令行 → Task 3、Task 8。
- §6.2 从账号添加（列仓库→勾选+选分支→批量）与手动添加（地址+分支+可选账号）→ Task 11、Task 6 `/api/git/repos`、`/api/git/branches`。
- §8 `/api/git/*` 路由（含 `DELETE /api/git/accounts?id=`）→ Task 7。
- §9 控制台「Git 账号」卡片 + `AccountDialog`（平台/地址/用户名/PAT/测试连接）、`AddProjectDialog` 两 Tab、复用 shadcn、无新依赖 → Task 9/10/11。
- §15 验收 2（账号 PAT + 测试连接 + 不回显）与 3（从账号/手动添加 + 选分支）→ Task 7/8/10/11。
- §14 单元（账号 store、provider mock fetch、auth env）+ 集成（`/api/git/*`、账号环境到 git）→ Task 2/3/4/5/6/7/8。

**未映射的规格项（均为 P3 或后续，本计划明确排除）：** 定时任务 §7/§13.3、执行记录 UI §8/§9、`/config` 卡片 §10.1、斜杠命令 §10.2、失败通知 §7/§12、§15 验收 5/6/7 中与定时/记录/卡片相关的部分。这些不属于 P2 范围，已在头部「明确不做」中标注，另有 P3 计划承接。

**Placeholder scan：** 所有代码步骤均给出可直接落盘的完整代码；无 “TBD/TODO/类似 Task N/补充错误处理” 之类的占位。新增测试均为可运行代码。

**Type consistency：** 后端 `GitProvider`/`GitAccount`/`GitAccountView`（Task 2）、`RemoteRepo`/`RepoListPage`/`AccountTestResult`/`FetchLike`/`GitProviderError`（Task 4/5）、`AccountsView`/`ReposView`（Task 6）前后一致；前端 `GitProvider`/`GitAccount`/`AccountsView`/`RemoteRepo`/`ReposView`/`AccountTestResult`（Task 9）与 `GitAccountCard`/`AddProjectDialog`（Task 10/11）一致。函数名统一：`gitEnvForAccount`、`withGitEnv`、`listRepos`、`listBranches`、`testConnection`、`accountsView`、`saveAccount`、`deleteAccount`、`testAccount`、`reposView`、`branchesView`、`hostStorePaths`、`tokenRefFor`、`toView`、`isProvider`、`normalizeBaseUrl`。`addProjects`/`pullProjects` 新增可选第 4 参 `runner: GitRunner = run`，既有调用方（server 路由）不受影响。

**安全复核：** token 仅存在于 `secrets.enc`（主机级）与进程环境变量 `LARK_GIT_TOKEN`；不进 `git-accounts.json`、不进 `GIT_CONFIG_VALUE_0`、不进任何 HTTP 响应/日志；`GitAccountView` 用 `hasToken` 替代 token；`reposView`/`branchesView`/`testAccount` 均不返回 token。

---

## Execution

P2 完成后应满足：控制台「工作空间」页可添加/编辑/移除全局 Git 账号并「测试连接」（token 不回显）；「添加项目」弹框的「从账号选择」可拉取仓库列表、逐仓库选分支并批量添加，「手动输入地址」可带可选账号；添加/拉取私有仓库时 token 经环境变量 + `credential.helper` 注入，命令行不含 token。`pnpm build:web && pnpm vitest run --no-file-parallelism && pnpm typecheck && pnpm build` 全绿（见 Task 12 Step 3 关于并行模式与本机 3 个已知环境失败的说明）。

建议执行方式（二选一，见本计划头部）：**Subagent-Driven**（每个 Task 由独立 subagent 实现、任务间评审）或 **Inline Execution**（本会话按 executing-plans 分批执行）。P3（定时任务、执行记录、`/config` 卡片、斜杠命令、失败通知）另立计划。
