import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendPullRecord, MAX_RECORDS, readPullRecords, type PullRecord } from '../../../src/workspace/history';

const cleanups: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-history-'));
  cleanups.push(dir);
  return join(dir, 'pull-history.jsonl');
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function record(i: number): PullRecord {
  return {
    ts: new Date(i * 1000).toISOString(),
    projectId: 'p1', name: 'repo', branch: 'main',
    result: 'updated', detail: 'ok', durationMs: 10, trigger: 'manual',
  };
}

describe('pull history', () => {
  it('appends and reads records newest-first', async () => {
    const path = await tmpFile();
    await appendPullRecord(path, record(1));
    await appendPullRecord(path, record(2));
    const rows = await readPullRecords(path, 10);
    expect(rows.map((r) => r.ts)).toEqual([record(2).ts, record(1).ts]);
  });

  it('caps stored records at MAX_RECORDS', async () => {
    const path = await tmpFile();
    for (let i = 0; i < MAX_RECORDS + 5; i++) await appendPullRecord(path, record(i));
    const rows = await readPullRecords(path, MAX_RECORDS + 100);
    expect(rows).toHaveLength(MAX_RECORDS);
    expect(rows[0]!.ts).toBe(record(MAX_RECORDS + 4).ts);
  }, 30000);

  it('skips corrupt lines', async () => {
    const path = await tmpFile();
    await writeFile(
      path,
      `not json\n${JSON.stringify({ ts: 1 })}\n${JSON.stringify({ ts: 'x' })}\n${JSON.stringify(record(1))}\n`,
      'utf8',
    );
    const rows = await readPullRecords(path, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(record(1).ts);
  });

  it('returns [] for a non-positive limit', async () => {
    const path = await tmpFile();
    await appendPullRecord(path, record(1));
    expect(await readPullRecords(path, 0)).toEqual([]);
    expect(await readPullRecords(path, -5)).toEqual([]);
  });

  it('returns [] when the file is missing', async () => {
    expect(await readPullRecords(await tmpFile(), 10)).toEqual([]);
  });
});
