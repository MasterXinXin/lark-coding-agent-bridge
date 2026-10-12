import { spawnProcessSync } from './spawn';

/**
 * Cross-platform process liveness / termination helpers used to clean up
 * workspace job children (git / codegraph) when a job is cancelled or an
 * earlier bridge process left them orphaned.
 */

/** True when a process with `pid` currently exists (EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform;
  /** POSIX kill; injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows taskkill spawn; injectable for tests. */
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: { windowsHide?: boolean; stdio?: 'ignore' },
  ) => unknown;
}

/**
 * Force-terminate a process and its descendants. On Windows git/codegraph may
 * spawn workers, so `taskkill /T /F` is used to take the whole tree; elsewhere
 * a plain `SIGKILL` suffices. Best-effort: a dead/absent pid is not an error.
 */
export function killProcessTree(pid: number, deps: KillTreeDeps = {}): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const spawnSync = deps.spawnSync ?? spawnProcessSync;
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      // Fall through to a direct kill below.
    }
  }
  const kill = deps.kill ?? ((p, signal) => process.kill(p, signal));
  try {
    kill(pid, 'SIGKILL');
  } catch {
    // Already gone / not permitted — nothing else to do.
  }
}
