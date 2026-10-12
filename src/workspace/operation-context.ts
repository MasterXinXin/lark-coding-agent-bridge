import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

/**
 * Ambient "current operation" for workspace jobs. A job (or a scheduler tick)
 * runs inside {@link runInOperation}; git/codegraph runners and the domain
 * functions that own disk side effects read it to register child processes and
 * declarative rollbacks, without threading a token through every signature.
 */

/** What to undo on disk when a still-in-flight step is cancelled. */
export type RollbackDescriptor =
  | {
      kind: 'add-checkout';
      profile: string;
      projectId: string;
      workspaceDir: string;
      localPath: string;
      dir: string;
      rootDir?: string;
    }
  | { kind: 'codegraph-init'; dir: string }
  | { kind: 'codegraph-sync'; dir: string };

export interface OperationMeta {
  /** Job id, or a synthetic id for scheduler ticks. */
  id: string;
  opKind: string;
  label: string;
  profile?: string;
  rootDir?: string;
  startedAt?: number;
}

/** Thrown by `run()` when the operation was cancelled; maps to job `cancelled`. */
export class OperationCancelledError extends Error {
  readonly opId: string;
  constructor(opId: string, message = '操作已取消') {
    super(message);
    this.name = 'OperationCancelledError';
    this.opId = opId;
  }
}

export interface TrackedChild {
  pid: number;
  kind: string;
  startedAt: number;
  child: ChildProcess;
}

export class Operation {
  readonly id: string;
  readonly opKind: string;
  readonly label: string;
  readonly profile?: string;
  readonly rootDir?: string;
  readonly startedAt: number;
  readonly controller = new AbortController();
  readonly children = new Map<number, TrackedChild>();
  readonly rollbacks = new Map<string, RollbackDescriptor>();
  cancelled = false;
  /** Fired on any child/rollback change so the registry can persist the ledger. */
  onChange?: () => void;

  constructor(meta: OperationMeta, now: () => number = Date.now) {
    this.id = meta.id;
    this.opKind = meta.opKind;
    this.label = meta.label;
    this.profile = meta.profile;
    this.rootDir = meta.rootDir;
    this.startedAt = meta.startedAt ?? now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Register a spawned child; a child spawned after cancellation is killed. */
  track(kind: string, child: ChildProcess): void {
    const pid = child.pid;
    if (this.cancelled || pid === undefined) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      return;
    }
    this.children.set(pid, { pid, kind, startedAt: Date.now(), child });
    const drop = () => this.children.delete(pid);
    child.once('close', drop);
    child.once('exit', drop);
    this.onChange?.();
  }

  registerRollback(key: string, descriptor: RollbackDescriptor): void {
    if (this.cancelled) return;
    this.rollbacks.set(key, descriptor);
    this.onChange?.();
  }

  commitRollback(key: string): void {
    if (this.rollbacks.delete(key)) this.onChange?.();
  }
}

const storage = new AsyncLocalStorage<Operation>();

/** The operation owning the current async context, if any. */
export function currentOperation(): Operation | undefined {
  return storage.getStore();
}

/** Run `fn` with `op` installed as the ambient operation. */
export function runInOperation<T>(op: Operation, fn: () => Promise<T> | T): Promise<T> {
  return storage.run(op, () => Promise.resolve(fn()));
}
