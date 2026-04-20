/**
 * End-to-end runtime tests: parse → dispatch → canonical response.
 *
 * Scope: all 6 meta + 6 verbs (wait, save, filter, transform, merge, call).
 * Blocks (if/foreach) still return NOT_IMPLEMENTED_V1 — those tests assert
 * the dispatcher surface is there and typed.
 */

import { describe, it, expect } from "vitest";
import { parseProgram } from "../../src/parser/parse.js";
import { executeProgram } from "../../src/runtime/execute.js";
import { createSession, type Session } from "../../src/runtime/session.js";
import type { CanonicalResponse } from "../../src/runtime/canonical.js";

async function run(session: Session, source: string): Promise<CanonicalResponse> {
  const program = parseProgram(source);
  const responses = await executeProgram(session, source, program);
  expect(responses).toHaveLength(1);
  return responses[0];
}

function okOf(r: CanonicalResponse): Extract<CanonicalResponse, { error: null }> {
  expect(r.error, `expected OK but got error: ${JSON.stringify(r.error)}`).toBeNull();
  return r as Extract<CanonicalResponse, { error: null }>;
}

function errOf(r: CanonicalResponse): Extract<CanonicalResponse, { error: object }> {
  expect(r.error, "expected ERR but got OK").not.toBeNull();
  return r as Extract<CanonicalResponse, { error: object }>;
}

// ===========================================================================
// meta commands
// ===========================================================================

describe("runtime — meta: env + history", () => {
  it("env on fresh session is empty", async () => {
    const s = createSession("t1");
    const r = okOf(await run(s, "env"));
    expect(r.status_line).toMatch(/^OK \| env → record/);
    expect(JSON.parse(r.preview)).toEqual({ bindings: [], env_overlay_keys: [] });
  });

  it("env reflects bindings after save", async () => {
    const s = createSession("t2");
    await run(s, "save [1,2,3] as nums");
    const r = okOf(await run(s, "env"));
    expect(JSON.parse(r.preview)).toEqual({ bindings: ["nums"], env_overlay_keys: [] });
  });

  it("history reports last N turns recorded BEFORE self", async () => {
    const s = createSession("t3");
    await run(s, "save 1 as one");
    await run(s, "save 2 as two");
    const r = okOf(await run(s, "history 5"));
    // history does not include its own in-flight turn (recordTurn runs after
    // the meta executes). Expect the two prior saves only.
    const entries = JSON.parse(r.preview);
    expect(entries.map((e: { verb: string }) => e.verb)).toEqual(["save", "save"]);
    expect(entries.map((e: { t: number }) => e.t)).toEqual([1, 2]);
  });
});

describe("runtime — meta: describe + head + show + help", () => {
  it("describe a list of records reports table-ish shape", async () => {
    const s = createSession("t4");
    await run(s, 'save [{"a":1,"b":2},{"a":3,"b":4}] as xs');
    const r = okOf(await run(s, "describe $xs"));
    const info = JSON.parse(r.preview);
    expect(info.kind).toBe("table");
    expect(info.rows).toBe(2);
    expect(info.cols).toBe(2);
    expect(info.item_keys).toEqual(["a", "b"]);
  });

  it("head truncates a list to N items", async () => {
    const s = createSession("t5");
    await run(s, "save [1,2,3,4,5,6,7,8,9,10] as nums");
    const r = okOf(await run(s, "head $nums 3"));
    expect(JSON.parse(r.preview)).toEqual([1, 2, 3]);
  });

  it("show dumps full value without preview truncation", async () => {
    const s = createSession("t6");
    // Build a >512B list to force truncation in describe but not in show.
    const big = Array.from({ length: 120 }, (_, i) => ({ id: i, name: "x".repeat(8) }));
    s.bindings.set("big", { value: big, createdAtMs: Date.now(), ttlDeadlineMs: null });
    const headR = okOf(await run(s, "head $big 3"));
    expect(headR.truncated).toBe(false);
    const showR = okOf(await run(s, "show $big"));
    expect(showR.truncated).toBe(false);
    expect(JSON.parse(showR.preview)).toEqual(big);
  });

  it("help without topic returns the index", async () => {
    const s = createSession("t7");
    const r = okOf(await run(s, "help"));
    expect(r.preview).toMatch(/8 verbs \+ 6 meta/);
  });

  it("help <topic> returns that topic's text", async () => {
    const s = createSession("t8");
    const r = okOf(await run(s, "help wait"));
    expect(r.preview).toMatch(/wait <duration>/);
  });
});

