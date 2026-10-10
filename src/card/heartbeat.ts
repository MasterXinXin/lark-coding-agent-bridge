/**
 * Cadence of the running-card spinner heartbeat. Kept in lockstep with the
 * default frame interval in `theme.spinnerFrame` (500ms → one braille frame
 * per tick, a full rotation every 5s).
 */
export const CARD_HEARTBEAT_MS = 500;

/**
 * Invoke `tick` every `intervalMs`, returning a stop function.
 *
 * The Feishu card controller's `update()` is a non-blocking "set desired
 * state" call; the SDK's own Throttle + UpdateQueue coalesce and serialize the
 * actual patches (~2/s here, well under the 10 QPS/card limit). The timer is
 * `unref`'d so a heartbeat never keeps the process alive on its own.
 *
 * Extracted from `channel.ts` so it is unit-testable with fake timers,
 * independent of the SDK.
 */
export function startCardHeartbeat(tick: () => void, intervalMs = CARD_HEARTBEAT_MS): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
