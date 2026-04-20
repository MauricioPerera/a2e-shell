/**
 * `env` — report session scope (variable NAMES only, never env values). The
 * returned record has two lists:
 *   bindings: sorted variable names currently in scope (excluding `_`)
 *   env_overlay_keys: names of session env overlay (always empty in bounded
 *     mode v0.1 — the session env is not exposed to the LLM at all).
 *
 * Expired TTL bindings are swept before listing.
 */

import { sweepExpired, type RuntimeValue, type Session } from "../runtime/session.js";

export function runEnv(session: Session): Record<string, RuntimeValue> {
  sweepExpired(session);
  const bindings = [...session.bindings.keys()].sort();
  return {
    bindings,
    env_overlay_keys: [],
  };
}
