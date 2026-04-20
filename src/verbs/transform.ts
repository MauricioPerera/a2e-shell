/**
 * `transform <value> <op>` — pure data transform. Operates on either a single
 * record or a list of records. The five variants:
 *
 *   pick f1,f2,...     → keep only named fields
 *   omit f1,f2,...     → drop named fields, keep the rest
 *   rename a=b,c=d     → rename fields
 *   set   f=v,g=w      → overwrite / add fields
 *   map   {k: <value>} → project each record to an object literal (shape only;
 *                         variable refs inside the template resolve against the
 *                         current item as if root were "")
 */

import type { ObjectLit, TransformCmd, Value } from "../parser/ast.js";
import { A2EError } from "../errors.js";
import { evalValue } from "../runtime/evaluate.js";
import type { RuntimeValue, Session } from "../runtime/session.js";

type Record_ = Record<string, RuntimeValue>;

export function runTransform(
  session: Session,
  cmd: TransformCmd,
  target: RuntimeValue,
): RuntimeValue {
  // Decide singular vs plural. Both supported; output shape mirrors input.
  if (Array.isArray(target)) {
    return target.map((item) => applyOp(session, cmd, item));
  }
  return applyOp(session, cmd, target);
}

function applyOp(session: Session, cmd: TransformCmd, item: RuntimeValue): Record_ {
  const rec = requireRecord(item);
  const op = cmd.op;
  switch (op.kind) {
    case "pick": {
      const out: Record_ = {};
      for (const f of op.fields) {
        if (f in rec) out[f] = rec[f] as RuntimeValue;
      }
      return out;
    }
    case "omit": {
      const drop = new Set(op.fields);
      const out: Record_ = {};
      for (const [k, v] of Object.entries(rec)) if (!drop.has(k)) out[k] = v;
      return out;
    }
    case "rename": {
      const mapping = new Map(op.pairs.map((p) => [p.from, p.to]));
      const out: Record_ = {};
      for (const [k, v] of Object.entries(rec)) {
        const renamed = mapping.get(k);
        out[renamed ?? k] = v;
      }
      return out;
    }
    case "set": {
      const out: Record_ = { ...rec };
      for (const pair of op.pairs) {
        out[pair.field] = evalValue(pair.value as Value, { session, item });
      }
      return out;
    }
    case "map": {
      return projectTemplate(session, op.template, item);
    }
  }
}

function projectTemplate(session: Session, tpl: ObjectLit, item: RuntimeValue): Record_ {
  const out: Record_ = {};
  for (const pair of tpl.pairs) {
    out[pair.key] = evalValue(pair.value, { session, item });
  }
  return out;
}

function requireRecord(v: RuntimeValue): Record_ {
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Buffer.isBuffer(v)
  ) {
    throw new A2EError(
      "PARSE_ERROR",
      `transform: target item must be a record, got ${describeType(v)}`,
    );
  }
  return v as Record_;
}

function describeType(v: RuntimeValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (Buffer.isBuffer(v)) return "bytes";
  return typeof v;
}
