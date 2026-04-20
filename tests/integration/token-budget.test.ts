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
import { runBenchmark } from "../benchmarks/bounded-vs-a2e-json.js";

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
