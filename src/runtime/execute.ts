/**
 * Dispatcher: AST Stmt → CanonicalResponse.
 *
 * Flow for one turn:
 *   1. parseProgram(command) → Program (throws A2EError on failure).
 *   2. program.stmts is executed in order. For single-line commands there's
 *      exactly one stmt. For blocks (if/foreach) the single stmt is the block.
 *   3. Each stmt produces one CanonicalResponse. The transcript is updated.
 *
 * Blocks (if/foreach) and the `call` verb are NOT YET IMPLEMENTED in this
 * increment — they return NOT_IMPLEMENTED_V1 so the dispatcher surface is
 * complete and the golden replay harness can start landing tests verb-by-verb.
 */

import type {
  Assignment,
  FilterCmd,
  ForeachBlock,
  IfBlock,
  MergeCmd,
  MetaCall,
  Program,
  SaveCmd,
  Stmt,
  TransformCmd,
  Value,
  VerbCall,
  WaitCmd,
} from "../parser/ast.js";
import { A2EError } from "../errors.js";
import {
  canonicalErr,
  canonicalOk,
  canonicalVoid,
  type CanonicalResponse,
} from "./canonical.js";
import { evalPredicate, evalValue } from "./evaluate.js";
import {
  bind,
  makeBinding,
  recordTurn,
  updateLast,
  type RuntimeValue,
  type Session,
} from "./session.js";
import { runCallCli, runCallHttp } from "../verbs/call.js";
import { runFilter } from "../verbs/filter.js";
import { runMerge } from "../verbs/merge.js";
import { runSave } from "../verbs/save.js";
import { runTransform } from "../verbs/transform.js";
import { runWait } from "../verbs/wait.js";
import { runDescribe } from "../meta/describe.js";
import { runEnv } from "../meta/env.js";
import { runHead } from "../meta/head.js";
import { runHelp } from "../meta/help.js";
import { runHistory } from "../meta/history.js";
import { runShow } from "../meta/show.js";

/**
 * Execute a pre-parsed Program against a session. Returns ONE canonical
 * response per stmt (usually a 1-element array for non-block inputs). Errors
 * during a stmt are captured into canonicalErr; the function never throws.
 */
export async function executeProgram(
  session: Session,
  source: string,
  program: Program,
): Promise<CanonicalResponse[]> {
  const out: CanonicalResponse[] = [];
  for (const stmt of program.stmts) {
    const started = Date.now();
    let response: CanonicalResponse;
    try {
      response = await executeStmt(session, stmt, started);
    } catch (e) {
      response = e instanceof A2EError
        ? canonicalErr({ code: e.code, message: e.message })
        : canonicalErr({ code: "INTERNAL", message: (e as Error).message });
    }
    recordTurn(session, {
      command: source,
      stmt,
      statusLine: response.status_line,
      binding: response.binding,
      error: response.error,
      durationMs: Date.now() - started,
    });
    out.push(response);
  }
  return out;
}

// -- per-stmt dispatch -------------------------------------------------------

async function executeStmt(
  session: Session,
  stmt: Stmt,
  started: number,
): Promise<CanonicalResponse> {
  if (stmt.kind === "assignment") {
    return executeAssignment(session, stmt as Assignment, started);
  }
  if (stmt.kind === "if") {
    return executeIfBlock(session, stmt as IfBlock, started);
  }
  if (stmt.kind === "foreach") {
    return executeForeachBlock(session, stmt as ForeachBlock, started);
  }
  return executeCommand(session, stmt, null, started);
}

// -- block dispatch ----------------------------------------------------------

async function executeIfBlock(
  session: Session,
  block: IfBlock,
  started: number,
): Promise<CanonicalResponse> {
  const cond = evalPredicate(block.predicate, { session });
  const branch = cond ? block.thenBody : (block.elseBody ?? []);
  for (const stmt of branch) {
    // Body stmts run for side effects. Errors propagate (no catch-and-continue
    // here). Block-level bindings persist in session.
    await executeStmt(session, stmt, Date.now());
  }
  const tag = `branch:${cond ? "then" : "else"}`;
  updateLast(session, makeBinding(tag));
  return canonicalOk({
    verb: "if",
    value: tag,
    binding: null,
    durationMs: Date.now() - started,
  });
}

