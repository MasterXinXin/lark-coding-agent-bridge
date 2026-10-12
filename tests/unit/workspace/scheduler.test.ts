import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { ProjectStore, type PullSchedule } from '../../../src/workspace/projects';
import { PullScheduler } from '../../../src/workspace/scheduler';

let rootDir: string;
const cleanups: string[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-scheduler-'));
  cleanups.push(rootDir);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Persist a real `projects.json` for `profile` so `readProfileSchedule` sees it. */
async function writeSchedule(profile: string, schedule: Partial<PullSchedule>): Promise<void> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  await mkdir(dirname(appPaths.projectsFile), { recursive: true });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  store.setSchedule(schedule);
  await store.flush();
}

describe('PullScheduler', () => {
  it('skips a profile whose schedule is disabled', async () => {
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async (profile) => {
        runs.push(profile);
        return [];
      },
      checkGit: async () => true,
    });

    await scheduler.tick();

    expect(runs).toEqual([]);
  });

  it('runs a due profile and only again after the interval elapses', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5 });
    let now = 1_000_000;
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async (profile) => {
        runs.push(profile);
        return [];
      },
      now: () => now,
      checkGit: async () => true,
    });

    await scheduler.tick();
    expect(runs).toEqual(['claude']);

    // Same clock → not due again.
    await scheduler.tick();
    expect(runs).toEqual(['claude']);

    // One interval later → due again.
    now += 5 * 60_000;
    await scheduler.tick();
    expect(runs).toEqual(['claude', 'claude']);

    // Just under the interval → not due.
    now += 5 * 60_000 - 1;
    await scheduler.tick();
    expect(runs).toEqual(['claude', 'claude']);
  });

  it('skips the whole round when git is unavailable, without throwing', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5 });
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async (profile) => {
        runs.push(profile);
        return [];
      },
      checkGit: async () => false,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('notifies the owner once with the failed project name when notifyOnFailure is on', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5, notifyOnFailure: true });
    const notified: Array<{ profile: string; message: string }> = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async () => [{ name: 'proj-a', result: 'failed', detail: 'boom' }],
      notify: async (profile, message) => {
        notified.push({ profile, message });
        return true;
      },
      checkGit: async () => true,
    });

    await scheduler.tick();

    expect(notified).toHaveLength(1);
    expect(notified[0]!.profile).toBe('claude');
    expect(notified[0]!.message).toContain('proj-a');
    expect(notified[0]!.message).toContain('boom');
  });

  it('does not notify when notifyOnFailure is off', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5, notifyOnFailure: false });
    let notified = 0;
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async () => [{ name: 'proj-a', result: 'failed', detail: 'boom' }],
      notify: async () => {
        notified += 1;
        return true;
      },
      checkGit: async () => true,
    });

    await scheduler.tick();

    expect(notified).toBe(0);
  });

  it('keeps the run result when notify reports undelivered', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5, notifyOnFailure: true });
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async (profile) => {
        runs.push(profile);
        return [{ name: 'proj-a', result: 'failed', detail: 'boom' }];
      },
      notify: async () => false,
      checkGit: async () => true,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(runs).toEqual(['claude']);
  });

  it('does not let one failed profile stop the next', async () => {
    await writeSchedule('bad', { enabled: true, intervalMinutes: 5 });
    await writeSchedule('good', { enabled: true, intervalMinutes: 5 });
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['bad', 'good'],
      runProfile: async (profile) => {
        if (profile === 'bad') throw new Error('boom');
        runs.push(profile);
        return [];
      },
      checkGit: async () => true,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(runs).toEqual(['good']);
  });

  it('is re-entrancy safe when a slow run overlaps a second tick', async () => {
    await writeSchedule('claude', { enabled: true, intervalMinutes: 5 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runs: string[] = [];
    const scheduler = new PullScheduler({
      rootDir,
      listProfiles: async () => ['claude'],
      runProfile: async (profile) => {
        runs.push(profile);
        entered();
        await gate;
        return [];
      },
      checkGit: async () => true,
    });

    const first = scheduler.tick();
    await started; // first tick is now blocked inside runProfile
    const second = scheduler.tick();
    await second;
    expect(runs).toEqual(['claude']);

    release();
    await first;
    expect(runs).toEqual(['claude']);
  });
});
