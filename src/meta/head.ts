/**
 * `head $x [N]` — return the first N items of a list, or the first N chars
 * of a string, or the target unchanged for scalars/records.
 *
 * Default N = 5 (enforced by grammar).
 */

import type { RuntimeValue } from "../runtime/session.js";

export function runHead(target: RuntimeValue, n: number): RuntimeValue {
  if (Array.isArray(target)) return target.slice(0, Math.max(0, n));
  if (typeof target === "string") return target.slice(0, Math.max(0, n));
  if (Buffer.isBuffer(target)) return target.subarray(0, Math.max(0, n));
  // Scalars, nulls, records: head is a no-op — the describe-preview already
  // bounds their surface.
  return target;
}
