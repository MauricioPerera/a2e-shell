/**
 * Sliding-window rate limiter for MCP client calls.
 *
 * One instance per (session, MCP server). Kept in the client closure so it
 * isolates state per connection — 8 MCP servers per session means 8
 * independent limiters with their own windows.
 *
 * Semantics (RFC 002 §5):
 *   - Window is exactly 60 seconds.
 *   - `acquire()` evicts timestamps older than window, then checks count.
 *   - If the live count ≥ rpm, throws `RATE_LIMITED` with the MCP server id
 *     in the message so operators can correlate.
 *   - 0 rpm = disabled (no-op). Allows operators to opt out explicitly.
 *
 * This is CLIENT-SIDE enforcement. The server's own rate limit may be lower
 * or higher; we check our quota first and fail fast before the wire call.
 * A2E's existing session-level `rateLimitPerMinute` runs above this one.
 */

import { A2EError } from "../errors.js";

export interface RateLimiter {
  /**
   * Record a call attempt. Throws RATE_LIMITED if the per-server budget is
   * already exhausted for the current 60s window. Otherwise records the
   * timestamp and returns.
   */
  acquire(): void;
  /** Current live count (for tests). */
  readonly size: number;
}

/**
 * Build a rate limiter. rpm === 0 yields a no-op limiter (disabled).
 */
export function buildRateLimiter(serverId: string, rpm: number): RateLimiter {
  if (rpm === 0) {
    return {
      acquire() { /* no-op */ },
      get size() { return 0; },
    };
  }
  const WINDOW_MS = 60_000;
  const timestamps: number[] = [];
  return {
    acquire() {
      const now = Date.now();
      const cutoff = now - WINDOW_MS;
      // Evict stale entries from the head. Timestamps are monotonic so once
      // we hit one inside the window we can stop.
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length >= rpm) {
        const oldestInWindow = timestamps[0]!;
        const retryAfterMs = Math.max(0, oldestInWindow + WINDOW_MS - now);
        throw new A2EError(
          "RATE_LIMITED",
          `mcp '${serverId}' rate limit ${rpm}/min exceeded (retry in ${Math.ceil(retryAfterMs / 1000)}s)`,
          429,
        );
      }
      timestamps.push(now);
    },
    get size() { return timestamps.length; },
  };
}
