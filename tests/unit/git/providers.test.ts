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
