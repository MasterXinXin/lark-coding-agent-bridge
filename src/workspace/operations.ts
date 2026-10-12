import { log } from '../core/logger';
import { isProcessAlive, killProcessTree } from '../platform/process-kill';
import {
  listLedgerFiles,
  removeLedger,
  writeLedger,
  type LedgerEntry,
  type LedgerFile,
} from './ledger';
import {
  Operation,
  OperationCancelledError,
  runInOperation,
  type OperationMeta,
  type RollbackDescriptor,
  type TrackedChild,
} from './operation-context';
import { executeRollback } from './rollback';

/**
 * Tracks in-flight workspace operations so they can be cancelled (job button,
 * profile stop, process shutdown) or reconciled after a force-kill. Owns the
 * on-disk ledger and the kill + rollback sequence.
 */

export interface OperationRegistryDeps {
  now?: () => number;
  /** SIGTERM → force-kill grace period. Default 2000ms. */
  graceMs?: number;
  isAlive?: (pid: number) => boolean;
  killTree?: (pid: number) => void;
  executeRollback?: (descriptor: RollbackDescriptor) => Promise<void>;
  writeLedger?: (rootDir: string, file: LedgerFile) => Promise<void>;
  removeLedger?: (rootDir: string, ownerPid: number) => Promise<void>;
  listLedgerFiles?: typeof listLedgerFiles;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sentinel resolved by the cancel branch of `run`'s race. */
const CANCEL_SIGNAL = Symbol('operation-cancelled');

export class OperationRegistry {
  private readonly ops = new Map<string, Operation>();
  private readonly ownerPid = process.pid;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly killTree: (pid: number) => void;
  private readonly runRollback: (descriptor: RollbackDescriptor) => Promise<void>;
  private readonly writeLedgerFn: (rootDir: string, file: LedgerFile) => Promise<void>;
  private readonly removeLedgerFn: (rootDir: string, ownerPid: number) => Promise<void>;
  private readonly listLedgerFilesFn: typeof listLedgerFiles;
  private readonly knownRoots = new Set<string>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(deps: OperationRegistryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 2000;
    this.startedAt = this.now();
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.killTree = deps.killTree ?? killProcessTree;
    this.runRollback = deps.executeRollback ?? ((descriptor) => executeRollback(descriptor));
    this.writeLedgerFn = deps.writeLedger ?? writeLedger;
    this.removeLedgerFn = deps.removeLedger ?? removeLedger;
    this.listLedgerFilesFn = deps.listLedgerFiles ?? listLedgerFiles;
  }

  /** Number of operations currently in flight (tests / diagnostics). */
  size(): number {
    return this.ops.size;
  }

  /**
   * Create an operation, run `fn` inside it, and persist/clear the ledger on
   * exit. A cancelled operation rejects with {@link OperationCancelledError}
   * promptly — without waiting for a hung `fn` to settle.
   */
  async run<T>(meta: OperationMeta, fn: () => Promise<T> | T): Promise<T> {
    const op = new Operation(meta, this.now);
    this.ops.set(op.id, op);
    if (op.rootDir) this.knownRoots.add(op.rootDir);
    op.onChange = () => void this.persist().catch(() => undefined);
    await this.persist().catch(() => undefined);

    let signalCancelled: () => void;
    const cancelled = new Promise<typeof CANCEL_SIGNAL>((resolve) => {
      signalCancelled = () => resolve(CANCEL_SIGNAL);
    });
    const onAbort = () => signalCancelled();
    op.signal.addEventListener('abort', onAbort, { once: true });

    const work = runInOperation(op, fn);
    // Never let a late rejection (after cancel wins the race) go unhandled.
    void work.catch(() => undefined);

    try {
      const outcome = await Promise.race([work, cancelled]);
      if (outcome === CANCEL_SIGNAL || op.cancelled) throw new OperationCancelledError(op.id);
      return outcome as T;
    } catch (err) {
      if (op.cancelled && !(err instanceof OperationCancelledError)) {
        throw new OperationCancelledError(op.id);
      }
      throw err;
    } finally {
      op.signal.removeEventListener('abort', onAbort);
      await this.finish(op.id).catch(() => undefined);
    }
  }

