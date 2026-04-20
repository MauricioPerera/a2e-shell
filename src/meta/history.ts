/**
 * `history [N]` — last N transcript entries as a compact list of records.
 * Default N = 10 (enforced by grammar). The verb name is inferred from the
 * AST kind stored on the transcript entry.
 */

import type { RuntimeValue, Session } from "../runtime/session.js";
import type { Stmt } from "../parser/ast.js";

export function runHistory(session: Session, n: number): Record<string, RuntimeValue>[] {
  const slice = session.transcript.slice(-Math.max(0, n));
  return slice.map((entry) => ({
    t: entry.t,
    verb: verbOf(entry.stmt),
    status: entry.error ? "ERR" : "OK",
    binding: entry.binding,
    ...(entry.error ? { error_code: entry.error.code } : {}),
  }));
}

function verbOf(stmt: Stmt | null): string {
  if (!stmt) return "?";
  if (stmt.kind === "assignment") {
    return verbOf(stmt.rhs as Stmt);
  }
  // Strip the "call-http" / "call-cli" prefix suffix noise for readability.
  if (stmt.kind === "call-http" || stmt.kind === "call-cli") return "call";
  return stmt.kind;
}