// ===========================================================================
// pure-data verbs
// ===========================================================================

describe("runtime — wait", () => {
  it("returns void with expected status line", async () => {
    const s = createSession("w1");
    const r = okOf(await run(s, "wait 10ms"));
    expect(r.shape.kind).toBe("void");
    expect(r.status_line).toMatch(/^OK \| wait → void in \d+ms$/);
  });

  it("rejects durations over MAX_WAIT_MS", async () => {
    const s = createSession("w2");
    const r = errOf(await run(s, "wait 2h"));
    expect(r.error.code).toBe("CAPABILITY_DENIED");
  });
});

describe("runtime — save + TTL + conflict", () => {
  it("binds a value and makes it visible to env + $var lookup", async () => {
    const s = createSession("sv1");
    const saveR = okOf(await run(s, "save [1,2,3] as xs"));
    expect(saveR.binding).toBe("xs");
    const envR = okOf(await run(s, "env"));
    expect(JSON.parse(envR.preview).bindings).toContain("xs");
  });

  it("rejects collision without --overwrite", async () => {
    const s = createSession("sv2");
    await run(s, "save 1 as n");
    const r = errOf(await run(s, "save 2 as n"));
    expect(r.error.code).toBe("CONFLICT");
  });

  it("--overwrite replaces the binding", async () => {
    const s = createSession("sv3");
    await run(s, "save 1 as n");
    const r = okOf(await run(s, "save 2 as n --overwrite"));
    expect(r.binding).toBe("n");
    const showR = okOf(await run(s, "show $n"));
    expect(JSON.parse(showR.preview)).toBe(2);
  });

  it("interpolated save name resolves $-vars from scope", async () => {
    const s = createSession("sv-interp");
    await run(s, 'save "nodejs" as org');
    await run(s, '$x = save 42 as "stats_${$org}"');
    const showR = okOf(await run(s, "show $stats_nodejs"));
    expect(JSON.parse(showR.preview)).toBe(42);
  });

  it("interpolated save name inside foreach gives per-iteration bindings", async () => {
    const s = createSession("sv-foreach");
    await run(s, 'save [{"name":"a"},{"name":"b"}] as items');
    await run(s, "foreach $it in $items do\n  save 1 as \"n_${$it.name}\"\nend");
    const envR = okOf(await run(s, "env"));
    const { bindings } = JSON.parse(envR.preview) as { bindings: string[] };
    expect(bindings).toContain("n_a");
    expect(bindings).toContain("n_b");
  });

  it("assignment lhs + save as bind both names", async () => {
    const s = createSession("sv4");
    await run(s, "$a = save [1,2] as b");
    const showA = okOf(await run(s, "show $a"));
    const showB = okOf(await run(s, "show $b"));
    expect(JSON.parse(showA.preview)).toEqual([1, 2]);
    expect(JSON.parse(showB.preview)).toEqual([1, 2]);
  });
});

describe("runtime — filter", () => {
  it("filter ... where .field == value keeps matching rows", async () => {
    const s = createSession("f1");
    await run(s, 'save [{"n":"a","keep":true},{"n":"b","keep":false},{"n":"c","keep":true}] as xs');
    const r = okOf(await run(s, "$keep = filter $xs where .keep == true"));
    expect(r.binding).toBe("keep");
    expect(JSON.parse(r.preview.replace(/…\+\d+more.?$|\.\.\.\+\d+more/, ""))).toBeTruthy();
    const showR = okOf(await run(s, "show $keep"));
    expect(JSON.parse(showR.preview)).toEqual([{ n: "a", keep: true }, { n: "c", keep: true }]);
  });

  it("filter with compound predicate (and/or)", async () => {
    const s = createSession("f2");
    await run(s, 'save [{"x":1},{"x":2},{"x":3},{"x":4}] as xs');
    await run(s, "$out = filter $xs where .x > 1 and .x < 4");
    const r = okOf(await run(s, "show $out"));
    expect(JSON.parse(r.preview)).toEqual([{ x: 2 }, { x: 3 }]);
  });

  it("filter on non-list throws PARSE_ERROR", async () => {
    const s = createSession("f3");
    await run(s, "save 42 as n");
    const r = errOf(await run(s, "filter $n where .x == 1"));
    expect(r.error.code).toBe("PARSE_ERROR");
  });
});

