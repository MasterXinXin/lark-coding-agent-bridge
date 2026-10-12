import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { createGitRunner } from '../git/git-ops';
import { listAllProfiles } from '../runtime/profile-discovery';
import { pullProjects } from '../ui/workspace-api';
import { MAX_RECORDS, readPullRecords, type PullResult } from './history';
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
  /**
   * Seed a profile's "last run" clock on first sight, so the interval survives a
   * bridge restart. Defaults to reading the newest `trigger:'schedule'` record
   * from the profile's `pull-history.jsonl`.
   */
  seedLastRun?: (profile: string) => Promise<number | undefined>;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Read a profile's pull schedule straight from its `projects.json`. */
export async function readProfileSchedule(profile: string, rootDir?: string): Promise<PullSchedule> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  return store.getSchedule();
}

/**
 * Timestamp (epoch ms) of the profile's newest `trigger:'schedule'` pull record,
 * or `undefined` when there is none. Used to seed the interval clock so a
 * restart doesn't pull immediately. Errors propagate — the caller treats an
 * unreadable history as "never ran".
 */
export async function latestScheduledRunAt(
  profile: string,
  rootDir?: string,
): Promise<number | undefined> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const records = await readPullRecords(appPaths.pullHistoryFile, MAX_RECORDS);
  const newest = records.find((r) => r.trigger === 'schedule');
  if (!newest) return undefined;
  const ts = Date.parse(newest.ts);
  return Number.isFinite(ts) ? ts : undefined;
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
  private readonly seedLastRun: (profile: string) => Promise<number | undefined>;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly lastRun = new Map<string, number>();
  private readonly seeded = new Set<string>();

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
    this.seedLastRun =
      deps.seedLastRun ?? (async (profile) => latestScheduledRunAt(profile, rootDir));
  }

  /** Begin ticking; no-op if already started. Never blocks process exit. */
  start(): void {
    if (this.timer) return;
    const every = Math.max(1000, Number.isFinite(this.intervalMs) ? this.intervalMs : DEFAULT_INTERVAL_MS);
    this.timer = setInterval(
      () => void this.tick().catch((err) => log.fail('scheduler', err, { step: 'tick' })),
      every,
    );
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
      let gitOk: boolean;
      try {
        gitOk = await this.checkGit();
      } catch (err) {
        log.fail('scheduler', err, { step: 'check-git' });
        return;
      }
      if (!gitOk) {
        log.warn('scheduler', 'git-unavailable', {});
        return;
      }
      let profiles: string[];
      try {
        profiles = await this.listProfiles();
      } catch (err) {
        log.fail('scheduler', err, { step: 'list-profiles' });
        return;
      }
      const now = this.now();
      for (const profile of profiles) {
        try {
          const schedule = await readProfileSchedule(profile, this.rootDir);
          if (!schedule.enabled) continue;
          // On first sight, recover the interval clock from persisted history so
          // a restart doesn't trigger an immediate pull. Record the seed attempt
          // before awaiting so it runs at most once per profile.
          if (!this.seeded.has(profile)) {
            this.seeded.add(profile);
            const seededAt = await this.seedLastRun(profile).catch((err) => {
              log.warn('scheduler', 'seed-last-run-failed', { profile, err: String(err) });
              return undefined;
            });
            if (seededAt !== undefined) this.lastRun.set(profile, seededAt);
          }
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
