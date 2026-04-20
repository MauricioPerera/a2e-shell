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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
 * Two modes:
 *   - grammar-rejected.trace.jsonl: byte-precise check of error.code per turn
 *     (all are parse-time or runtime rejections; no network).
 *   - call-filter-transform / foreach-save-merge / if-wait-history: SEMANTIC
 *     replay. HTTP calls are stubbed via globalThis.fetch override returning
 *     canned JSON whose SHAPE matches the trace (synthetic values). The diff
 *     compares OK/ERR status, verb in status_line, shape.kind (with list↔table
 *     relaxation since homogeneous-key lists upgrade to tables), rows if
 *     declared, and binding presence. Durations / exact bytes / preview content
 *     are intentionally not checked — the trace was written before the runtime
 *     existed and its status_line strings (`json<Array<object>>[N]`) are
 *     aspirational; the actual format is what describeShape() emits.
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
      registerSemanticReplay(file, rel);
    }
  }
});

// -- semantic replay (HTTP-dependent traces) ---------------------------------

/**
 * Shape-level replay. Byte-exact replay is untenable because the traces were
 * written before the runtime existed and encode:
 *   - aspirational status_line format `json<Array<object>>[N]` vs actual
 *     `list[N]` / `table[NxM]` produced by describeShape()
 *   - variable durations (`in 312ms`)
 *   - exact byte counts that depend on formatting
 *   - specific GitHub repo data that drifts over time
 *
 * What we check per turn:
 *   - Status OK vs ERR matches expectation (derived from expected.status_line).
 *   - The verb token in status_line ("call" | "filter" | ...) matches.
 *   - shape.kind matches (list→list, record→record, ...), with a "list is a
 *     valid substitute for table" relaxation (homogeneous keys produce table
 *     but trace may say list).
 *   - binding presence matches (null vs non-null).
 *   - error.code exact match when the trace declares one.
 *
 * HTTP mocking: a per-test fetch stub matches URLs by glob-ish prefix and
 * returns canned JSON whose shape is what the trace's `shape` field asserts.
 * Unmocked URLs throw a loud error to catch drift.
 */
