import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { RollbackDescriptor } from './operation-context';

/**
 * On-disk ledger of in-flight workspace operations, one file per bridge
 * process: `<rootDir>/running-jobs/<ownerPid>.json`. It exists so a bridge that
 * is force-killed (no shutdown hook) can be reconciled on the next start:
 * leftover children are killed and half-finished checkouts/indexes rolled back.
 */

export interface LedgerChild {
  pid: number;
  kind: string;
  startedAt: number;
}

export interface LedgerEntry {
  id: string;
  opKind: string;
  label: string;
  startedAt: number;
  children: LedgerChild[];
  rollbacks: RollbackDescriptor[];
}

export interface LedgerFile {
  ownerPid: number;
  startedAt: number;
  entries: LedgerEntry[];
}

const LEDGER_DIR = 'running-jobs';

export function ledgerDir(rootDir: string): string {
  return join(rootDir, LEDGER_DIR);
}

export function ledgerPath(rootDir: string, ownerPid: number): string {
  return join(ledgerDir(rootDir), `${ownerPid}.json`);
}

export async function writeLedger(rootDir: string, file: LedgerFile): Promise<void> {
  await writeFileAtomic(ledgerPath(rootDir, file.ownerPid), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function removeLedger(rootDir: string, ownerPid: number): Promise<void> {
  await rm(ledgerPath(rootDir, ownerPid), { force: true });
}

export async function readLedger(path: string): Promise<LedgerFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return normalizeLedger(raw);
}

/** Every readable ledger file under `rootDir` (bad/unreadable ones are skipped). */
export async function listLedgerFiles(
  rootDir: string,
): Promise<Array<{ path: string; file: LedgerFile }>> {
  let names: string[];
  try {
    names = await readdir(ledgerDir(rootDir));
  } catch {
    return [];
  }
  const out: Array<{ path: string; file: LedgerFile }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(ledgerDir(rootDir), name);
    const file = await readLedger(path);
    if (file) out.push({ path, file });
  }
  return out;
}

function normalizeLedger(raw: unknown): LedgerFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.ownerPid !== 'number') return undefined;
  const entriesRaw = Array.isArray(r.entries) ? r.entries : [];
  const entries: LedgerEntry[] = [];
  for (const e of entriesRaw) {
    const entry = normalizeEntry(e);
    if (entry) entries.push(entry);
  }
  return {
    ownerPid: r.ownerPid,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
    entries,
  };
}

function normalizeEntry(raw: unknown): LedgerEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return undefined;
  const children: LedgerChild[] = [];
  if (Array.isArray(r.children)) {
    for (const c of r.children) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      if (typeof cc.pid !== 'number') continue;
      children.push({
        pid: cc.pid,
        kind: typeof cc.kind === 'string' ? cc.kind : 'child',
        startedAt: typeof cc.startedAt === 'number' ? cc.startedAt : 0,
      });
    }
  }
  const rollbacks: RollbackDescriptor[] = [];
  if (Array.isArray(r.rollbacks)) {
    for (const d of r.rollbacks) {
      const desc = normalizeRollback(d);
      if (desc) rollbacks.push(desc);
    }
  }
  return {
    id: r.id,
    opKind: typeof r.opKind === 'string' ? r.opKind : 'job',
    label: typeof r.label === 'string' ? r.label : '',
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
    children,
    rollbacks,
  };
}

export function normalizeRollback(raw: unknown): RollbackDescriptor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const dir = typeof r.dir === 'string' ? r.dir : undefined;
  if (!dir) return undefined;
  if (r.kind === 'codegraph-init') return { kind: 'codegraph-init', dir };
  if (r.kind === 'codegraph-sync') return { kind: 'codegraph-sync', dir };
  if (r.kind === 'branch-switch' && typeof r.previousBranch === 'string') {
    return { kind: 'branch-switch', dir, previousBranch: r.previousBranch };
  }
  if (
    r.kind === 'add-checkout' &&
    typeof r.profile === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.workspaceDir === 'string' &&
    typeof r.localPath === 'string'
  ) {
    return {
      kind: 'add-checkout',
      profile: r.profile,
      projectId: r.projectId,
      workspaceDir: r.workspaceDir,
      localPath: r.localPath,
      dir,
      ...(typeof r.rootDir === 'string' ? { rootDir: r.rootDir } : {}),
    };
  }
  return undefined;
}
