/**
 * `show $x` — the ONLY command that dumps a value without preview truncation.
 * The dispatcher treats `show` specially: it bypasses buildPreview() and
 * renders the full JSON in `preview` regardless of size. (Still subject to
 * the outer HTTP response-size cap.)
 *
 * This module only extracts the value; the size-bypass happens in
 * src/runtime/execute.ts when it sees kind==="show".
 */

import type { RuntimeValue } from "../runtime/session.js";

export function runShow(target: RuntimeValue): RuntimeValue {
  return target;
}