describe("runtime — transform", () => {
  it("pick keeps only named fields", async () => {
    const s = createSession("t1");
    await run(s, 'save [{"a":1,"b":2,"c":3}] as xs');
    const r = okOf(await run(s, "$out = transform $xs pick a,c"));
    const showR = okOf(await run(s, "show $out"));
    expect(JSON.parse(showR.preview)).toEqual([{ a: 1, c: 3 }]);
  });

  it("omit drops the listed fields", async () => {
    const s = createSession("t2");
    await run(s, 'save [{"a":1,"b":2,"c":3}] as xs');
    await run(s, "$out = transform $xs omit b");
    const r = okOf(await run(s, "show $out"));
    expect(JSON.parse(r.preview)).toEqual([{ a: 1, c: 3 }]);
  });

  it("rename maps field names", async () => {
    const s = createSession("t3");
    await run(s, 'save [{"old":1,"keep":2}] as xs');
    await run(s, "$out = transform $xs rename old=new");
    const r = okOf(await run(s, "show $out"));
    expect(JSON.parse(r.preview)).toEqual([{ new: 1, keep: 2 }]);
  });
});

describe("runtime — merge", () => {
  const left = '[{"name":"a","score":1},{"name":"b","score":2}]';
  const right = '[{"name":"a","extra":10},{"name":"c","extra":99}]';

  it("inner: only common keys", async () => {
    const s = createSession("m1");
    await run(s, `save ${left} as L`);
    await run(s, `save ${right} as R`);
    await run(s, "$out = merge $L $R by .name --strategy inner");
    const r = okOf(await run(s, "show $out"));
    expect(JSON.parse(r.preview)).toEqual([{ name: "a", score: 1, extra: 10 }]);
  });

  it("left: all left rows, right fields when matched", async () => {
    const s = createSession("m2");
    await run(s, `save ${left} as L`);
    await run(s, `save ${right} as R`);
    await run(s, "$out = merge $L $R by .name --strategy left");
    const r = okOf(await run(s, "show $out"));
    expect(JSON.parse(r.preview)).toEqual([
      { name: "a", score: 1, extra: 10 },
      { name: "b", score: 2 },
    ]);
  });

  it("outer: union of both sides keyed by .name", async () => {
    const s = createSession("m3");
    await run(s, `save ${left} as L`);
    await run(s, `save ${right} as R`);
    await run(s, "$out = merge $L $R by .name --strategy outer");
    const r = okOf(await run(s, "show $out"));
    const rows = JSON.parse(r.preview);
    expect(rows).toHaveLength(3);
    expect(rows.find((x: { name: string }) => x.name === "c")).toEqual({ name: "c", extra: 99 });
  });
});

// ===========================================================================
// blocks: if + foreach
// ===========================================================================

describe("runtime — if block", () => {
  it("then branch taken on true predicate; body side effects persist", async () => {
    const s = createSession("if1");
    await run(s, "save 1 as n");
    const r = okOf(await run(s, "if $n == 1 do\n  save 42 as taken\nend"));
    expect(r.status_line).toMatch(/^OK \| if → scalar\[\d+B\] in \d+ms$/);
    expect(JSON.parse(r.preview)).toBe("branch:then");
    const showR = okOf(await run(s, "show $taken"));
    expect(JSON.parse(showR.preview)).toBe(42);
  });

  it("else branch taken on false predicate", async () => {
    const s = createSession("if2");
    await run(s, "save 5 as n");
    const r = okOf(await run(s, "if $n > 100 do\n  save \"hi\" as x\nelse\n  save \"lo\" as x\nend"));
    expect(JSON.parse(r.preview)).toBe("branch:else");
    const showR = okOf(await run(s, "show $x"));
    expect(JSON.parse(showR.preview)).toBe("lo");
  });

  it("no else branch, false predicate → body skipped entirely", async () => {
    const s = createSession("if3");
    await run(s, "save 0 as n");
    const r = okOf(await run(s, "if $n > 100 do\n  save 1 as dead\nend"));
    expect(JSON.parse(r.preview)).toBe("branch:else");
    const show = errOf(await run(s, "show $dead"));
    expect(show.error.code).toBe("SCOPE_MISS");
  });

  it("predicate error surfaces as block error", async () => {
    const s = createSession("if4");
    // $missing not bound → SCOPE_MISS in predicate
    const r = errOf(await run(s, "if $missing == 1 do\n  wait 1ms\nend"));
    expect(r.error.code).toBe("SCOPE_MISS");
  });
});

