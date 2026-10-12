import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { createGitRunner } from '../git/git-ops';
import { listAllProfiles } from '../runtime/profile-discovery';
import { pullProjects } from '../ui/workspace-api';
import type { PullResult } from './history';
import { ProjectStore, type PullSchedule } from './projects';

export interface ScheduledRunItem {
  name: string;
  result: PullResult;
  detail: string;
}

export interface PullSchedulerDeps {
  rootDir?: string;
  /** Tick period; default 60_000. */
  intervalMs?: number;
  now?: () => number;
  listProfiles?: () => Promise<string[]>;
  /** Default: schedule-driven pull of every project in the profile. */
  runProfile?: (profile: string) => Promise<ScheduledRunItem[]>;
  /** Returns whether the message was delivered. */
  notify?: (profile: string, message: string) => Promise<boolean>;
  checkGit?: () => Promise<boolean>;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Read a profile's pull schedule straight from its `projects.json`. */
export async function readProfileSchedule(profile: string, rootDir?: string): Promise<PullSchedule> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  return store.getSchedule();
}

/** Concise markdown summary of a profile's failed projects for the owner. */
function failureMessage(profile: string, failed: ScheduledRunItem[]): string {
  const lines = failed.map((item) => `- ${item.name}：${item.detail}`);
  return `⏰ **定时拉取失败**（profile：${profile}）\n${lines.join('\n')}`;
}

/**
 * Periodic, supervisor-wide pull scheduler. Every tick it reads each profile's
 * schedule and, when due, runs that profile's pulls with `trigger:'schedule'`.
 *
 * All side effects (clock, profile discovery, git, run, notify) are injectable
 * so the class is unit-testable with no real git/clock/network. Constructing it
 * performs no I/O and starting it does not tick immediately.
 */
export class PullScheduler {
  private readonly rootDir: string | undefined;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly listProfiles: () => Promise<string[]>;
  private readonly runProfile: (profile: string) => Promise<ScheduledRunItem[]>;
  private readonly notify: (profile: string, message: string) => Promise<boolean>;
  private readonly checkGit: () => Promise<boolean>;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly lastRun = new Map<string, number>();

  constructor(deps: PullSchedulerDeps = {}) {
    this.rootDir = deps.rootDir;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    const rootDir = deps.rootDir;
    this.listProfiles =
      deps.listProfiles ??
      (async () => {
        try {
          return (await listAllProfiles(rootDir)).map((p) => p.name);
        } catch {
          return [];
        }
      });
    this.runProfile =
      deps.runProfile ??
      (async (profile) => {
        const { results } = await pullProjects(profile, rootDir, {}, undefined, undefined, 'schedule');
        return results.map((r) => ({ name: r.name, result: r.result, detail: r.detail }));
      });
    this.notify = deps.notify ?? (async () => false);
    this.checkGit =
      deps.checkGit ??
      (async () => (await createGitRunner()(['--version'])).code === 0);
  }

  /** Begin ticking; no-op if already started. Never blocks process exit. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop ticking; the scheduler can be started again. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one scheduling round. Guarded against re-entry. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.checkGit())) {
        log.warn('scheduler', 'git-unavailable', {});
        return;
      }
      const profiles = await this.listProfiles();
      const now = this.now();
      for (const profile of profiles) {
        try {
          const schedule = await readProfileSchedule(profile, this.rootDir);
          if (!schedule.enabled) continue;
          const last = this.lastRun.get(profile);
          const dueMs = schedule.intervalMinutes * 60_000;
          if (last !== undefined && now - last < dueMs) continue;
          // Record before awaiting so a slow pull can't be re-entered.
          this.lastRun.set(profile, now);
          const results = await this.runProfile(profile);
          const failed = results.filter((r) => r.result === 'failed');
          log.info('scheduler', 'run', { profile, failed: failed.length });
          if (failed.length > 0 && schedule.notifyOnFailure) {
            const delivered = await this.notify(profile, failureMessage(profile, failed));
            if (!delivered) log.info('scheduler', 'notify-skipped', { profile });
          }
        } catch (err) {
          log.fail('scheduler', err, { profile });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
