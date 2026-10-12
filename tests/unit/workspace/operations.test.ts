import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { LedgerFile } from '../../../src/workspace/ledger';
import { OperationRegistry } from '../../../src/workspace/operations';
import { currentOperation, OperationCancelledError } from '../../../src/workspace/operation-context';

function fakeChild(pid: number): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      setImmediate(() => child.emit('close'));
      return true;
    }),
  });
  return child;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OperationRegistry.run', () => {
  it('exposes the operation inside fn and clears it afterwards', async () => {
    const reg = new OperationRegistry();
    let seen: ReturnType<typeof currentOperation>;
    const out = await reg.run({ id: 'a', opKind: 'add', label: 'l' }, () => {
      seen = currentOperation();
      return 42;
    });
    expect(out).toBe(42);
    expect(seen!.id).toBe('a');
    expect(currentOperation()).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('rejects promptly when cancelled even if fn never settles', async () => {
    const reg = new OperationRegistry({ graceMs: 5, isAlive: () => false });
    let release!: () => void;
    const work = reg.run(
      { id: 'hang', opKind: 'add', label: 'l' },
      () => new Promise<void>((res) => (release = res)),
    );
    const cancelled = expect(work).rejects.toBeInstanceOf(OperationCancelledError);
    await sleep(10);
    await expect(reg.cancel('hang')).resolves.toBe(true);
    await cancelled;
    release();
  });
});

describe('OperationRegistry.cancel', () => {
  it('kills tracked children and runs rollbacks in reverse order', async () => {
    const killed: number[] = [];
    const rolled: string[] = [];
    const reg = new OperationRegistry({
      graceMs: 10,
      isAlive: () => true,
      killTree: (pid) => killed.push(pid),
      executeRollback: async (d) => {
        rolled.push(d.kind);
      },
    });
    const work = reg.run({ id: 'j', opKind: 'add', label: 'l' }, async () => {
      const op = currentOperation()!;
      op.track('git', fakeChild(111));
      op.registerRollback('r1', { kind: 'codegraph-init', dir: '/a' });
      op.registerRollback('r2', { kind: 'codegraph-sync', dir: '/b' });
      await new Promise<void>(() => {});
    });
    const cancelled = expect(work).rejects.toBeInstanceOf(OperationCancelledError);
    await sleep(10);
    await expect(reg.cancel('j')).resolves.toBe(true);
    await cancelled;
    expect(killed).toContain(111);
    expect(rolled).toEqual(['codegraph-sync', 'codegraph-init']);
  });

  it('is a no-op for an unknown or already-cancelled operation', async () => {
    const reg = new OperationRegistry();
    expect(await reg.cancel('nope')).toBe(false);
    const work = reg.run({ id: 'k', opKind: 'add', label: 'l' }, () => new Promise<void>(() => {}));
    const cancelled = expect(work).rejects.toBeInstanceOf(OperationCancelledError);
    await sleep(5);
    expect(await reg.cancel('k')).toBe(true);
    expect(await reg.cancel('k')).toBe(false);
    await cancelled;
  });

  it('skips a rollback that was committed', async () => {
    const rolled: string[] = [];
    const reg = new OperationRegistry({
      graceMs: 5,
      isAlive: () => false,
      executeRollback: async (d) => {
        rolled.push(d.kind);
      },
    });
    const work = reg.run({ id: 'j2', opKind: 'add', label: 'l' }, async () => {
      const op = currentOperation()!;
      op.registerRollback('k', { kind: 'codegraph-init', dir: '/x' });
      op.commitRollback('k');
      await new Promise<void>(() => {});
    });
    const cancelled = expect(work).rejects.toBeInstanceOf(OperationCancelledError);
    await sleep(5);
    await reg.cancel('j2');
    await cancelled;
    expect(rolled).toEqual([]);
  });

  it('cancels only the matching profile', async () => {
    const reg = new OperationRegistry();
    const a = reg.run({ id: 'a', opKind: 'add', label: 'l', profile: 'claude' }, () => new Promise<void>(() => {}));
    const b = reg.run({ id: 'b', opKind: 'add', label: 'l', profile: 'codex' }, () => new Promise<void>(() => {}));
    const aCancelled = expect(a).rejects.toBeInstanceOf(OperationCancelledError);
    const bCancelled = expect(b).rejects.toBeInstanceOf(OperationCancelledError);
    await sleep(5);
    expect(await reg.cancelByProfile('claude')).toBe(1);
    expect(reg.size()).toBe(1);
    await aCancelled;
    await reg.cancelAll();
    await bCancelled;
  });
});

describe('OperationRegistry ledger', () => {
  it('writes while running and removes the file on finish', async () => {
    const writes: Array<{ rootDir: string; file: LedgerFile }> = [];
    const removals: number[] = [];
    const reg = new OperationRegistry({
      writeLedger: async (rootDir, file) => {
        writes.push({ rootDir, file });
      },
      removeLedger: async (_rootDir, ownerPid) => {
        removals.push(ownerPid);
      },
    });
    await reg.run({ id: 'j3', opKind: 'add', label: 'l', rootDir: '/root' }, async () => {});
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]!.file.entries[0]!.id).toBe('j3');
    expect(removals.length).toBeGreaterThan(0);
  });
});

describe('OperationRegistry.reconcile', () => {
  const file: LedgerFile = {
    ownerPid: 999999,
    startedAt: 1,
    entries: [
      {
        id: 'old',
        opKind: 'add',
        label: 'l',
        startedAt: 1,
        children: [{ pid: 555, kind: 'git', startedAt: 1 }],
        rollbacks: [{ kind: 'codegraph-init', dir: '/p' }],
      },
    ],
  };

  it('kills surviving children, rolls back, and removes the file of a dead owner', async () => {
    const killed: number[] = [];
    const rolled: string[] = [];
    const removed: number[] = [];
    const reg = new OperationRegistry({
      isAlive: (pid) => pid === 555,
      killTree: (pid) => killed.push(pid),
      executeRollback: async (d) => {
        rolled.push(d.kind);
      },
      listLedgerFiles: async () => [{ path: 'x', file }],
      removeLedger: async (_rootDir, ownerPid) => {
        removed.push(ownerPid);
      },
    });
    expect(await reg.reconcile('/root')).toBe(1);
    expect(killed).toEqual([555]);
    expect(rolled).toEqual(['codegraph-init']);
    expect(removed).toEqual([999999]);
  });

  it('skips a ledger whose owner is still alive', async () => {
    const killed = vi.fn();
    const removed = vi.fn();
    const reg = new OperationRegistry({
      isAlive: (pid) => pid === 999999,
      killTree: killed,
      executeRollback: async () => {},
      listLedgerFiles: async () => [{ path: 'x', file }],
      removeLedger: removed,
    });
    expect(await reg.reconcile('/root')).toBe(0);
    expect(killed).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });
});
