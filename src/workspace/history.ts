import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type PullResult = 'updated' | 'up-to-date' | 'skipped' | 'failed';
export type PullTrigger = 'schedule' | 'manual';

export interface PullRecord {
  ts: string;
  projectId: string;
  name: string;
  branch: string;
  result: PullResult;
  detail: string;
  durationMs: number;
  trigger: PullTrigger;
}

/** Hard cap so the JSONL file can't grow without bound. */
export const MAX_RECORDS = 500;

function isRecord(value: unknown): value is PullRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<PullRecord>;
  return (
    typeof r.ts === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.branch === 'string' &&
    (r.result === 'updated' || r.result === 'up-to-date' || r.result === 'skipped' || r.result === 'failed') &&
    typeof r.detail === 'string' &&
    typeof r.durationMs === 'number' &&
    (r.trigger === 'schedule' || r.trigger === 'manual')
  );
}

/** Append one record, trimming to the newest {@link MAX_RECORDS}. */
export async function appendPullRecord(path: string, record: PullRecord): Promise<void> {
  const existing = await readRaw(path);
  const next = [...existing, record].slice(-MAX_RECORDS);
  await writeFileAtomic(path, `${next.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
}

/** Newest-first records, capped at `limit`. Corrupt lines are skipped. */
export async function readPullRecords(path: string, limit = 50): Promise<PullRecord[]> {
  const all = await readRaw(path);
  return all.slice(-Math.max(0, limit)).reverse();
}

async function readRaw(path: string): Promise<PullRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PullRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
