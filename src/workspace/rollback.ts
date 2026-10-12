import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { createCodegraphRunner } from './codegraph';
import type { RollbackDescriptor } from './operation-context';
import { ProjectStore } from './projects';

/**
 * Best-effort undo of a half-finished workspace step. Runs both when a job is
 * cancelled in-process and when a force-killed bridge's ledger is reconciled on
 * the next start, so every branch must tolerate already-missing artifacts.
 */

export interface RollbackDeps {
  /** Directory removal; injectable for tests. */
  remove?: (dir: string) => Promise<void>;
  removeProjectRecord?: (
    profile: string,
    rootDir: string | undefined,
    projectId: string,
  ) => Promise<void>;
  /** Release a stale codegraph index lock; injectable for tests. */
  unlock?: (dir: string) => Promise<void>;
}

/** Absolute target, or undefined when it escapes the workspace / is the root. */
function resolveInside(workspaceDir: string, localPath: string): string | undefined {
  const abs = isAbsolute(localPath) ? resolve(localPath) : resolve(workspaceDir, localPath);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel === '' || rel.startsWith('..' + sep) || isAbsolute(rel)) return undefined;
  return abs;
}

export async function executeRollback(
  descriptor: RollbackDescriptor,
  deps: RollbackDeps = {},
): Promise<void> {
  const remove = deps.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

  if (descriptor.kind === 'add-checkout') {
    const dir = resolveInside(descriptor.workspaceDir, descriptor.localPath);
    if (dir) {
      await remove(dir).catch((err) =>
        log.warn('workspace', 'rollback-remove-dir-failed', { dir, err: String(err) }),
      );
    } else {
      // Never delete outside the workspace; the record is still removed below.
      log.warn('workspace', 'rollback-dir-outside-workspace', { dir: descriptor.dir });
    }
    const removeRecord = deps.removeProjectRecord ?? removeProjectRecord;
    await removeRecord(descriptor.profile, descriptor.rootDir, descriptor.projectId).catch((err) =>
      log.warn('workspace', 'rollback-remove-record-failed', {
        projectId: descriptor.projectId,
        err: String(err),
      }),
    );
    return;
  }

  if (descriptor.kind === 'codegraph-init') {
    await remove(join(descriptor.dir, '.codegraph')).catch((err) =>
      log.warn('workspace', 'rollback-codegraph-init-failed', {
        dir: descriptor.dir,
        err: String(err),
      }),
    );
    return;
  }

  const unlock = deps.unlock ?? defaultUnlock;
  await unlock(descriptor.dir).catch((err) =>
    log.warn('workspace', 'rollback-codegraph-sync-failed', {
      dir: descriptor.dir,
      err: String(err),
    }),
  );
}

async function removeProjectRecord(
  profile: string,
  rootDir: string | undefined,
  projectId: string,
): Promise<void> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const store = new ProjectStore(appPaths.projectsFile);
  await store.load();
  if (store.remove(projectId)) await store.flush();
}

/** `codegraph unlock` clears a stale index lock left by a killed `sync`. */
async function defaultUnlock(dir: string): Promise<void> {
  const runner = createCodegraphRunner();
  await runner(['unlock', dir], { timeoutMs: 30_000 });
}
