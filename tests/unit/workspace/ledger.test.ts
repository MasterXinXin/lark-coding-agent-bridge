import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ledgerDir,
  ledgerPath,
  listLedgerFiles,
  normalizeRollback,
  readLedger,
  removeLedger,
  writeLedger,
  type LedgerFile,
} from '../../../src/workspace/ledger';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ledger-'));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function sampleFile(ownerPid: number): LedgerFile {
  return {
    ownerPid,
    startedAt: 1000,
    entries: [
      {
        id: 'job-1',
        opKind: 'add',
        label: '添加项目',
        startedAt: 1001,
        children: [{ pid: 222, kind: 'git', startedAt: 1002 }],
        rollbacks: [
          {
            kind: 'add-checkout',
            profile: 'claude',
            projectId: 'p1',
            workspaceDir: '/ws',
            localPath: 'x',
            dir: '/ws/x',
            rootDir,
          },
        ],
      },
    ],
  };
}

describe('ledger', () => {
  it('round-trips a file', async () => {
    await writeLedger(rootDir, sampleFile(4242));
    const file = await readLedger(ledgerPath(rootDir, 4242));
    expect(file).toBeDefined();
    expect(file!.ownerPid).toBe(4242);
    expect(file!.entries[0]!.children[0]!.pid).toBe(222);
    expect(file!.entries[0]!.rollbacks[0]).toMatchObject({ kind: 'add-checkout', dir: '/ws/x' });
  });

  it('lists only readable json files', async () => {
    await writeLedger(rootDir, sampleFile(1));
    await writeLedger(rootDir, sampleFile(2));
    await writeFile(join(ledgerDir(rootDir), 'notes.txt'), 'ignore me');
    await writeFile(join(ledgerDir(rootDir), 'broken.json'), '{ not json');
    const files = await listLedgerFiles(rootDir);
    expect(files.map((f) => f.file.ownerPid).sort()).toEqual([1, 2]);
  });

  it('returns undefined for a missing or malformed file', async () => {
    expect(await readLedger(ledgerPath(rootDir, 999))).toBeUndefined();
    await writeLedger(rootDir, sampleFile(3));
    await writeFile(join(ledgerDir(rootDir), 'bad.json'), 'not json at all');
    expect(await readLedger(join(ledgerDir(rootDir), 'bad.json'))).toBeUndefined();
  });

  it('skips unknown rollback kinds while keeping the entry', async () => {
    const file = sampleFile(7);
    file.entries[0]!.rollbacks = [
      { kind: 'add-checkout', profile: 'p', projectId: 'x', workspaceDir: '/w', localPath: 'x', dir: '/w/x' },
      { kind: 'bogus', dir: '/nope' } as never,
    ];
    await writeLedger(rootDir, file);
    const read = await readLedger(ledgerPath(rootDir, 7));
    expect(read!.entries[0]!.rollbacks).toHaveLength(1);
    expect(read!.entries[0]!.rollbacks[0]!.kind).toBe('add-checkout');
  });

  it('removes a file', async () => {
    await writeLedger(rootDir, sampleFile(55));
    expect(await readdir(ledgerDir(rootDir))).toContain('55.json');
    await removeLedger(rootDir, 55);
    expect(await readdir(ledgerDir(rootDir))).not.toContain('55.json');
  });

  it('normalizes a branch-switch rollback and rejects an incomplete one', () => {
    expect(
      normalizeRollback({ kind: 'branch-switch', dir: '/ws/x', previousBranch: 'main' }),
    ).toEqual({ kind: 'branch-switch', dir: '/ws/x', previousBranch: 'main' });
    expect(normalizeRollback({ kind: 'branch-switch', dir: '/ws/x' })).toBeUndefined();
  });
});
