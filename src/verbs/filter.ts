/**
 * `filter <list> where <predicate>` — keeps only items for which the predicate
 * is true. Input MUST be a list. Empty list returns empty list.
 */

import type { FilterCmd } from "../parser/ast.js";
import { A2EError } from "../errors.js";
import { evalPredicate } from "../runtime/evaluate.js";
import type { RuntimeValue, Session } from "../runtime/session.js";

export function runFilter(
  session: Session,
  cmd: FilterCmd,
  target: RuntimeValue,
): RuntimeValue[] {
  if (!Array.isArray(target)) {
    throw new A2EError(
      "PARSE_ERROR",
      `filter: target must be list, got ${describeType(target)}`,
    );
  }
  const out: RuntimeValue[] = [];
  for (const item of target) {
    if (evalPredicate(cmd.predicate, { session, item })) {
      out.push(item);
    }
  }
  return out;
}

function describeType(v: RuntimeValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (Buffer.isBuffer(v)) return "bytes";
  return typeof v;
}
