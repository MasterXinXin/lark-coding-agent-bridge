import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { Operation, currentOperation, runInOperation } from '../../../src/workspace/operation-context';

/** A minimal ChildProcess stand-in: emits `close`, records kills. */
function fakeChild(pid: number): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    pid,
    kill: vi.fn(() => true),
  });
  return child;
}

describe('currentOperation', () => {
  it('is undefined outside any operation', () => {
    expect(currentOperation()).toBeUndefined();
  });

  it('is visible synchronously and across async continuations', async () => {
    const op = new Operation({ id: 'j1', opKind: 'add', label: 'x' });
    await runInOperation(op, async () => {
      expect(currentOperation()).toBe(op);
      await new Promise((r) => setTimeout(r, 5));
      expect(currentOperation()).toBe(op);
    });
    expect(currentOperation()).toBeUndefined();
  });
});

describe('Operation tracking', () => {
  it('registers a child and drops it on close', () => {
    const op = new Operation({ id: 'j1', opKind: 'add', label: 'x' });
    const child = fakeChild(123);
    op.track('git', child);
    expect(op.children.has(123)).toBe(true);
    child.emit('close');
    expect(op.children.has(123)).toBe(false);
  });

  it('kills a child spawned after cancellation instead of tracking it', () => {
    const op = new Operation({ id: 'j1', opKind: 'add', label: 'x' });
    op.cancelled = true;
    const child = fakeChild(9);
    op.track('git', child);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(op.children.has(9)).toBe(false);
  });

  it('fires onChange on child/rollback changes', () => {
    const op = new Operation({ id: 'j1', opKind: 'add', label: 'x' });
    const onChange = vi.fn();
    op.onChange = onChange;
    const child = fakeChild(1);
    op.track('git', child);
    op.registerRollback('k', { kind: 'codegraph-init', dir: '/d' });
    expect(onChange).toHaveBeenCalledTimes(2);
    op.commitRollback('k');
    expect(onChange).toHaveBeenCalledTimes(3);
    // Committing an unknown key is a no-op.
    op.commitRollback('missing');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('refuses to register a rollback after cancellation', () => {
    const op = new Operation({ id: 'j1', opKind: 'add', label: 'x' });
    op.cancelled = true;
    op.registerRollback('k', { kind: 'codegraph-init', dir: '/d' });
    expect(op.rollbacks.size).toBe(0);
  });
});