  /** Cancel one operation: kill its children, run its rollbacks, drop it. */
  async cancel(id: string, reason?: string): Promise<boolean> {
    const op = this.ops.get(id);
    if (!op || op.cancelled) return false;
    op.cancelled = true;
    op.controller.abort();

    const children = [...op.children.values()];
    for (const child of children) {
      try {
        child.child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }
    await this.waitForExit(children);
    for (const child of children) {
      if (this.isAlive(child.pid)) {
        try {
          this.killTree(child.pid);
        } catch {
          // Best effort.
        }
      }
    }

    const rollbacks = [...op.rollbacks.values()].reverse();
    op.rollbacks.clear();
    for (const descriptor of rollbacks) {
      await this.runRollback(descriptor).catch((err) =>
        log.warn('workspace', 'rollback-failed', {
          opId: op.id,
          kind: descriptor.kind,
          err: String(err),
        }),
      );
    }

    this.ops.delete(op.id);
    await this.persist().catch(() => undefined);
    log.info('workspace', 'operation-cancelled', {
      opId: op.id,
      kind: op.opKind,
      reason: reason ?? '',
    });
    return true;
  }

  /** Cancel every in-flight operation (process shutdown). */
  async cancelAll(reason?: string): Promise<void> {
    for (const id of [...this.ops.keys()]) await this.cancel(id, reason);
  }

  /** Cancel the operations owned by a profile (that profile was stopped). */
  async cancelByProfile(profile: string, reason?: string): Promise<number> {
    let count = 0;
    for (const [id, op] of [...this.ops]) {
      if (op.profile === profile && (await this.cancel(id, reason))) count += 1;
    }
    return count;
  }

  /**
   * Reconcile a previous bridge's leftovers: for each ledger file whose owner
   * is no longer alive, kill any surviving children and run its rollbacks.
   * Returns how many entries were handled.
   */
  async reconcile(rootDir: string): Promise<number> {
    const files = await this.listLedgerFilesFn(rootDir).catch(() => []);
    let handled = 0;
    for (const { file } of files) {
      if (file.ownerPid === this.ownerPid) {
        // Our own pid only appears from a previous process; at startup the
        // registry is empty, so treat it as stale and just clear it.
        if (this.ops.size === 0) await this.removeLedgerFn(rootDir, file.ownerPid).catch(() => undefined);
        continue;
      }
      if (this.isAlive(file.ownerPid)) continue;
      for (const entry of file.entries) {
        for (const child of entry.children) {
          if (child.pid === process.pid) continue;
          if (this.isAlive(child.pid)) {
            try {
              this.killTree(child.pid);
            } catch {
              // Best effort.
            }
          }
        }
        for (const descriptor of [...entry.rollbacks].reverse()) {
          await this.runRollback(descriptor).catch((err) =>
            log.warn('workspace', 'reconcile-rollback-failed', {
              opId: entry.id,
              kind: descriptor.kind,
              err: String(err),
            }),
          );
        }
        handled += 1;
      }
      await this.removeLedgerFn(rootDir, file.ownerPid).catch(() => undefined);
      log.info('workspace', 'reconciled-stale-jobs', { ownerPid: file.ownerPid, entries: file.entries.length });
    }
    return handled;
  }

  private async waitForExit(children: TrackedChild[]): Promise<void> {
    if (children.length === 0) return;
    const waits = children.map(
      (child) =>
        new Promise<void>((resolve) => {
          const proc = child.child;
          if (proc.exitCode !== null || proc.signalCode !== null) {
            resolve();
            return;
          }
          const done = () => resolve();
          proc.once('close', done);
          proc.once('exit', done);
        }),
    );
    await Promise.race([Promise.all(waits), sleep(this.graceMs)]);
  }

  private async finish(id: string): Promise<void> {
    if (!this.ops.delete(id)) return;
    await this.persist();
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain
      .then(() => this.persistNow())
      .catch((err) => {
        log.warn('workspace', 'ledger-persist-failed', { err: String(err) });
      });
    return this.persistChain;
  }

  private async persistNow(): Promise<void> {
    const byRoot = new Map<string, LedgerEntry[]>();
    for (const op of this.ops.values()) {
      if (!op.rootDir) continue;
      const list = byRoot.get(op.rootDir) ?? [];
      list.push({
        id: op.id,
        opKind: op.opKind,
        label: op.label,
        startedAt: op.startedAt,
        children: [...op.children.values()].map((c) => ({
          pid: c.pid,
          kind: c.kind,
          startedAt: c.startedAt,
        })),
        rollbacks: [...op.rollbacks.values()],
      });
      byRoot.set(op.rootDir, list);
    }
    for (const rootDir of [...this.knownRoots]) {
      const entries = byRoot.get(rootDir);
      if (!entries || entries.length === 0) {
        await this.removeLedgerFn(rootDir, this.ownerPid).catch(() => undefined);
        this.knownRoots.delete(rootDir);
        continue;
      }
      await this.writeLedgerFn(rootDir, { ownerPid: this.ownerPid, startedAt: this.startedAt, entries });
    }
  }
}

/** Process-wide registry backing the console + shutdown. */
export const defaultOperations = new OperationRegistry();

export function runOperation<T>(meta: OperationMeta, fn: () => Promise<T> | T): Promise<T> {
  return defaultOperations.run(meta, fn);
}

export function cancelOperation(id: string, reason?: string): Promise<boolean> {
  return defaultOperations.cancel(id, reason);
}

export function cancelOperationsForProfile(profile: string, reason?: string): Promise<number> {
  return defaultOperations.cancelByProfile(profile, reason);
}

export function cancelAllOperations(reason?: string): Promise<void> {
  return defaultOperations.cancelAll(reason);
}

export function reconcileStaleOperations(rootDir: string): Promise<number> {
  return defaultOperations.reconcile(rootDir);
}
