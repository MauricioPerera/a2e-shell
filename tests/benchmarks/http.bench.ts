/**
 * HTTP benchmark harness. Drives the Hono app in-process via `app.request`
 * (same path production hits minus the @hono/node-server adapter) and asserts
 * p95 latencies against budgets from docs/ROADMAP.md#performance-slo.
 *
 * Exits non-zero on regression so CI fails the PR. Prints a table on success.
 *
 * Budgets (env-overridable):
 *   A2E_BENCH_EXEC_INTERCEPT_P95_MS   default 50   — /exec with a state-intercept
 *                                                    command (cd .), no subprocess
 *   A2E_BENCH_EXEC_SUBPROCESS_P95_MS  default 300  — /exec with `:` (bash noop)
 *   A2E_BENCH_CREATE_P95_MS           default 200  — POST /sessions, no catalog
 *   A2E_BENCH_HEALTHZ_P95_MS          default 10   — GET /healthz
 *
 * Knobs:
 *   A2E_BENCH_SAMPLES        default 500   — measured iterations per case
 *   A2E_BENCH_WARMUP         default 50    — discarded iterations per case
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// Resolve bash for Windows before importing src/exec/run.ts, which caches the
// path at module load. Mirrors tests/setup.ts.
if (process.platform === "win32" && !process.env.A2E_BASH_PATH) {
  for (const p of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    "C:/msys64/usr/bin/bash.exe",
  ]) {
    if (fs.existsSync(p)) { process.env.A2E_BASH_PATH = p; break; }
  }
}

const { buildApp } = await import("../../src/http/server.js");
const { createLifecycle } = await import("../../src/http/lifecycle.js");
const { createManager } = await import("../../src/session/manager.js");
const { createCatalogCache } = await import("../../src/catalog/cache.js");

interface CaseResult {
  name: string;
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  budgetMs: number;
  pass: boolean;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

async function bench(
  name: string,
  budgetMs: number,
  warmup: number,
  samples: number,
  fn: () => Promise<void>,
): Promise<CaseResult> {
  for (let i = 0; i < warmup; i++) await fn();

  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fn();
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);

  const mean = timings.reduce((s, v) => s + v, 0) / timings.length;
  const p50 = percentile(timings, 0.5);
  const p95 = percentile(timings, 0.95);
  const p99 = percentile(timings, 0.99);
  const max = timings[timings.length - 1]!;

  return {
    name,
    samples,
    meanMs: mean,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    budgetMs,
    pass: p95 <= budgetMs,
  };
}

function makeApp(): { app: ReturnType<typeof buildApp>; sessionsDir: string } {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "a2e-bench-"));
  const catalogCache = createCatalogCache({
    enabled: false,
    cacheDir: path.join(sessionsDir, ".cache"),
    refreshSeconds: 0,
    filterBlobs: false,
    maxBytes: 0,
    sweepIntervalSeconds: 0,
  });
  const manager = createManager({
    sessionsDir,
    redactEnvKeys: [],
    catalogBootstrapTimeoutMs: 60_000,
    catalogCache,
    allowedCwdPrefixes: [],
    persistenceEnabled: false,
  });
  const lifecycle = createLifecycle();
  const app = buildApp({
    manager,
    config: {
      authTokens: [],
      port: 0,
      maxRequestBytes: 1_048_576,
      redactEnvKeys: [],
      rateLimitPerMinute: 0,
      rateLimitCreatePerMinute: 0,
      workerId: "bench",
    },
    lifecycle,
  });
  return { app, sessionsDir };
}

async function postJson(app: ReturnType<typeof buildApp>, url: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const warmup = Math.max(1, Math.floor(envNum("A2E_BENCH_WARMUP", 50)));
  const samples = Math.max(10, Math.floor(envNum("A2E_BENCH_SAMPLES", 500)));

  const budgetIntercept = envNum("A2E_BENCH_EXEC_INTERCEPT_P95_MS", 50);
  const budgetSubproc = envNum("A2E_BENCH_EXEC_SUBPROCESS_P95_MS", 300);
  const budgetCreate = envNum("A2E_BENCH_CREATE_P95_MS", 200);
  const budgetHealthz = envNum("A2E_BENCH_HEALTHZ_P95_MS", 10);

  const { app, sessionsDir } = makeApp();

  // Pre-create one session for the /exec benches so session creation doesn't
  // dominate the measurement.
  const createRes = await postJson(app, "/sessions", {
    capabilities: { binaries_allowlist: ["bash", ":", "cd"] },
  });
  if (createRes.status !== 201) {
    console.error(`warmup session create failed: ${createRes.status}`);
    process.exit(2);
  }
  const { session_id: sid } = (await createRes.json()) as { session_id: string };

  const results: CaseResult[] = [];

  results.push(
    await bench("GET /healthz", budgetHealthz, warmup, samples, async () => {
      const r = await app.request("/healthz");
      if (r.status !== 200) throw new Error(`healthz ${r.status}`);
    }),
  );

  results.push(
    await bench("POST /sessions (no catalog)", budgetCreate, warmup, samples, async () => {
      const r = await postJson(app, "/sessions", {});
      if (r.status !== 201) throw new Error(`create ${r.status}`);
      const { session_id } = (await r.json()) as { session_id: string };
      // Clean up so the sessions map doesn't balloon during the run.
      await app.request(`/sessions/${session_id}`, { method: "DELETE" });
    }),
  );

  results.push(
    await bench(
      "POST /exec (intercept: cd .)",
      budgetIntercept,
      warmup,
      samples,
      async () => {
        const r = await postJson(app, `/sessions/${sid}/exec`, { command: "cd ." });
        if (r.status !== 200) throw new Error(`exec ${r.status}`);
      },
    ),
  );

  // Only bench subprocess path if bash is reachable — on some CI matrix entries
  // it won't be, and a meaningless ENOENT would pollute numbers.
  const bashProbe = await postJson(app, `/sessions/${sid}/exec`, { command: ":" });
  const probeBody = (await bashProbe.json()) as { error?: string };
  if (bashProbe.status === 200 && !probeBody.error) {
    results.push(
      await bench(
        "POST /exec (subprocess: `:` noop)",
        budgetSubproc,
        warmup,
        samples,
        async () => {
          const r = await postJson(app, `/sessions/${sid}/exec`, { command: ":" });
          if (r.status !== 200) throw new Error(`exec ${r.status}`);
        },
      ),
    );
  } else {
    console.warn(`[bench] skipping subprocess case: bash probe failed (status=${bashProbe.status}, body=${JSON.stringify(probeBody)})`);
  }

  printTable(results);
  writeJson(results);

  fs.rmSync(sessionsDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} regression(s) over budget:`);
    for (const r of failed) {
      console.error(`  ${r.name}: p95=${r.p95Ms.toFixed(2)}ms > budget=${r.budgetMs}ms`);
    }
    process.exit(1);
  }
  console.log("\nAll cases within budget.");
}

function printTable(rows: CaseResult[]): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  const fmt = (n: number) => n.toFixed(2).padStart(8);
  const nameW = Math.max(24, ...rows.map((r) => r.name.length));
  console.log();
  console.log(
    pad("case", nameW),
    " n   ",
    "   mean",
    "    p50",
    "    p95",
    "    p99",
    "    max",
    "  budget",
    "  status",
  );
  console.log("-".repeat(nameW + 72));
  for (const r of rows) {
    console.log(
      pad(r.name, nameW),
      String(r.samples).padStart(5),
      fmt(r.meanMs),
      fmt(r.p50Ms),
      fmt(r.p95Ms),
      fmt(r.p99Ms),
      fmt(r.maxMs),
      String(r.budgetMs).padStart(7),
      r.pass ? "  PASS" : "  FAIL",
    );
  }
}

function writeJson(rows: CaseResult[]): void {
  const out = process.env.A2E_BENCH_JSON_OUT;
  if (!out) return;
  fs.writeFileSync(out, JSON.stringify({ timestamp: new Date().toISOString(), results: rows }, null, 2));
  console.log(`\nJSON written to ${out}`);
}

main().catch((err) => {
  console.error("bench harness crashed:", err);
  process.exit(2);
});
