/**
 * Runtime wrapper around the peggy-compiled bounded-verb grammar.
 *
 * Responsibilities layered on top of raw peggy parsing:
 *   1. Pre-parse: MAX_LINE_LENGTH (R7) rejected before compilation.
 *   2. Parse: delegate to peggy-compiled parser.
 *   3. Post-parse:
 *        - R5: reject `$_` as assignment target (walks stmts).
 *        - R7: walk AST, reject if block depth > MAX_BLOCK_DEPTH.
 *   4. Error mapping: INTERP_REJECTED (from grammar) → A2EError
 *        INTERPOLATION_REJECTED; everything else → A2EError PARSE_ERROR.
 *
 * Why post-parse for R5/R7: keeping the grammar free of semantic predicates
 * simplifies it and avoids peggy-version-specific quirks. The depth walker
 * is O(stmts) and runs only on successful parses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "peggy";
import type {
  Assignment,
  ForeachBlock,
  IfBlock,
  Program,
  Stmt,
} from "./ast.js";
import { A2EError } from "../errors.js";

const MAX_LINE_LENGTH = 4096;
const MAX_BLOCK_DEPTH = 4;

// Load + compile the grammar once. In ESM the relative path resolves against
// this module's URL, which works in both `tsx` (tests) and compiled `dist/`
// if grammar.pegjs is copied on build.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grammarSource = fs.readFileSync(
  path.join(__dirname, "grammar.pegjs"),
  "utf8",
);

const compiled = generate(grammarSource);

interface PeggyError extends Error {
  message: string;
  location?: { start?: { line: number; column: number; offset: number } };
}

/**
 * Parse a complete bounded-shell source (one turn's `command` payload).
 * Returns a Program AST. Throws A2EError on failure.
 */
export function parseProgram(source: string): Program {
  if (source.length > MAX_LINE_LENGTH) {
    throw new A2EError(
      "PARSE_ERROR",
      `MAX_LINE_LENGTH=${MAX_LINE_LENGTH} exceeded (R7): got ${source.length} chars`,
    );
  }

  let program: Program;
  try {
    program = compiled.parse(source) as Program;
  } catch (e) {
    throw classifyError(e as PeggyError);
  }

  // Post-parse structural validations.
  checkReservedAssignment(program);
  checkBlockDepth(program);
  return program;
}

// -- post-parse walks --------------------------------------------------------

function checkReservedAssignment(program: Program): void {
  walkStmts(program.stmts, (stmt) => {
    if (stmt.kind === "assignment" && (stmt as Assignment).target === "_") {
      throw new A2EError(
        "SCOPE_MISS",
        "'$_' is reserved for implicit last-result binding (R5)",
      );
    }
  });
}

function checkBlockDepth(program: Program): void {
  const walk = (stmts: Stmt[], depth: number): void => {
    if (depth > MAX_BLOCK_DEPTH) {
      throw new A2EError(
        "PARSE_ERROR",
        `MAX_BLOCK_DEPTH=${MAX_BLOCK_DEPTH} exceeded (R7)`,
      );
    }
    for (const stmt of stmts) {
      if (stmt.kind === "if") {
        const b = stmt as IfBlock;
        walk(b.thenBody, depth + 1);
        if (b.elseBody) walk(b.elseBody, depth + 1);
      } else if (stmt.kind === "foreach") {
        walk((stmt as ForeachBlock).body, depth + 1);
      }
    }
  };
  walk(program.stmts, 1);
}

function walkStmts(stmts: Stmt[], visit: (s: Stmt) => void): void {
  for (const stmt of stmts) {
    visit(stmt);
    if (stmt.kind === "if") {
      const b = stmt as IfBlock;
      walkStmts(b.thenBody, visit);
      if (b.elseBody) walkStmts(b.elseBody, visit);
    } else if (stmt.kind === "foreach") {
      walkStmts((stmt as ForeachBlock).body, visit);
    }
  }
}

// -- error classification ----------------------------------------------------

function classifyError(err: PeggyError): A2EError {
  const msg = err.message ?? String(err);

  const interpMatch = msg.match(/INTERP_REJECTED:([^"\n]*)/);
  if (interpMatch) {
    return new A2EError(
      "INTERPOLATION_REJECTED",
      `interpolation must match path regex (R2); got '${interpMatch[1]}'`,
    );
  }

  const loc = err.location?.start;
  const where = loc ? ` at line ${loc.line} col ${loc.column}` : "";
  return new A2EError("PARSE_ERROR", `${msg}${where}`);
}
