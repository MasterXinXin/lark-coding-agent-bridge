import { mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { saveWorkspaceConfig, type MutableProfileState } from '../config/config-ops';
import { withConfigFileLock } from '../config/profile-store';
import { log } from '../core/logger';
import { GitAccountStore, hostStorePaths } from '../git/accounts';
import { gitEnvForAccount, withGitEnv } from '../git/auth';
import {
  createGitRunner,
  ensureCheckout,
  isGitRepo,
  repoStatus,
  pullRepo,
  type GitRunner,
  type RepoStatus,
} from '../git/git-ops';
import { appendPullRecord, readPullRecords, type PullResult } from '../workspace/history';
import { browseDirectory } from '../workspace/dir-browse';
import { ProjectStore, type ProjectEntry, type PullSchedule } from '../workspace/projects';
import { HttpError } from './http';
import { loadProfileState } from './api';

const run = createGitRunner();

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

const ZERO_STATUS: RepoStatus = { branch: undefined, dirty: false, ahead: 0, behind: 0, hasUpstream: false };

export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  accountId?: string;
  absolutePath: string;
  exists: boolean;
  status: RepoStatus;
  lastPullAt?: string;
}

export interface ProjectsView {
  workspaceDir?: string;
  projects: ProjectView[];
  schedule: PullSchedule;
}

/** Outcome of a project removal, mirroring whether the checkout was deleted. */
export interface RemovedResult {
  id: string;
  dir?: string;
  deleted: boolean;
  warning?: string;
}

export interface PullRunItem {
  projectId: string;
  name: string;
  branch: string;
  result: PullResult;
  detail: string;
  durationMs: number;
}

async function statePaths(profile: string, rootDir?: string) {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const state = await loadProfileState(profile, rootDir);
  const workspaceDir = state.profileConfig.workspaces.default ?? appPaths.defaultWorkspaceDir;
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  return { appPaths, state, workspaceDir, store };
}

/**
 * Serialize project-list mutations for a profile behind the projects-file lock
 * so concurrent console requests can't lose updates, then hand the freshly
 * loaded store to `fn`.
 */
async function withProjectStore<T>(
  profile: string,
  rootDir: string | undefined,
  fn: (store: ProjectStore, workspaceDir: string) => Promise<T>,
): Promise<T> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const state = await loadProfileState(profile, rootDir);
  const workspaceDir = state.profileConfig.workspaces.default ?? appPaths.defaultWorkspaceDir;
  return withConfigFileLock(appPaths.projectsFile, async () => {
    const store = new ProjectStore(appPaths.projectsFile);
    await store.load();
    return fn(store, workspaceDir);
  });
}

/** Resolve a project's checkout path and refuse one that escapes the workspace. */
export function resolveProjectDir(workspaceDir: string, localPath: string): string {
  const abs = isAbsolute(localPath) ? resolve(localPath) : resolve(workspaceDir, localPath);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new HttpError(400, `项目目录必须位于工作空间内：${localPath}`);
  }
  return abs;
}

export async function projectsView(profile: string, rootDir?: string): Promise<ProjectsView> {
  const { appPaths, workspaceDir, store } = await statePaths(profile, rootDir);
  const history = await readPullRecords(appPaths.pullHistoryFile, 200);
  const lastByProject = new Map<string, string>();
  for (const rec of history) {
    if (!lastByProject.has(rec.projectId)) lastByProject.set(rec.projectId, rec.ts);
  }

  const projects: ProjectView[] = [];
  for (const project of store.list()) {
    let absolutePath = '';
    let exists = false;
    let status: RepoStatus = ZERO_STATUS;
    try {
      absolutePath = resolveProjectDir(workspaceDir, project.localPath);
      exists = await isGitRepo(run, absolutePath).catch(() => false);
      if (exists) status = await repoStatus(run, absolutePath).catch(() => ZERO_STATUS);
    } catch {
      // Stored path no longer lies within the workspace (e.g. the workspace
      // root was changed). Surface it as missing instead of failing the view.
    }
    projects.push({
      ...project,
      absolutePath,
      exists,
      status,
      ...(lastByProject.get(project.id) ? { lastPullAt: lastByProject.get(project.id)! } : {}),
    });
  }
  return { ...(workspaceDir ? { workspaceDir } : {}), projects, schedule: store.getSchedule() };
}

