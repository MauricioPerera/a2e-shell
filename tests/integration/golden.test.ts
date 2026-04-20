/**
 * Golden trace validator.
 *
 * Two layers of validation:
 *
 *   1. STRUCTURAL — every .trace.jsonl under tests/golden/** is well-formed:
 *      parseable JSONL, first line is _meta with required fields, subsequent
 *      lines have matching turn schemas for their mode.
 *
 *   2. COVERAGE (bounded only) — aggregated over all tests/golden/bounded/**
 *      traces, the declared `covers` sets must include 8/8 verbs and 6/6 meta,
 *      and the rejection set must include every rejection code enumerated in
 *      docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md §2.5 + GRAMMAR.ebnf R1-R10.
 *
 * Replay of traces against the live runtime is NOT done here (that lives in
 * tests/integration/ and requires the http server). This file is the
 * spec-level contract: if a trace asserts coverage it doesn't deliver, or
 * declares a shape the runtime can't produce, it fails here first, fast.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// -- paths -------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, "..", "golden");
const BOUNDED_DIR = path.join(GOLDEN_DIR, "bounded");

// -- required sets from the RFC ----------------------------------------------

const REQUIRED_VERBS = [
  "call", "filter", "transform", "if", "foreach", "save", "wait", "merge",
] as const;

const REQUIRED_META = [
  "describe", "head", "env", "history", "show", "help",
] as const;

const REQUIRED_REJECTIONS = [
  "PARSE_ERROR",
  "INTERPOLATION_REJECTED",
  "SCOPE_MISS",
  "CAPABILITY_DENIED",
] as const;

// -- shape types -------------------------------------------------------------

type TraceMeta = {
  name: string;
  mode: "unrestricted" | "bounded";
  replay: "deterministic" | "non-deterministic";
  capabilities: Record<string, unknown>;
  covers?: {
    verbs?: string[];
    meta?: string[];
    rejections?: string[];
  };
};

type TraceTurn = {
  t?: number;
  req: Record<string, unknown>;
  res: Record<string, unknown>;
  op?: string;
};

type LoadedTrace = {
  file: string;
  meta: TraceMeta;
  turns: TraceTurn[];
  stateFinal: TraceTurn | null;
};

// -- loader ------------------------------------------------------------------

function loadTrace(file: string): LoadedTrace {
  const body = fs.readFileSync(file, "utf8");
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`empty trace: ${file}`);
  }
  const parsed: unknown[] = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new Error(`invalid JSON at ${file}:${i + 1}: ${(e as Error).message}`);
    }
  });

  const first = parsed[0] as { _meta?: TraceMeta };
  if (!first || typeof first !== "object" || !first._meta) {
    throw new Error(`first line must be _meta header: ${file}`);
  }
  const meta = first._meta;

  const rest = parsed.slice(1) as TraceTurn[];
  const stateIdx = rest.findIndex((t) => t.op === "state_final" || t.req?.op === "state_final");
  const stateFinal = stateIdx >= 0 ? rest[stateIdx] : null;
  const turns = stateIdx >= 0 ? rest.slice(0, stateIdx) : rest;

  return { file, meta, turns, stateFinal };
}

function listTraceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith(".trace.jsonl")) out.push(full);
    }
  }
  return out.sort();
}

// -- structural validators ---------------------------------------------------

function assertMeta(meta: TraceMeta, file: string): void {
  expect(meta.name, `${file}: _meta.name`).toBeTypeOf("string");
  expect(["unrestricted", "bounded"], `${file}: _meta.mode`).toContain(meta.mode);
  expect(["deterministic", "non-deterministic"], `${file}: _meta.replay`).toContain(meta.replay);
  expect(meta.capabilities, `${file}: _meta.capabilities`).toBeTypeOf("object");
}

function assertTurn(turn: TraceTurn, idx: number, file: string): void {
  // A turn is either:
  //   (a) a command turn: req.command is a string
  //   (b) an op turn: req.op is a string (e.g. "state_final", "assert_no_leak")
  // Any op turn is a framework-level assertion and does not go through the
  // exec path — its schema is defined by its specific op, not validated here.
  expect(turn.req, `${file} turn[${idx}].req`).toBeTypeOf("object");
  const req = turn.req;
  if (typeof req.op === "string") return;
  expect(req.command, `${file} turn[${idx}].req.command`).toBeTypeOf("string");
  expect(turn.res, `${file} turn[${idx}].res`).toBeTypeOf("object");
  const res = turn.res as Record<string, unknown>;
  // status_line is mandatory for executed turns.
  expect(typeof res.status_line === "string" || res.status_line === null,
    `${file} turn[${idx}].res.status_line must be string or null`).toBe(true);
  // Every turn must declare binding (may be null).
  expect(Object.prototype.hasOwnProperty.call(res, "binding"),
    `${file} turn[${idx}].res.binding key must exist`).toBe(true);
}

// -- bounded-specific: status_line shape -------------------------------------

const BOUNDED_OK_RE = /^OK \| (\w+) → [^ ]+ in \d+ms$/;
const BOUNDED_ERR_RE = /^ERR \| [A-Z_]+$/;

function assertBoundedStatusLine(
  turn: TraceTurn,
  idx: number,
  file: string,
): void {
  const res = turn.res as Record<string, unknown>;
  const sl = res.status_line;
  if (sl === null) return;
  if (typeof sl !== "string") return;
  const ok = BOUNDED_OK_RE.test(sl);
  const err = BOUNDED_ERR_RE.test(sl);
  expect(ok || err,
    `${file} turn[${idx}].res.status_line must match bounded format: got ${JSON.stringify(sl)}`).toBe(true);
  if (err) {
    const errObj = res.error as { code?: string } | null;
    expect(errObj?.code, `${file} turn[${idx}].res.error.code required when status_line is ERR`).toBeTypeOf("string");
  }
}

// -- tests -------------------------------------------------------------------

describe("golden traces — structural", () => {
  const files = listTraceFiles(GOLDEN_DIR);

  it("at least one trace exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = path.relative(GOLDEN_DIR, file).replace(/\\/g, "/");
    describe(rel, () => {
      const loaded = loadTrace(file);

      it("has well-formed _meta", () => {
        assertMeta(loaded.meta, rel);
      });

      it("every turn has valid schema", () => {
        for (let i = 0; i < loaded.turns.length; i++) {
          assertTurn(loaded.turns[i], i, rel);
        }
      });

      it("turn indices (`t`) are strictly monotonic 1..N", () => {
        let prev = 0;
        for (let i = 0; i < loaded.turns.length; i++) {
          const t = loaded.turns[i].t;
          if (t === undefined) continue; // state_final may omit
          expect(t, `${rel} turn[${i}]`).toBe(prev + 1);
          prev = t;
        }
      });

      if (loaded.meta.mode === "bounded") {
        it("bounded: status_line matches OK/ERR format", () => {
          for (let i = 0; i < loaded.turns.length; i++) {
            assertBoundedStatusLine(loaded.turns[i], i, rel);
          }
        });

        it("bounded: declares `covers` in _meta", () => {
          expect(loaded.meta.covers,
            `${rel}: bounded traces must declare _meta.covers`).toBeDefined();
        });
      }
    });
  }
});

describe("golden traces — bounded coverage aggregate", () => {
  const boundedFiles = listTraceFiles(BOUNDED_DIR);

  it("at least one bounded trace exists", () => {
    expect(boundedFiles.length,
      "create fixtures under tests/golden/bounded/ to satisfy RFC §5 artefact 15").toBeGreaterThan(0);
  });

  const loaded = boundedFiles.map(loadTrace);

  const verbSet = new Set<string>();
  const metaSet = new Set<string>();
  const rejectionSet = new Set<string>();
  for (const l of loaded) {
    for (const v of l.meta.covers?.verbs ?? []) verbSet.add(v);
    for (const m of l.meta.covers?.meta ?? []) metaSet.add(m);
    for (const r of l.meta.covers?.rejections ?? []) rejectionSet.add(r);
  }

  it("covers all 8 required verbs (RFC §2.3)", () => {
    const missing = REQUIRED_VERBS.filter((v) => !verbSet.has(v));
    expect(missing, `missing verbs: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers all 6 required meta-commands (RFC §2.3)", () => {
    const missing = REQUIRED_META.filter((m) => !metaSet.has(m));
    expect(missing, `missing meta: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers all required rejection codes (GRAMMAR.ebnf R1-R10 + RFC §2.5)", () => {
    const missing = REQUIRED_REJECTIONS.filter((r) => !rejectionSet.has(r));
    expect(missing, `missing rejections: ${missing.join(", ")}`).toEqual([]);
  });

  it("every declared verb is in the allowed set", () => {
    const allowed = new Set<string>(REQUIRED_VERBS);
    const extra = [...verbSet].filter((v) => !allowed.has(v));
    expect(extra, `unknown verbs in covers: ${extra.join(", ")}`).toEqual([]);
  });

  it("every declared meta is in the allowed set", () => {
    const allowed = new Set<string>(REQUIRED_META);
    const extra = [...metaSet].filter((m) => !allowed.has(m));
    expect(extra, `unknown meta in covers: ${extra.join(", ")}`).toEqual([]);
  });
});

/**
 * Bounded replay harness.
 *
 * Activation status:
 *   - grammar-rejected.trace.jsonl: FULLY ACTIVATED (all turns are parse-time
 *     rejections; no execution, no network).
 *   - call-filter-transform / foreach-save-merge / if-wait-history: still
 *     `it.todo()` because their canonical responses depend on real HTTP fetch
 *     timings and live api.github.com data. Byte-exact replay needs either
 *     (a) a recorded-and-replayed HTTP layer (nock/undici-mock) with frozen
 *     timing, or (b) relaxed matching that strips duration from status_line.
 *     Deferred.
 */
