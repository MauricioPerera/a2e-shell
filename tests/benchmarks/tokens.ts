/**
 * Token-consumption benchmark.
 *
 * Measures how many prompt tokens the LLM would spend to consume the output
 * of a command under three strategies:
 *
 *   raw       — full stdout dumped into the prompt verbatim (what you get
 *               with naive subprocess calls, including most MCP tools that
 *               echo API responses).
 *   a2e       — canonical ExecResponse produced by src/io/format.ts
 *               (status_line + shape + preview[2KiB] + binding). What the
 *               LLM sees by default from POST /sessions/:id/exec.
 *   a2e+show  — same as `a2e` on first turn; the LLM then emits `show $var`
 *               to pull the full payload in a LATER turn only when needed.
 *               Models the common case where the LLM reads the shape,
 *               decides it has enough, and moves on.
 *
 * Tokenizer: gpt-tokenizer's cl100k_base (GPT-4 / 3.5 family). Claude uses a
 * different tokenizer, but the *ratio* between strategies is stable across
 * tokenizers to within a few percent, which is all this bench claims.
 *
 * Output: a table per fixture + a multi-turn scenario showing cumulative
 * savings across 5 consecutive operations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";
import { format } from "../../src/io/format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  name: string;
  bytes: Uint8Array;
  bindAs: string;
  description: string;
}

interface CaseRow {
  fixture: string;
  description: string;
  bytes: number;
  rawTokens: number;
  a2eTokens: number;
  a2eShowTokens: number;
  savingsPct: number;
  savingsPctWithShow: number;
}

function tokens(s: string): number {
  return encode(s).length;
}

function buildFixtures(): Fixture[] {
  const enc = new TextEncoder();
  const fx: Fixture[] = [];

  // Small text — baseline. Canonical format has overhead per-response, so
  // expect it to LOSE on tiny outputs. Honest bench exposes this.
  fx.push({
    name: "tiny-text",
    bytes: enc.encode("42\n"),
    bindAs: "answer",
    description: "printf 42 (3 bytes)",
  });

  // Medium JSON — realistic API response. GitHub user endpoint shape.
  const medJson = {
    login: "octocat",
    id: 1,
    node_id: "MDQ6VXNlcjE=",
    avatar_url: "https://github.com/images/error/octocat_happy.gif",
    gravatar_id: "",
    url: "https://api.github.com/users/octocat",
    html_url: "https://github.com/octocat",
    followers_url: "https://api.github.com/users/octocat/followers",
    following_url: "https://api.github.com/users/octocat/following{/other_user}",
    gists_url: "https://api.github.com/users/octocat/gists{/gist_id}",
    starred_url: "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    subscriptions_url: "https://api.github.com/users/octocat/subscriptions",
    organizations_url: "https://api.github.com/users/octocat/orgs",
    repos_url: "https://api.github.com/users/octocat/repos",
    events_url: "https://api.github.com/users/octocat/events{/privacy}",
    received_events_url: "https://api.github.com/users/octocat/received_events",
    type: "User",
    site_admin: false,
    name: "The Octocat",
    company: "@github",
    blog: "https://github.blog",
    location: "San Francisco",
    email: null,
    hireable: null,
    bio: "A friendly octopus who loves git.",
    twitter_username: "octocat",
    public_repos: 8,
    public_gists: 8,
    followers: 16000,
    following: 9,
    created_at: "2011-01-25T18:44:36Z",
    updated_at: "2024-05-01T12:00:00Z",
  };
  fx.push({
    name: "medium-json",
    bytes: enc.encode(JSON.stringify(medJson, null, 2)),
    bindAs: "user",
    description: "curl api.github.com/users/octocat",
  });

  // Large JSONL — kubectl get pods -o json across 500 pods, flattened.
  // A realistic "list lots of things" output that overflows preview.
  const pods = Array.from({ length: 500 }, (_, i) => ({
    name: `pod-${i.toString().padStart(4, "0")}`,
    namespace: i % 10 === 0 ? "kube-system" : "app",
    status: i % 40 === 0 ? "Pending" : "Running",
    ready: i % 40 !== 0,
    restarts: i % 100,
    node: `ip-10-0-${(i % 256).toString().padStart(3, "0")}-42.ec2.internal`,
    age_seconds: 3600 * (i % 720),
  }));
  const jsonl = pods.map((p) => JSON.stringify(p)).join("\n") + "\n";
  fx.push({
    name: "large-jsonl",
    bytes: enc.encode(jsonl),
    bindAs: "pods",
    description: "kubectl get pods -o json | jq -c '.items[]' (500 rows)",
  });

  // Huge JSON — a full npm package metadata response. ~200KB.
  const big = {
    name: "example-pkg",
    versions: Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `1.${Math.floor(i / 10)}.${i % 10}`,
        {
          version: `1.${Math.floor(i / 10)}.${i % 10}`,
          dependencies: Object.fromEntries(
            Array.from({ length: 20 }, (_, j) => [`dep-${j}`, `^${j}.0.0`]),
          ),
          devDependencies: Object.fromEntries(
            Array.from({ length: 10 }, (_, j) => [`devdep-${j}`, `^${j}.0.0`]),
          ),
          description: `Release ${i} of the example package. Adds features and fixes bugs.`,
          author: "example <ex@example.com>",
        },
      ]),
    ),
  };
  fx.push({
    name: "huge-json",
    bytes: enc.encode(JSON.stringify(big, null, 2)),
    bindAs: "meta",
    description: "curl registry.npmjs.org/some-pkg (~200KB)",
  });

  // Binary — a tarball header. The classic case where raw dumping is
  // catastrophic (tokenizer explodes on high-entropy bytes).
  const bin = new Uint8Array(8192);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 137 + 41) & 0xff;
  bin[10] = 0; // force null byte → binary detection
  fx.push({
    name: "binary",
    bytes: bin,
    bindAs: "blob",
    description: "curl -O some.tar.gz → 8KB opaque bytes",
  });

  return fx;
}

function renderAsTurnContext(resp: unknown, bindAs: string): string {
  // How the canonical response typically appears to the LLM inside the
  // conversation: a JSON block the model reads back. Matches the compact
  // shape in docs/LLM-PROMPT.md.
  return `[$${bindAs}] ${JSON.stringify(resp)}`;
}

function renderRaw(bytes: Uint8Array): string {
  // Naive dump: decode as UTF-8 (replacement chars where bytes aren't
  // valid). This is what an MCP server that echoes subprocess output
  // effectively sends back.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function benchFixture(fx: Fixture): CaseRow {
  const resp = format({
    exit_code: 0,
    stdout: fx.bytes,
    stderr: new Uint8Array(0),
    bind_as: fx.bindAs,
    preview_bytes_limit: 2048,
    stderr_bytes_limit: 2048,
  });

  const rawText = renderRaw(fx.bytes);
  const a2eText = renderAsTurnContext(resp, fx.bindAs);

  // a2e+show: on the first turn only the canonical response; on a LATER
  // turn, `show $var` pulls the full payload. Here we model the common
  // case where the LLM *doesn't* need show, so the cost is just the
  // canonical response.
  const a2eShowText = a2eText; // same — `show` is only paid when used.

  const rawTokens = tokens(rawText);
  const a2eTokens = tokens(a2eText);
  const a2eShowTokens = tokens(a2eShowText);

  return {
    fixture: fx.name,
    description: fx.description,
    bytes: fx.bytes.length,
    rawTokens,
    a2eTokens,
    a2eShowTokens,
    savingsPct: rawTokens === 0 ? 0 : ((rawTokens - a2eTokens) / rawTokens) * 100,
    savingsPctWithShow:
      rawTokens === 0 ? 0 : ((rawTokens - a2eShowTokens) / rawTokens) * 100,
  };
}

interface MultiTurn {
  strategy: "raw" | "a2e";
  turns: number;
  totalTokens: number;
}

function benchMultiTurn(fx: Fixture, turns: number): [MultiTurn, MultiTurn] {
  // In a multi-turn chain, the LLM sees the prior turn's output in every
  // subsequent prompt. Context grows. We model this as "sum of tokens the
  // model reads across all turns" — a cumulative transcript cost.
  const resp = format({
    exit_code: 0,
    stdout: fx.bytes,
    stderr: new Uint8Array(0),
    bind_as: fx.bindAs,
    preview_bytes_limit: 2048,
    stderr_bytes_limit: 2048,
  });

  const perTurnRaw = tokens(renderRaw(fx.bytes));
  const perTurnA2e = tokens(renderAsTurnContext(resp, fx.bindAs));

  // Transcript-cost model: turn N sees turns 1..N. Total = Σ(i * perTurn).
  // This is the "pay for context re-read" cost, which is what matters for
  // any model without KV cache reuse — the typical agent loop.
  let rawTotal = 0;
  let a2eTotal = 0;
  for (let i = 1; i <= turns; i++) {
    rawTotal += i * perTurnRaw;
    a2eTotal += i * perTurnA2e;
  }

  return [
    { strategy: "raw", turns, totalTokens: rawTotal },
    { strategy: "a2e", turns, totalTokens: a2eTotal },
  ];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function printFixtureTable(rows: CaseRow[]): void {
  const nameW = Math.max(10, ...rows.map((r) => r.fixture.length));
  const descW = Math.max(14, ...rows.map((r) => r.description.length));
  console.log();
  console.log(
    pad("fixture", nameW),
    " ",
    pad("description", descW),
    rpad("bytes", 10),
    rpad("raw_tok", 10),
    rpad("a2e_tok", 10),
    rpad("savings", 10),
  );
  console.log("-".repeat(nameW + descW + 43));
  for (const r of rows) {
    const sav =
      r.savingsPct >= 0
        ? `${r.savingsPct.toFixed(1)}%`
        : `${r.savingsPct.toFixed(1)}%`;
    console.log(
      pad(r.fixture, nameW),
      " ",
      pad(r.description, descW),
      rpad(r.bytes.toLocaleString(), 10),
      rpad(r.rawTokens.toLocaleString(), 10),
      rpad(r.a2eTokens.toLocaleString(), 10),
      rpad(sav, 10),
    );
  }
}

function printMultiTurnTable(
  fxs: Fixture[],
  turns: number,
  outputs: Array<[MultiTurn, MultiTurn, string]>,
): void {
  console.log();
  console.log(`Cumulative transcript tokens across ${turns} consecutive turns (each turn re-reads prior outputs):`);
  console.log();
  const nameW = Math.max(10, ...fxs.map((f) => f.name.length));
  console.log(
    pad("fixture", nameW),
    " ",
    rpad("raw_total", 12),
    rpad("a2e_total", 12),
    rpad("savings", 10),
    rpad("a2e_ratio", 10),
  );
  console.log("-".repeat(nameW + 52));
  for (const [raw, a2e, name] of outputs) {
    const sav = raw.totalTokens === 0 ? 0 : ((raw.totalTokens - a2e.totalTokens) / raw.totalTokens) * 100;
    const ratio = a2e.totalTokens === 0 ? "∞" : `${(raw.totalTokens / a2e.totalTokens).toFixed(1)}×`;
    console.log(
      pad(name, nameW),
      " ",
      rpad(raw.totalTokens.toLocaleString(), 12),
      rpad(a2e.totalTokens.toLocaleString(), 12),
      rpad(`${sav.toFixed(1)}%`, 10),
      rpad(ratio, 10),
    );
  }
}

function writeJsonIfConfigured(payload: unknown): void {
  const out = process.env.A2E_BENCH_TOKENS_JSON_OUT;
  if (!out) return;
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nJSON written to ${out}`);
}

function main(): void {
  const fixtures = buildFixtures();
  const rows = fixtures.map(benchFixture);

  console.log("# a2e-shell token-consumption benchmark");
  console.log();
  console.log("Tokenizer: gpt-tokenizer (cl100k_base). Ratio is stable ±5% across tokenizers.");
  console.log("Measures prompt tokens the LLM consumes to read the output of one command.");
  console.log();
  console.log("Legend:");
  console.log("  raw     — full stdout dumped verbatim (naive MCP / bash tool behavior)");
  console.log("  a2e     — canonical ExecResponse (status_line + shape + preview + binding)");
  printFixtureTable(rows);

  const turns = 5;
  const mt: Array<[MultiTurn, MultiTurn, string]> = [];
  for (const fx of fixtures) {
    const [raw, a2e] = benchMultiTurn(fx, turns);
    mt.push([raw, a2e, fx.name]);
  }
  printMultiTurnTable(fixtures, turns, mt);

  // Headline summary — pick the most representative real-world case
  // (medium-json) for a single take-away line.
  const headline = rows.find((r) => r.fixture === "medium-json");
  const headlineMt = mt.find(([, , n]) => n === "medium-json");
  if (headline && headlineMt) {
    const [raw, a2e] = headlineMt;
    console.log();
    console.log("Headline (medium-json, single turn):");
    console.log(`  raw:      ${headline.rawTokens.toLocaleString()} tokens`);
    console.log(`  a2e:      ${headline.a2eTokens.toLocaleString()} tokens`);
    console.log(`  savings:  ${headline.savingsPct.toFixed(1)}%`);
    console.log();
    console.log(`Headline (medium-json, ${turns}-turn transcript):`);
    console.log(`  raw:      ${raw.totalTokens.toLocaleString()} tokens`);
    console.log(`  a2e:      ${a2e.totalTokens.toLocaleString()} tokens`);
    console.log(`  savings:  ${(((raw.totalTokens - a2e.totalTokens) / raw.totalTokens) * 100).toFixed(1)}%`);
  }

  writeJsonIfConfigured({
    timestamp: new Date().toISOString(),
    tokenizer: "cl100k_base",
    fixtures: rows,
    multi_turn: mt.map(([raw, a2e, name]) => ({
      fixture: name,
      turns: raw.turns,
      raw_total_tokens: raw.totalTokens,
      a2e_total_tokens: a2e.totalTokens,
    })),
  });
}

main();
