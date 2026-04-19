/**
 * Server lifecycle: request in-flight tracking + drain state machine.
 *
 * States:
 *   - `accepting` (default): middleware tracks in-flight, no rejections.
 *   - `draining`: new mutating ops (POST /sessions, POST /exec, PATCH) return
 *     503 Retry-After; reads (GET /state, /transcript) still pass so ongoing
 *     callers can observe the shutdown. In-flight ops continue.
 *   - `stopped`: set after waitForDrain completes; http server is closed next.
 *
 * Never call beginDrain() twice; the transition is one-way per process.
 */

import { A2EError } from "../errors.js";
import { logger } from "../logging/logger.js";

export type LifecycleState = "accepting" | "draining" | "stopped";

export interface Lifecycle {
  state(): LifecycleState;
  inFlight(): number;
  /** Called at request entry. Throws 503 if draining AND the path mutates. */
  checkAndIncrement(method: string, path: string): void;
  decrement(): void;
  beginDrain(): void;
  /** Resolve when inFlight reaches 0 or timeout elapses. Returns true if drained cleanly. */
  waitForDrain(timeoutMs: number): Promise<boolean>;
}

const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);
/** Paths that are safe to serve during drain regardless of method. */
const ALWAYS_SAFE_PATHS = new Set(["/healthz", "/metrics"]);

export function createLifecycle(): Lifecycle {
  let current: LifecycleState = "accepting";
  let count = 0;
  let drainResolvers: Array<() => void> = [];

  function notifyIfIdle(): void {
    if (count === 0 && current === "draining") {
      const r = drainResolvers;
      drainResolvers = [];
      for (const fn of r) fn();
    }
  }

  return {
    state: () => current,
    inFlight: () => count,

    checkAndIncrement(method, path) {
      // Reject mutating ops whenever we're NOT accepting. That covers both
      // the drain window AND the brief interval after waitForDrain transitions
      // to "stopped" but before the HTTP socket is actually closed.
      if (current !== "accepting" && MUTATING_METHODS.has(method) && !ALWAYS_SAFE_PATHS.has(path)) {
        throw new A2EError(
          "SERVICE_UNAVAILABLE",
          "server is draining; retry later",
          503,
        );
      }
      count++;
    },

    decrement() {
      count--;
      notifyIfIdle();
    },

    beginDrain() {
      if (current !== "accepting") return;
      current = "draining";
      logger.info({ event: "server.draining", in_flight: count });
      notifyIfIdle();
    },

    async waitForDrain(timeoutMs) {
      if (count === 0) {
        // Fast path: no in-flight. Still transition state so callers can
        // distinguish a drained server from an accepting one.
        if (current === "draining") current = "stopped";
        return true;
      }
      return new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          logger.warn({ event: "server.drain.timeout", in_flight: count, timeout_ms: timeoutMs });
          resolve(false);
        }, timeoutMs);
        drainResolvers.push(() => {
          clearTimeout(t);
          current = "stopped";
          resolve(true);
        });
      });
    },
  };
}
