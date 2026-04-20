/**
 * `merge <a> <b> by <path> [--strategy inner|left|right|outer]` — join two
 * lists of records by a key path. The key is extracted from each item via
 * the path (which may be implicit, e.g. `.name`).
 *
 * Conflict rule on field overlap: RIGHT WINS (b's fields override a's).
 * This matches the common "enrichment" pattern where the right side is
 * the smaller supplemental table.
 */

import type { MergeCmd } from "../parser/ast.js";
import { A2EError } from "../errors.js";
import { resolvePath } from "../runtime/evaluate.js";
import type { RuntimeValue, Session } from "../runtime/session.js";

type Record_ = Record<string, RuntimeValue>;

export function runMerge(
  session: Session,
  cmd: MergeCmd,
  left: RuntimeValue,
  right: RuntimeValue,
): Record_[] {
  const l = requireListOfRecords("left", left);
  const r = requireListOfRecords("right", right);
  const keyOf = (item: Record_): RuntimeValue => resolvePath(cmd.byPath, { session, item });
  const rightByKey = new Map<string, Record_>();
  for (const rr of r) rightByKey.set(stableKey(keyOf(rr)), rr);

  switch (cmd.strategy) {
    case "inner": {
      const out: Record_[] = [];
      for (const ll of l) {
        const m = rightByKey.get(stableKey(keyOf(ll)));
        if (m) out.push({ ...ll, ...m });
      }
      return out;
    }
    case "left": {
      return l.map((ll) => {
        const m = rightByKey.get(stableKey(keyOf(ll)));
        return m ? { ...ll, ...m } : { ...ll };
      });
    }
    case "right": {
      const leftByKey = new Map<string, Record_>();
      for (const ll of l) leftByKey.set(stableKey(keyOf(ll)), ll);
      return r.map((rr) => {
        const m = leftByKey.get(stableKey(keyOf(rr)));
        return m ? { ...m, ...rr } : { ...rr };
      });
    }
    case "outer": {
      const leftByKey = new Map<string, Record_>();
      for (const ll of l) leftByKey.set(stableKey(keyOf(ll)), ll);
      const seen = new Set<string>();
      const out: Record_[] = [];
      for (const ll of l) {
        const k = stableKey(keyOf(ll));
        seen.add(k);
        const m = rightByKey.get(k);
        out.push(m ? { ...ll, ...m } : { ...ll });
      }
      for (const rr of r) {
        const k = stableKey(keyOf(rr));
        if (!seen.has(k)) {
          const m = leftByKey.get(k);
          out.push(m ? { ...m, ...rr } : { ...rr });
        }
      }
      return out;
    }
  }
}

function requireListOfRecords(side: string, v: RuntimeValue): Record_[] {
  if (!Array.isArray(v)) {
    throw new A2EError("PARSE_ERROR", `merge: ${side} must be list, got ${typeof v}`);
  }
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item) || Buffer.isBuffer(item)) {
      throw new A2EError("PARSE_ERROR", `merge: ${side} items must be records`);
    }
  }
  return v as Record_[];
}

/** Stringify a join key so Map lookups are reference-independent. */
function stableKey(v: RuntimeValue): string {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return `${typeof v}:${v}`;
  }
  return `json:${JSON.stringify(v)}`;
}
