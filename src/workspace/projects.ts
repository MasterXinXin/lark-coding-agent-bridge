import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { PullStrategy } from '../git/git-ops';

export interface ProjectEntry {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  accountId?: string;
}

export interface PullSchedule {
  enabled: boolean;
  intervalMinutes: number;
  strategy: PullStrategy;
  notifyOnFailure: boolean;
}

export interface ProjectsData {
  version: 1;
  projects: ProjectEntry[];
  schedule: PullSchedule;
}

export const DEFAULT_SCHEDULE: PullSchedule = {
  enabled: false,
  intervalMinutes: 30,
  strategy: 'ff-only',
  notifyOnFailure: true,
};

export interface AddProjectInput {
  repoUrl: string;
  branch?: string;
  name?: string;
  localPath?: string;
  accountId?: string;
}

const STRATEGIES: PullStrategy[] = ['ff-only', 'fetch-only', 'reset-hard'];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSchedule(input: unknown): PullSchedule {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<PullSchedule>;
  const n = Number(raw.intervalMinutes);
  const intervalMinutes = Number.isFinite(n)
    ? Math.min(1440, Math.max(5, Math.floor(n)))
    : DEFAULT_SCHEDULE.intervalMinutes;
  return {
    enabled: raw.enabled === true,
    intervalMinutes,
    strategy: STRATEGIES.includes(raw.strategy as PullStrategy)
      ? (raw.strategy as PullStrategy)
      : DEFAULT_SCHEDULE.strategy,
    notifyOnFailure: raw.notifyOnFailure !== false,
  };
}

function normalizeProject(input: unknown): ProjectEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<ProjectEntry>;
  const name = str(raw.name);
  const repoUrl = str(raw.repoUrl);
  if (!name || !repoUrl) return undefined;
  const branch = str(raw.branch) || 'main';
  const localPath = str(raw.localPath) || name;
  const accountId = str(raw.accountId);
  const id = str(raw.id) || randomUUID();
  return { id, name, repoUrl, localPath, branch, ...(accountId ? { accountId } : {}) };
}

export function normalizeProjectsData(input: unknown): ProjectsData {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    projects?: unknown;
    schedule?: unknown;
  };
  const projects: ProjectEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.projects)) {
    for (const item of raw.projects) {
      const project = normalizeProject(item);
      if (!project || seen.has(project.name)) continue;
      seen.add(project.name);
      projects.push(project);
    }
  }
  return { version: 1, projects, schedule: normalizeSchedule(raw.schedule) };
}

export class ProjectStore {
  private data: ProjectsData = { version: 1, projects: [], schedule: { ...DEFAULT_SCHEDULE } };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      this.data = normalizeProjectsData(JSON.parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  list(): ProjectEntry[] {
    return this.data.projects.map((p) => ({ ...p }));
  }

  get(id: string): ProjectEntry | undefined {
    const found = this.data.projects.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  getSchedule(): PullSchedule {
    return { ...this.data.schedule };
  }

  add(input: AddProjectInput): ProjectEntry {
    const repoUrl = input.repoUrl.trim();
    if (!repoUrl) throw new Error('仓库地址不能为空');
    const name = input.name?.trim() || deriveName(repoUrl);
    if (!name) throw new Error('项目名不能为空');
    if (this.data.projects.some((p) => p.name === name)) {
      throw new Error(`项目名已存在：${name}`);
    }
    const entry: ProjectEntry = {
      id: randomUUID(),
      name,
      repoUrl,
      localPath: input.localPath?.trim() || name,
      branch: input.branch?.trim() || 'main',
      ...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
    };
    this.data.projects.push(entry);
    this.schedulePersist();
    return { ...entry };
  }

  updateBranch(id: string, branch: string): ProjectEntry {
    const trimmed = branch.trim();
    if (!trimmed) throw new Error('分支不能为空');
    const project = this.data.projects.find((p) => p.id === id);
    if (!project) throw new Error(`项目不存在：${id}`);
    project.branch = trimmed;
    this.schedulePersist();
    return { ...project };
  }

  remove(id: string): boolean {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.projects.length === before) return false;
    this.schedulePersist();
    return true;
  }

  setSchedule(patch: Partial<PullSchedule>): PullSchedule {
    this.data.schedule = normalizeSchedule({ ...this.data.schedule, ...patch });
    this.schedulePersist();
    return this.getSchedule();
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
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}

function deriveName(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '');
  return trimmed.split(/[/\\:]/).pop() ?? '';
}
