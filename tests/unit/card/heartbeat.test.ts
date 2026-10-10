import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_HEARTBEAT_MS, startCardHeartbeat } from '../../../src/card/heartbeat.js';

describe('card heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the configured interval', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick, 500);

    vi.advanceTimersByTime(499);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stops ticking after the stop function runs', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick, 500);

    vi.advanceTimersByTime(500);
    stop();
    vi.advanceTimersByTime(5_000);

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('defaults to CARD_HEARTBEAT_MS', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startCardHeartbeat(tick);

    vi.advanceTimersByTime(CARD_HEARTBEAT_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);

    stop();
  });
});