function registerSemanticReplay(file: string, rel: string): void {
  describe(`replay ${rel}`, () => {
    const loaded = loadTrace(file);
    const caps = capsFromMeta(loaded.meta);
    const mocks = mocksForTrace(rel);

    const originalFetch = globalThis.fetch;
    beforeAll(() => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        for (const [prefix, body] of mocks) {
          if (url.startsWith(prefix)) {
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        throw new Error(`unmocked fetch: ${url}`);
      }) as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    // Each trace runs as one session — bindings carry across turns.
    let sessionHolder: { s: import("../../src/runtime/session.js").Session } | null = null;
    beforeAll(async () => {
      const { createSession } = await import("../../src/runtime/session.js");
      sessionHolder = { s: createSession(`replay-${loaded.meta.name}`, caps) };
    });

    for (let i = 0; i < loaded.turns.length; i++) {
      const turn = loaded.turns[i];
      const src = String((turn.req as Record<string, unknown>).command ?? "");
      const expectedRes = turn.res as {
        status_line: string;
        shape: { kind: string; rows?: number } | null;
        binding: string | null;
        error: { code: string } | null;
      };
      it(`turn ${turn.t ?? i + 1}: ${src.slice(0, 40).replace(/\n/g, "\\n")}`, async () => {
        const { parseProgram } = await import("../../src/parser/parse.js");
        const { executeProgram } = await import("../../src/runtime/execute.js");
        const { A2EError } = await import("../../src/errors.js");

        let actual: import("../../src/runtime/canonical.js").CanonicalResponse | null = null;
        let thrownCode: string | null = null;
        try {
          const program = parseProgram(src);
          const [r] = await executeProgram(sessionHolder!.s, src, program);
          actual = r ?? null;
        } catch (e) {
          if (e instanceof A2EError) thrownCode = e.code;
          else throw e;
        }

        assertSemanticMatch({ turn: turn.t ?? i + 1, src, expected: expectedRes, actual, thrownCode });
      });
    }
  });
}

interface ExpectedRes {
  status_line: string;
  shape: { kind: string; rows?: number } | null;
  binding: string | null;
  error: { code: string } | null;
}

function assertSemanticMatch(ctx: {
  turn: number;
  src: string;
  expected: ExpectedRes;
  actual: import("../../src/runtime/canonical.js").CanonicalResponse | null;
  thrownCode: string | null;
}): void {
  const { expected, actual, thrownCode } = ctx;
  const label = `turn ${ctx.turn}`;
  // 1. OK vs ERR
  const expectedIsOk = expected.error === null;
  if (thrownCode !== null) {
    // A2EError escaped executeProgram — only valid if trace expected an error.
    expect(expectedIsOk, `${label}: runtime threw ${thrownCode} but trace expected OK`).toBe(false);
    if (expected.error) expect(thrownCode).toBe(expected.error.code);
    return;
  }
  expect(actual, `${label}: no response and no throw`).not.toBeNull();
  if (!actual) return;
  const actualIsOk = actual.error === null;
  expect(actualIsOk, `${label}: expected ${expectedIsOk ? "OK" : "ERR"} but got ${actualIsOk ? "OK" : "ERR"}`)
    .toBe(expectedIsOk);

  if (!expectedIsOk) {
    expect(actual.error?.code).toBe(expected.error?.code);
    return;
  }

  // 2. Verb token in status_line
  const expectedVerb = parseVerb(expected.status_line);
  const actualVerb = parseVerb(actual.status_line);
  expect(actualVerb, `${label}: verb mismatch`).toBe(expectedVerb);

  // 3. shape.kind with list↔table relaxation
  if (expected.shape && actual.shape && actual.shape.kind !== "void") {
    const ek = expected.shape.kind;
    const ak = actual.shape.kind;
    const kindsMatch =
      ek === ak ||
      (ek === "list" && ak === "table") ||
      (ek === "table" && ak === "list");
    expect(kindsMatch, `${label}: shape.kind ${ek} vs ${ak}`).toBe(true);
    // 4. rows if declared
    if (typeof expected.shape.rows === "number" && "rows" in actual.shape) {
      expect(actual.shape.rows).toBe(expected.shape.rows);
    }
  }

  // 5. binding presence; strip leading $ for comparison (trace uses $name,
  // runtime emits bare name — HTTP bridge adds $ on the way out).
  const expectedBinding = expected.binding ? expected.binding.replace(/^\$/, "") : null;
  expect(actual.binding).toBe(expectedBinding);
}

function parseVerb(statusLine: string): string | null {
  const m = statusLine.match(/^OK \| (\w+)/) ?? statusLine.match(/^ERR \| (\w+)/);
  return m ? m[1]! : null;
}

// -- per-trace fetch mocks ---------------------------------------------------

/**
 * Mocks are URL-prefix → JSON body. The bodies are SHAPE-realistic (same
 * rows, same keys as the trace would see from real api.github.com) but values
 * are synthetic. Semantic replay only asserts shape, never exact values.
 */
function mocksForTrace(rel: string): Array<[string, unknown]> {
  if (rel.endsWith("call-filter-transform.trace.jsonl")) {
    return [[
      "https://api.github.com/orgs/nodejs/repos",
      Array.from({ length: 10 }, (_, i) => ({
        id: 27193779 + i,
        name: `repo-${i}`,
        full_name: `nodejs/repo-${i}`,
        stargazers_count: 100 + i,
        open_issues_count: i,
        archived: i < 3, // 3 archived, 7 active
      })),
    ]];
  }
  if (rel.endsWith("foreach-save-merge.trace.jsonl")) {
    return [
      [
        "https://api.github.com/orgs/nodejs/repos",
        [
          { id: 1, name: "http-parser", full_name: "nodejs/http-parser", owner: { login: "nodejs" } },
          { id: 2, name: "node", full_name: "nodejs/node", owner: { login: "nodejs" } },
          { id: 3, name: "llhttp", full_name: "nodejs/llhttp", owner: { login: "nodejs" } },
        ],
      ],
      // All /repos/nodejs/<name>/stats/contributors — same prefix covers all.
      [
        "https://api.github.com/repos/nodejs/",
        [{ total: 1, author: { login: "sam" }, weeks: [] }],
      ],
    ];
  }
  if (rel.endsWith("if-wait-history.trace.jsonl")) {
    return [[
      "https://api.github.com/rate_limit",
      {
        resources: { core: { limit: 60, used: 3, remaining: 57, reset: 1745020800 } },
        rate: { limit: 60, used: 3, remaining: 57, reset: 1745020800 },
      },
    ]];
  }
  return [];
}

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