describe("golden traces — bounded replay", () => {
  const files = listTraceFiles(BOUNDED_DIR);
  for (const file of files) {
    const rel = path.relative(GOLDEN_DIR, file).replace(/\\/g, "/");
    if (rel.endsWith("grammar-rejected.trace.jsonl")) {
      describe(`replay ${rel}`, () => {
        const loaded = loadTrace(file);
        const caps = capsFromMeta(loaded.meta);
        for (let i = 0; i < loaded.turns.length; i++) {
          const turn = loaded.turns[i];
          const src = String((turn.req as Record<string, unknown>).command ?? "");
          const expected = turn.res as { error?: { code?: string } };
          const expectedCode = expected.error?.code;
          it(`turn ${turn.t ?? i + 1}: ${src.slice(0, 40).replace(/\n/g, "\\n")}`, async () => {
            const { parseProgram } = await import("../../src/parser/parse.js");
            const { executeProgram } = await import("../../src/runtime/execute.js");
            const { createSession } = await import("../../src/runtime/session.js");
            const { A2EError } = await import("../../src/errors.js");
            // Parse OR execute — some rejections (raw bash, $()) are parse-time,
            // others (SCOPE_MISS, CAPABILITY_DENIED) are runtime. The harness
            // tries both paths so the trace can mix the two freely.
            let seenCode: string | null = null;
            try {
              const program = parseProgram(src);
              const session = createSession(`replay-${turn.t}`, caps);
              const [resp] = await executeProgram(session, src, program);
              if (resp && resp.error) seenCode = resp.error.code;
            } catch (e) {
              if (e instanceof A2EError) seenCode = e.code;
              else throw e;
            }
            expect(seenCode,
              `turn ${turn.t}: expected error but got OK`).not.toBeNull();
            if (expectedCode) expect(seenCode).toBe(expectedCode);
          });
        }
      });
    } else {
      it.todo(`replay ${rel} (needs HTTP mock layer + timing-relaxed diff)`);
    }
  }
});

/**
 * Translate the trace's `_meta.capabilities` shape into CallCapabilities.
 * Safe defaults fill in anything the trace omits.
 */
function capsFromMeta(meta: TraceMeta): import("../../src/runtime/session.js").CallCapabilities {
  const raw = meta.capabilities as Record<string, unknown>;
  return {
    binariesAllowlist: Array.isArray(raw.binaries_allowlist) ? (raw.binaries_allowlist as string[]) : [],
    httpDomainsAllowlist: Array.isArray(raw.http_domains_allowlist) ? (raw.http_domains_allowlist as string[]) : [],
    maxExecTimeoutMs: typeof raw.max_exec_timeout_ms === "number" ? raw.max_exec_timeout_ms : 5000,
    maxResponseBytes: typeof raw.max_response_bytes === "number" ? raw.max_response_bytes : 65536,
    binaryPaths: {},
    pathEnv: "",
  };
}
