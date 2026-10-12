import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive, killProcessTree } from '../../../src/platform/process-kill';

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for invalid / obviously absent pids', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    // 2^31-ish is far above any real pid on this machine.
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});

describe('killProcessTree', () => {
  it('uses taskkill /T /F on win32', () => {
    const spawnSync = vi.fn();
    const kill = vi.fn();
    killProcessTree(4242, { platform: 'win32', spawnSync, kill });
    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to SIGKILL when taskkill throws', () => {
    const spawnSync = vi.fn(() => {
      throw new Error('boom');
    });
    const kill = vi.fn();
    killProcessTree(99, { platform: 'win32', spawnSync, kill });
    expect(kill).toHaveBeenCalledWith(99, 'SIGKILL');
  });

  it('sends SIGKILL on POSIX', () => {
    const kill = vi.fn();
    const spawnSync = vi.fn();
    killProcessTree(7, { platform: 'linux', kill, spawnSync });
    expect(kill).toHaveBeenCalledWith(7, 'SIGKILL');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('never targets the current process and tolerates a dead pid', () => {
    const kill = vi.fn();
    killProcessTree(process.pid, { platform: 'linux', kill });
    expect(kill).not.toHaveBeenCalled();

    killProcessTree(123, {
      platform: 'linux',
      kill: () => {
        throw new Error('ESRCH');
      },
    });
    // No throw escapes.
    expect(true).toBe(true);
  });
});