export async function addProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
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
      onStep?.({ id: entry.id, name: entry.name });
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

export async function removeProject(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView & { removed: RemovedResult }> {
  const id = readId(body);
  const deleteDir = (body as { deleteDir?: unknown })?.deleteDir === true;
  const removed = await withProjectStore(profile, rootDir, async (store, workspaceDir) => {
    const entry = store.get(id);
    if (!entry) throw new HttpError(404, `项目不存在：${id}`);
    // Delete the checkout first so a failure keeps the record for a retry.
    const result = deleteDir ? await deleteProjectDir(workspaceDir, entry) : { id, deleted: false };
    store.remove(id);
    await store.flush();
    return result;
  });
  return { ...(await projectsView(profile, rootDir)), removed };
}

/**
 * Recursively delete a project's checkout. Refuses paths that resolve outside
 * the workspace or that equal the workspace root itself; a missing directory is
 * treated as already deleted. A real failure throws so the caller keeps the
 * record.
 */
async function deleteProjectDir(workspaceDir: string, entry: ProjectEntry): Promise<RemovedResult> {
  let dir: string;
  try {
    dir = resolveProjectDir(workspaceDir, entry.localPath);
  } catch {
    return { id: entry.id, deleted: false, warning: '项目目录位于工作空间之外，已保留未删除' };
  }
  if (dir === resolve(workspaceDir)) {
    return { id: entry.id, dir, deleted: false, warning: '项目目录与工作空间根目录相同，已保留未删除' };
  }
  const info = await stat(dir).catch(() => undefined);
  if (!info) return { id: entry.id, dir, deleted: true };
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `删除目录失败：${message}`);
  }
  return { id: entry.id, dir, deleted: true };
}

export async function updateProjectBranch(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const raw = body as { branch?: unknown };
  const branch = typeof raw?.branch === 'string' ? raw.branch : '';
  const id = readId(body);
  await withProjectStore(profile, rootDir, async (store) => {
    try {
      store.updateBranch(id, branch);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    await store.flush();
  });
  return projectsView(profile, rootDir);
}

export async function setWorkspaceDir(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  liveState?: MutableProfileState,
): Promise<ProjectsView> {
  const raw = body as { path?: unknown };
  const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
  if (!path) throw new HttpError(400, 'path is required');
  const state = liveState ?? (await loadProfileState(profile, rootDir));
  const listing = await browseDirectory(path).catch(() => undefined);
  if (!listing) throw new HttpError(400, `目录不存在或不可访问：${path}`);
  try {
    await saveWorkspaceConfig(state, listing.path);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  return projectsView(profile, rootDir);
}

export async function pullProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
  runner: GitRunner = run,
  onStep?: (info: { id: string; name: string }) => void,
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
    onStep?.({ id: project.id, name: project.name });
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

export async function getSchedule(profile: string, rootDir?: string): Promise<PullSchedule> {
  const { store } = await statePaths(profile, rootDir);
  return store.getSchedule();
}

export async function setSchedule(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<PullSchedule> {
  const raw = (body && typeof body === 'object' ? body : {}) as Partial<PullSchedule>;
  return withProjectStore(profile, rootDir, async (store) => {
    const next = store.setSchedule(raw);
    await store.flush();
    return next;
  });
}

function readId(body: unknown): string {
  const raw = body as { id?: unknown };
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) throw new HttpError(400, 'id is required');
  return id;
}

function deriveName(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
}