describe("runtime — foreach block", () => {
  it("iterates over a list, body runs per item, result has iteration records", async () => {
    const s = createSession("fe1");
    await run(s, "save [10,20,30] as nums");
    // --overwrite required to re-bind the same name each iteration.
    const r = okOf(await run(s, "foreach $n in $nums do\n  save $n as last --overwrite\nend"));
    // Shape is inferred as "table" because the 3 iteration records share keys.
    expect(r.status_line).toMatch(/^OK \| foreach → table\[3x\d+\]/);
    const rows = JSON.parse(r.preview.replace(/, \.\.\.\+\d+more\]$/, "]"));
    expect(Array.isArray(rows)).toBe(true);
    // Final iteration sets $last to 30.
    const showR = okOf(await run(s, "show $last"));
    expect(JSON.parse(showR.preview)).toBe(30);
  });

  it("iteration variable does not leak after block (restores prior binding if any)", async () => {
    const s = createSession("fe2");
    await run(s, "save 999 as item");
    await run(s, "save [1,2] as xs");
    await run(s, "foreach $item in $xs do\n  wait 1ms\nend");
    const showR = okOf(await run(s, "show $item"));
    // prior value restored
    expect(JSON.parse(showR.preview)).toBe(999);
  });

  it("iteration variable deleted after block if it wasn't bound before", async () => {
    const s = createSession("fe3");
    await run(s, "save [1,2] as xs");
    await run(s, "foreach $fresh in $xs do\n  wait 1ms\nend");
    const r = errOf(await run(s, "show $fresh"));
    expect(r.error.code).toBe("SCOPE_MISS");
  });

  it("empty list → zero iterations, empty result", async () => {
    const s = createSession("fe4");
    await run(s, "save [] as empty");
    const r = okOf(await run(s, "foreach $x in $empty do\n  wait 1ms\nend"));
    expect(JSON.parse(r.preview)).toEqual([]);
  });

  it("non-list target → PARSE_ERROR", async () => {
    const s = createSession("fe5");
    await run(s, "save 42 as n");
    const r = errOf(await run(s, "foreach $x in $n do\n  wait 1ms\nend"));
    expect(r.error.code).toBe("PARSE_ERROR");
  });

  it("--on-error=abort stops on first iteration error", async () => {
    const s = createSession("fe6");
    await run(s, "save [1,2,3] as xs");
    // SCOPE_MISS inside body — default abort.
    const r = errOf(await run(s, "foreach $x in $xs do\n  show $nope\nend"));
    expect(r.error.code).toBe("SCOPE_MISS");
  });

  it("--on-error=continue records error_code per iteration and keeps going", async () => {
    const s = createSession("fe7");
    await run(s, "save [1,2] as xs");
    const r = okOf(await run(s, "foreach $x in $xs --on-error=continue do\n  show $nope\nend"));
    const rows = JSON.parse(r.preview);
    expect(rows).toHaveLength(2);
    expect(rows[0].error_code).toBe("SCOPE_MISS");
    expect(rows[1].error_code).toBe("SCOPE_MISS");
  });
});

// ===========================================================================
// cross-cutting: SCOPE_MISS + deferred verbs
// ===========================================================================

describe("runtime — cross-cutting", () => {
  it("referencing an unbound var returns SCOPE_MISS", async () => {
    const s = createSession("sm");
    const r = errOf(await run(s, "show $unknown"));
    expect(r.error.code).toBe("SCOPE_MISS");
  });

  it("path into missing field returns SCOPE_MISS", async () => {
    const s = createSession("sm2");
    await run(s, 'save {"a":1} as obj');
    const r = errOf(await run(s, "show $obj.missing"));
    expect(r.error.code).toBe("SCOPE_MISS");
  });

  it("call without caps is denied (CAPABILITY_DENIED)", async () => {
    const s = createSession("ni1");
    const r = errOf(await run(s, 'call GET "https://x.com/"'));
    expect(r.error.code).toBe("CAPABILITY_DENIED");
  });

  it("transcript records both OK and ERR turns monotonically", async () => {
    const s = createSession("tx");
    await run(s, "save 1 as a");
    await run(s, "show $unknown");          // ERR
    await run(s, "save 2 as b");
    expect(s.transcript.map((t) => [t.t, t.error ? "ERR" : "OK"])).toEqual([
      [1, "OK"], [2, "ERR"], [3, "OK"],
    ]);
  });
});
