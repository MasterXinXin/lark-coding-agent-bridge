import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  normalizeProjectsData,
  ProjectStore,
} from '../../../src/workspace/projects';

const cleanups: string[] = [];
async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-projects-'));
  cleanups.push(dir);
  return join(dir, 'projects.json');
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('normalizeProjectsData', () => {
  it('returns defaults for junk input', () => {
    const data = normalizeProjectsData(null);
    expect(data.projects).toEqual([]);
    expect(data.schedule).toEqual(DEFAULT_SCHEDULE);
  });

  it('drops malformed projects and fills defaults', () => {
    const data = normalizeProjectsData({
      projects: [
        { name: 'ok', repoUrl: 'https://x/y.git' },
        { name: '', repoUrl: 'nope' },
      ],
      schedule: { intervalMinutes: 5 },
    });
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]).toMatchObject({ name: 'ok', branch: 'main', localPath: 'ok' });
    expect(data.schedule.intervalMinutes).toBe(5);
    expect(data.schedule.enabled).toBe(false);
  });
});

describe('ProjectStore', () => {
  it('adds, persists, updates branch and removes', async () => {
    const path = await tmpStorePath();
    const store = new ProjectStore(path);
    await store.load();

    const added = store.add({ repoUrl: 'https://x/y.git', branch: 'develop', name: 'y' });
    expect(added.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);

    store.updateBranch(added.id, 'main');
    store.setSchedule({ enabled: true, intervalMinutes: 15 });
    await store.flush();

    const reloaded = new ProjectStore(path);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ branch: 'main' });
    expect(reloaded.getSchedule()).toMatchObject({ enabled: true, intervalMinutes: 15 });

    expect(reloaded.remove(added.id)).toBe(true);
    expect(reloaded.remove('missing')).toBe(false);
    expect(reloaded.list()).toHaveLength(0);
  });

  it('rejects duplicate names and blank repo urls', async () => {
    const store = new ProjectStore(await tmpStorePath());
    await store.load();
    store.add({ repoUrl: 'https://x/y.git', name: 'y' });
    expect(() => store.add({ repoUrl: 'https://x/z.git', name: 'y' })).toThrow(/已存在/);
    expect(() => store.add({ repoUrl: '  ', name: 'z' })).toThrow(/仓库地址/);
  });

  it('clamps schedule interval', async () => {
    const store = new ProjectStore(await tmpStorePath());
    await store.load();
    expect(store.setSchedule({ intervalMinutes: 1 }).intervalMinutes).toBe(5);
    expect(store.setSchedule({ intervalMinutes: 99999 }).intervalMinutes).toBe(1440);
  });
});