/**
 * `foreach $item in <list> [--parallel=N] [--on-error=abort|continue] do ... end`.
 *
 * v0.1 semantics:
 *   - `--parallel=N` is ACCEPTED but executes sequentially. The flag is
 *     validated + stored on the AST; concurrent execution is deferred until
 *     evalValue supports per-iteration scopes (would need to shadow the item
 *     binding per task).
 *   - `--on-error=continue` catches errors inside the body and records them
 *     on the iteration record; `abort` (default) propagates the first error.
 *
 * Return value: list of `{iteration, last_verb, last_binding, error?}` records.
 */
async function executeForeachBlock(
  session: Session,
  block: ForeachBlock,
  started: number,
): Promise<CanonicalResponse> {
  const list = evalValue(block.list, { session });
  if (!Array.isArray(list)) {
    throw new A2EError("PARSE_ERROR", `foreach: target must be list, got ${typeof list}`);
  }

  // Stash any existing binding for the iteration variable; restore at end.
  const stashed = session.bindings.get(block.itemVar);
  const results: Record<string, RuntimeValue>[] = [];

  try {
    for (let i = 0; i < list.length; i++) {
      const item = list[i] as RuntimeValue;
      bind(session, block.itemVar, makeBinding(item));
      let lastVerb = "?";
      let lastBinding: string | null = null;
      let errorCode: string | null = null;
      for (const stmt of block.body) {
        try {
          const r = await executeStmt(session, stmt, Date.now());
          if (r.error) {
            errorCode = r.error.code;
            if (block.onError === "abort") {
              throw new A2EError(r.error.code as never, r.error.message);
            }
            break;
          }
          lastVerb = verbNameOf(stmt);
          lastBinding = r.binding;
        } catch (e) {
          if (block.onError === "abort") throw e;
          errorCode = e instanceof A2EError ? e.code : "INTERNAL";
          break;
        }
      }
      const record: Record<string, RuntimeValue> = {
        iteration: i,
        last_verb: lastVerb,
        last_binding: lastBinding,
      };
      if (errorCode !== null) record.error_code = errorCode;
      results.push(record);
    }
  } finally {
    if (stashed !== undefined) session.bindings.set(block.itemVar, stashed);
    else session.bindings.delete(block.itemVar);
  }

  updateLast(session, makeBinding(results));
  return canonicalOk({
    verb: "foreach",
    value: results,
    binding: null,
    durationMs: Date.now() - started,
  });
}

function verbNameOf(stmt: Stmt): string {
  if (stmt.kind === "assignment") return verbNameOf(stmt.rhs as Stmt);
  if (stmt.kind === "call-http" || stmt.kind === "call-cli") return "call";
  return stmt.kind;
}

async function executeAssignment(
  session: Session,
  stmt: Assignment,
  started: number,
): Promise<CanonicalResponse> {
  // Evaluate RHS; bind its value under stmt.target.
  const response = await executeCommand(session, stmt.rhs, stmt.target, started);
  return response;
}

/**
 * Execute a non-block command (verb or meta). If `bindingName` is provided,
 * and the command produces a value, the value is bound to that name BEFORE
 * the canonical response is built (so its `binding` field reflects the write).
 */
async function executeCommand(
  session: Session,
  cmd: Stmt,
  bindingName: string | null,
  started: number,
): Promise<CanonicalResponse> {
  // Block commands already handled upstream; at this point cmd is verb or meta.
  if (isMeta(cmd)) return executeMeta(session, cmd as MetaCall, started);
  if (isVerb(cmd)) return executeVerb(session, cmd as VerbCall, bindingName, started);
  throw new A2EError("PARSE_ERROR", `unsupported stmt kind: ${(cmd as Stmt).kind}`);
}

