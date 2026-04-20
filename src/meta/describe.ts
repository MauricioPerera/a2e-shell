/**
 * `describe $x` — return a compact structural description of the target.
 * Output is itself a record so its own canonical preview fits in ≤512B.
 */

import { inferShape } from "../runtime/canonical.js";
import type { RuntimeValue } from "../runtime/session.js";

export function runDescribe(target: RuntimeValue): Record<string, RuntimeValue> {
  const shape = inferShape(target);
  const out: Record<string, RuntimeValue> = {
    kind: shape.kind,
    bytes: shape.bytes,
  };
  if (shape.rows !== undefined) out.rows = shape.rows;
  if (shape.cols !== undefined) out.cols = shape.cols;
  if (shape.keys !== undefined) out.item_keys = shape.keys;
  return out;
}
