/**
 * Token-budget gate for the bounded-verb shell.
 *
 * Runs the bench at test time and asserts the per-regime targets declared
 * in docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md §6. This is the empirical
 * verification of the RFC's token-cost claim — a change that accidentally
 * inflates the canonical wrapper or degrades the preview-truncation will
 * flip one of these gates red.
 *
 * The per-regime targets are INTENTIONALLY LAX on top (+10pp over the
 * empirically-observed ratio) so legitimate minor refactors don't flip
 * them red; they exist to catch regressions, not to encode exact numbers.
 */

import { describe, it, expect } from "vitest";
import { runBenchmark, TOKENIZERS } from "../benchmarks/bounded-vs-a2e-json.js";

describe("RFC §6 — token-cost gates", () => {
  it("bench runs and produces a metric per trace", async () => {
    const results = await runBenchmark();
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      expect(r.turns.length).toBeGreaterThan(0);
      expect(typeof r.ratio_pct).toBe("number");
    }
  });

  it("large-response-workload: bounded ≤ 30% of A2E-JSON (stated RFC target ≤20%)", async () => {
    const results = await runBenchmark();
    const m = results.find((r) => r.name === "large-response-workload");
    expect(m, "large-response-workload trace not found").toBeDefined();
    // Empirical: ~14%. Gate at 30% to absorb tokenizer / shape-inference drift
    // while still catching serious regressions.
    expect(m!.ratio_pct).toBeLessThanOrEqual(30);
  });

  it("call-filter-transform (mixed mid-sized payloads) ≤ 70%", async () => {
    const results = await runBenchmark();
    const m = results.find((r) => r.name === "call-filter-transform");
    expect(m).toBeDefined();
    // Empirical: ~53%. Gate at 70%.
    expect(m!.ratio_pct).toBeLessThanOrEqual(70);
  });

  it("small-payload traces stay within parity band (≤130%)", async () => {
    const results = await runBenchmark();
    const offenders: string[] = [];
    for (const name of ["foreach-save-merge", "if-wait-history"]) {
      const m = results.find((r) => r.name === name);
      expect(m, `${name} trace not found`).toBeDefined();
      if (m!.ratio_pct > 130) offenders.push(`${name}: ${m!.ratio_pct.toFixed(1)}%`);
    }
    expect(offenders, `regressed parity band: ${offenders.join(", ")}`).toEqual([]);
  });

  it("aggregate across all measured traces ≤ 50%", async () => {
    const results = await runBenchmark();
    const bounded = results.reduce((a, r) => a + r.bounded_total, 0);
    const a2e = results.reduce((a, r) => a + r.a2e_total, 0);
    const ratio = (bounded / a2e) * 100;
    // Empirical: ~32%. Gate at 50%.
    expect(ratio).toBeLessThanOrEqual(50);
  });
});

/**
 * Cross-tokenizer stability gate. Runs every trace under both encoders and
 * asserts the ratio drift is small. If it drifts >5pp, the win might be an
 * artifact of how cl100k_base specifically segments the canonical wrapper
 * strings — i.e. a measurement bug, not a real efficiency gain.
 *
 * Empirical observation (v1.2-rc.1): drift is 0.1–0.9pp across all four
 * traces. 5pp is a ~5x safety margin; a real tokenizer-specific artifact
 * would trip this quickly.
 */
describe("RFC §6 — cross-tokenizer stability", () => {
  const tokenizerNames = Object.keys(TOKENIZERS) as Array<keyof typeof TOKENIZERS>;

  it(`at least two tokenizers are available (got ${tokenizerNames.join(", ")})`, () => {
    expect(tokenizerNames.length).toBeGreaterThanOrEqual(2);
  });

  it("per-trace ratio drift ≤ 5pp between cl100k_base and o200k_base", async () => {
    const cl = await runBenchmark("cl100k_base");
    const o200 = await runBenchmark("o200k_base");
    expect(cl.length).toBe(o200.length);
    const offenders: string[] = [];
    for (const c of cl) {
      const match = o200.find((r) => r.name === c.name);
      expect(match, `missing ${c.name} in o200k results`).toBeDefined();
      const drift = Math.abs(c.ratio_pct - match!.ratio_pct);
      if (drift > 5) {
        offenders.push(`${c.name}: ${drift.toFixed(1)}pp (cl=${c.ratio_pct.toFixed(1)}%, o200=${match!.ratio_pct.toFixed(1)}%)`);
      }
    }
    expect(offenders, `trace drift > 5pp: ${offenders.join("; ")}`).toEqual([]);
  });

  it("aggregate ratio drift ≤ 3pp between tokenizers", async () => {
    const cl = await runBenchmark("cl100k_base");
    const o200 = await runBenchmark("o200k_base");
    const agg = (rs: typeof cl): number => {
      const b = rs.reduce((a, r) => a + r.bounded_total, 0);
      const a = rs.reduce((acc, r) => acc + r.a2e_total, 0);
      return (b / a) * 100;
    };
    const drift = Math.abs(agg(cl) - agg(o200));
    // Aggregate drift is tighter than per-trace because individual tokenizer
    // quirks partially cancel across traces. Empirical: ~0.3pp.
    expect(drift).toBeLessThanOrEqual(3);
  });
});