async function executeVerb(
  session: Session,
  verb: VerbCall,
  bindingName: string | null,
  started: number,
): Promise<CanonicalResponse> {
  switch (verb.kind) {
    case "call-http": {
      const value = await runCallHttp(session, verb);
      return finishAndBind(session, "call", value, bindingName, started);
    }
    case "call-cli": {
      const value = await runCallCli(session, verb);
      return finishAndBind(session, "call", value, bindingName, started);
    }

    case "wait": {
      await runWait(verb as WaitCmd);
      return canonicalVoid({ verb: "wait", durationMs: Date.now() - started });
    }

    case "filter": {
      const cmd = verb as FilterCmd;
      const target = evalValue(cmd.target, { session });
      const value = runFilter(session, cmd, target);
      return finishAndBind(session, "filter", value, bindingName, started);
    }

    case "transform": {
      const cmd = verb as TransformCmd;
      const target = evalValue(cmd.target, { session });
      const value = runTransform(session, cmd, target);
      return finishAndBind(session, "transform", value, bindingName, started);
    }

    case "save": {
      const cmd = verb as SaveCmd;
      const target = evalValue(cmd.target, { session });
      const resolvedName = cmd.as; // grammar hands us the bare name (may include chars from interp in v0.2)
      const { name, value } = runSave(session, cmd, target, resolvedName);
      // save's canonical binding reports the save target, not the assignment lhs.
      updateLast(session, makeBinding(value));
      const res = canonicalOk({ verb: "save", value, binding: name, durationMs: Date.now() - started });
      // If the outer stmt was `$x = save ...`, also write $x.
      if (bindingName && bindingName !== name) {
        session.bindings.set(bindingName, makeBinding(value));
      }
      return res;
    }

    case "merge": {
      const cmd = verb as MergeCmd;
      const left = evalValue(cmd.left as Value, { session });
      const right = evalValue(cmd.right as Value, { session });
      const value = runMerge(session, cmd, left, right);
      return finishAndBind(session, "merge", value, bindingName, started);
    }
  }
}

async function executeMeta(
  session: Session,
  meta: MetaCall,
  started: number,
): Promise<CanonicalResponse> {
  switch (meta.kind) {
    case "describe": {
      const target = evalValue(meta.target, { session });
      const value = runDescribe(target);
      updateLast(session, makeBinding(value));
      return canonicalOk({ verb: "describe", value, binding: null, durationMs: Date.now() - started });
    }
    case "head": {
      const target = evalValue(meta.target, { session });
      const value = runHead(target, meta.n);
      updateLast(session, makeBinding(value));
      return canonicalOk({ verb: "head", value, binding: null, durationMs: Date.now() - started });
    }
    case "show": {
      const value = runShow(evalValue(meta.target, { session }));
      updateLast(session, makeBinding(value));
      // `show` intentionally skips the preview-truncation budget: the response
      // size cap at the HTTP layer is the real guard.
      const res = canonicalOk({ verb: "show", value, binding: null, durationMs: Date.now() - started });
      const full = JSON.stringify(value);
      if (full !== undefined) {
        res.preview = full;
        res.truncated = false;
        res.shape.bytes = Buffer.byteLength(full, "utf8");
      }
      return res;
    }
    case "env": {
      const value = runEnv(session);
      updateLast(session, makeBinding(value));
      return canonicalOk({ verb: "env", value, binding: null, durationMs: Date.now() - started });
    }
    case "history": {
      const value = runHistory(session, meta.n);
      updateLast(session, makeBinding(value));
      return canonicalOk({ verb: "history", value, binding: null, durationMs: Date.now() - started });
    }
    case "help": {
      const value = runHelp(meta.topic);
      updateLast(session, makeBinding(value));
      return canonicalOk({ verb: "help", value, binding: null, durationMs: Date.now() - started });
    }
  }
}

function finishAndBind(
  session: Session,
  verbName: string,
  value: RuntimeValue,
  bindingName: string | null,
  started: number,
): CanonicalResponse {
  updateLast(session, makeBinding(value));
  if (bindingName !== null) {
    session.bindings.set(bindingName, makeBinding(value));
  }
  return canonicalOk({
    verb: verbName,
    value,
    binding: bindingName !== null ? bindingName : null,
    durationMs: Date.now() - started,
  });
}

// -- discriminators ----------------------------------------------------------

const VERB_KINDS = new Set([
  "call-http", "call-cli",
  "filter", "transform", "save", "wait", "merge",
]);
const META_KINDS = new Set([
  "describe", "head", "show", "env", "history", "help",
]);

function isVerb(s: Stmt): boolean { return VERB_KINDS.has(s.kind); }
function isMeta(s: Stmt): boolean { return META_KINDS.has(s.kind); }
