import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { saveWorkspaceConfig } from '../config/config-ops';
import {
  createGitRunner,
  ensureCheckout,
  isGitRepo,
  repoStatus,
  pullRepo,
  type RepoStatus,
} from '../git/git-ops';
import { appendPullRecord, readPullRecords, type PullResult } from '../workspace/history';
import { browseDirectory } from '../workspace/dir-browse';
import { ProjectStore, type ProjectEntry, type PullSchedule } from '../workspace/projects';
import { HttpError } from './http';
import { loadProfileState } from './api';

const run = createGitRunner();

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

/** Resolve a project's checkout path and refuse one that escapes the workspace. */
export function resolveProjectDir(workspaceDir: string, localPath: string): string {
  const abs = isAbsolute(localPath) ? resolve(localPath) : resolve(workspaceDir, localPath);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
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
    const absolutePath = resolveProjectDir(workspaceDir, project.localPath);
    const exists = await isGitRepo(run, absolutePath).catch(() => false);
    const status: RepoStatus = exists
      ? await repoStatus(run, absolutePath).catch(() => ({ branch: undefined, dirty: false, ahead: 0, behind: 0, hasUpstream: false }))
      : { branch: undefined, dirty: false, ahead: 0, behind: 0, hasUpstream: false };
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
): Promise<ProjectsView> {
  const { workspaceDir, store } = await statePaths(profile, rootDir);
  const raw = body as { projects?: unknown };
  const items = Array.isArray(raw?.projects) ? raw.projects : [];
  if (items.length === 0) throw new HttpError(400, 'projects is required');
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
    try {
      await ensureCheckout(run, { repoUrl: entry.repoUrl, dir, branch: entry.branch });
    } catch (err) {
      store.remove(entry.id);
      await store.flush();
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function removeProject(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const { store } = await statePaths(profile, rootDir);
  const id = readId(body);
  if (!store.remove(id)) throw new HttpError(404, `项目不存在：${id}`);
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function updateProjectBranch(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const { store } = await statePaths(profile, rootDir);
  const raw = body as { branch?: unknown };
  const branch = typeof raw?.branch === 'string' ? raw.branch : '';
  try {
    store.updateBranch(readId(body), branch);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  await store.flush();
  return projectsView(profile, rootDir);
}

export async function setWorkspaceDir(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<ProjectsView> {
  const raw = body as { path?: unknown };
  const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
  if (!path) throw new HttpError(400, 'path is required');
  const { state } = await statePaths(profile, rootDir);
  const listing = await browseDirectory(path).catch(() => undefined);
  if (!listing) throw new HttpError(400, `目录不存在或不可访问：${path}`);
  await saveWorkspaceConfig(state, listing.path);
  return projectsView(profile, rootDir);
}

export async function pullProjects(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<{ results: PullRunItem[] }> {
  const { appPaths, workspaceDir, store } = await statePaths(profile, rootDir);
  const schedule = store.getSchedule();
  const raw = body as { id?: unknown };
  const onlyId = typeof raw?.id === 'string' ? raw.id : undefined;
  const targets = store.list().filter((p) => !onlyId || p.id === onlyId);
  if (onlyId && targets.length === 0) throw new HttpError(404, `项目不存在：${onlyId}`);

  const results: PullRunItem[] = [];
  for (const project of targets) {
    const dir = resolveProjectDir(workspaceDir, project.localPath);
    const startedAt = Date.now();
    let result: PullResult;
    let detail: string;
    if (!(await isGitRepo(run, dir).catch(() => false))) {
      result = 'failed';
      detail = '目录不存在或不是 git 仓库，请重新添加项目';
    } else {
      const outcome = await pullRepo(run, dir, schedule.strategy);
      result = outcome.status;
      detail = outcome.detail;
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
  const { store } = await statePaths(profile, rootDir);
  const raw = (body && typeof body === 'object' ? body : {}) as Partial<PullSchedule>;
  const next = store.setSchedule(raw);
  await store.flush();
  return next;
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
