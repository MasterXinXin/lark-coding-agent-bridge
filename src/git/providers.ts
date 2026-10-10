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
