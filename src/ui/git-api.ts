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
