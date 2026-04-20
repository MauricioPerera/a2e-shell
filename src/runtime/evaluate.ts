/**
 * Value + predicate evaluation.
 *
 * Reduces an AST Value or Predicate to a RuntimeValue (or boolean) using the
 * current session's bindings for variable resolution. Interpolated strings
 * are assembled here. Field-paths with empty root ("") are resolved against
 * an explicit `ctx.item` (used inside predicates and `merge by`).
 */

import type {
  InterpStr,
  ListLit,
  Literal,
  ObjectLit,
  Operand,
  PathRef,
  PathStep,
  Predicate,
  PredAtom,
  Value,
} from "../parser/ast.js";
import { A2EError } from "../errors.js";
import { lookup, type RuntimeValue, type Session } from "./session.js";

export interface EvalCtx {
  session: Session;
  /** Implicit item for field-paths with empty root. Used in predicates / merge. */
  item?: RuntimeValue;
}

// --- value evaluation -------------------------------------------------------

export function evalValue(v: Value, ctx: EvalCtx): RuntimeValue {
  switch (v.kind) {
    case "string":     return v.value;
    case "number":     return v.value;
    case "bool":       return v.value;
    case "null":       return null;
    case "duration":   return v.ms;
    case "list":       return (v as ListLit).items.map((it) => evalValue(it, ctx));
    case "object": {
      const obj: Record<string, RuntimeValue> = {};
      for (const pair of (v as ObjectLit).pairs) obj[pair.key] = evalValue(pair.value, ctx);
      return obj;
    }
    case "var": {
      const b = lookup(ctx.session, v.name);
      if (!b) throw unboundVar(v.name);
      return b.value;
    }
    case "path":       return resolvePath(v as PathRef, ctx);
    case "interpString": return resolveInterp(v as InterpStr, ctx);
    default: {
      const exhaustive: never = v;
      throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Resolve a PathRef. `root === ""` means implicit (use ctx.item).
 * Missing fields along the chain throw SCOPE_MISS.
 */
export function resolvePath(path: PathRef, ctx: EvalCtx): RuntimeValue {
  let current: RuntimeValue;
  if (path.root === "") {
    if (ctx.item === undefined) throw noImplicitItem();
    current = ctx.item;
  } else {
    const b = lookup(ctx.session, path.root);
    if (!b) throw unboundVar(path.root);
    current = b.value;
  }
  for (const step of path.steps) {
    current = stepInto(current, step, path);
  }
  return current;
}

function stepInto(current: RuntimeValue, step: PathStep, path: PathRef): RuntimeValue {
  if (step.kind === "field") {
    if (current === null || typeof current !== "object" || Array.isArray(current) || Buffer.isBuffer(current)) {
      throw new A2EError("SCOPE_MISS", `path '${formatPath(path)}': field access on non-record at '.${step.name}'`);
    }
    if (!(step.name in current)) {
      throw new A2EError("SCOPE_MISS", `path '${formatPath(path)}': missing field '.${step.name}'`);
    }
    return (current as Record<string, RuntimeValue>)[step.name] as RuntimeValue;
  }
  // index step
  if (!Array.isArray(current)) {
    throw new A2EError("SCOPE_MISS", `path '${formatPath(path)}': index access on non-list at '[${step.index}]'`);
  }
  if (step.index >= current.length) {
    throw new A2EError("SCOPE_MISS", `path '${formatPath(path)}': index '[${step.index}]' out of bounds (rows=${current.length})`);
  }
  return current[step.index] as RuntimeValue;
}

function formatPath(path: PathRef): string {
  const root = path.root === "" ? "" : `$${path.root}`;
  return root + path.steps.map((s) =>
    s.kind === "field" ? `.${s.name}` : `[${s.index}]`,
  ).join("");
}

function resolveInterp(str: InterpStr, ctx: EvalCtx): string {
  const parts: string[] = [];
  for (const seg of str.segments) {
    if (seg.kind === "literal") parts.push(seg.text);
    else {
      const v = resolvePath(seg.path, ctx);
      parts.push(stringifyForInterp(v));
    }
  }
  return parts.join("");
}

function stringifyForInterp(v: RuntimeValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Buffer.isBuffer(v)) {
    throw new A2EError("INTERPOLATION_REJECTED", "cannot interpolate bytes into a string");
  }
  // Objects/arrays: compact JSON. Keeps things predictable for URL templates.
  return JSON.stringify(v);
}

// --- predicate evaluation ---------------------------------------------------

export function evalPredicate(pred: Predicate, ctx: EvalCtx): boolean {
  switch (pred.kind) {
    case "and": return evalPredicate(pred.left, ctx) && evalPredicate(pred.right, ctx);
    case "or":  return evalPredicate(pred.left, ctx) || evalPredicate(pred.right, ctx);
    case "not": return !evalPredicate(pred.inner, ctx);
    case "cmp":
    case "in":
    case "matches":
    case "exists":
      return evalAtom(pred, ctx);
    default: {
      const exhaustive: never = pred;
      throw new Error(`unreachable predicate: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function evalAtom(atom: PredAtom, ctx: EvalCtx): boolean {
  switch (atom.kind) {
    case "cmp": {
      const l = evalOperand(atom.left, ctx);
      const r = evalOperand(atom.right, ctx);
      return compare(l, r, atom.op);
    }
    case "in": {
      const l = evalOperand(atom.left, ctx);
      const list = atom.list.items.map((v) => evalValue(v, ctx));
      return list.some((item) => jsEq(item, l));
    }
    case "matches": {
      const l = evalOperand(atom.left, ctx);
      if (typeof l !== "string") return false;
      let re: RegExp;
      try {
        re = new RegExp(atom.regex);
      } catch {
        throw new A2EError("PARSE_ERROR", `invalid regex in matches: /${atom.regex}/`);
      }
      return re.test(l);
    }
    case "exists": {
      try {
        evalOperand(atom.left, ctx);
        return true;
      } catch (e) {
        if (e instanceof A2EError && e.code === "SCOPE_MISS") return false;
        throw e;
      }
    }
  }
}

function evalOperand(op: Operand, ctx: EvalCtx): RuntimeValue {
  // Operand in the grammar is FieldPath / PathRef / Value. All three are
  // Value-shaped (FieldPath is a PathRef with root="").
  return evalValue(op as Value, ctx);
}

function compare(l: RuntimeValue, r: RuntimeValue, op: "==" | "!=" | ">" | ">=" | "<" | "<="): boolean {
  if (op === "==") return jsEq(l, r);
  if (op === "!=") return !jsEq(l, r);
  // Ordered comparisons: numeric or lexicographic on strings.
  if (typeof l !== typeof r) return false;
  if (typeof l === "number" && typeof r === "number") {
    if (op === ">")  return l > r;
    if (op === ">=") return l >= r;
    if (op === "<")  return l < r;
    return l <= r;
  }
  if (typeof l === "string" && typeof r === "string") {
    const cmp = l < r ? -1 : l > r ? 1 : 0;
    if (op === ">")  return cmp > 0;
    if (op === ">=") return cmp >= 0;
    if (op === "<")  return cmp < 0;
    return cmp <= 0;
  }
  return false;
}

function jsEq(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsEq(v, b[i] as RuntimeValue));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, RuntimeValue>);
    const bk = Object.keys(b as Record<string, RuntimeValue>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      jsEq(
        (a as Record<string, RuntimeValue>)[k] as RuntimeValue,
        (b as Record<string, RuntimeValue>)[k] as RuntimeValue,
      ),
    );
  }
  return false;
}

// --- helpers ----------------------------------------------------------------

function unboundVar(name: string): A2EError {
  return new A2EError("SCOPE_MISS", `variable '$${name}' not bound in session scope`);
}

function noImplicitItem(): A2EError {
  return new A2EError(
    "SCOPE_MISS",
    "implicit field path (starting with '.') has no item context here",
  );
}

// Used by transform/merge to normalise a Literal-only list without session.
export function evalLiteral(lit: Literal): RuntimeValue {
  return evalValue(lit, { session: null as unknown as Session });
}
