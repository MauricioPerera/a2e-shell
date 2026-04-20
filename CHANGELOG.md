# Changelog

All notable changes to a2e-shell. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/) from 1.0 onward.

Pre-1.0 releases (v0.x) allowed breaking changes between minors. From 1.0, breaking HTTP/API changes require a new major under a new route prefix (`/v2/*`). Additive changes (new optional fields, new error codes, new env vars) land as minors.

---

## [1.3.2] - 2026-04-20

**Hotfix #2.** Second packaging miscategorization surfaced immediately after the v1.3.1 cutover: `src/parser/grammar.pegjs` is a non-TypeScript asset that `tsc` doesn't copy to `dist/`, so `readFileSync('dist/parser/grammar.pegjs')` at module load throws `ENOENT` in production. Same root cause family as v1.3.1 (peggy devDep → runtime dep): the build tool treats the file as irrelevant for compilation, the test suite runs from `src/` so it never notices.

### Fixed

- `package.json` build script: `tsc` → `tsc && node -e "require('node:fs').cpSync('src/parser/grammar.pegjs','dist/parser/grammar.pegjs')"`. Cross-platform (works on Windows + Linux), zero new dependencies. Verified locally: `npm run build` produces `dist/parser/grammar.pegjs` alongside the compiled `parse.js`.

### Impact

Identical scope to v1.3.1 — bounded mode on prod-built images. Same rebuild remedy. v1.2.0 images also affected by this bug; a v1.2.0-based redeploy needs the same `package.json` patch.

### Postmortem

Both v1.3.1 and v1.3.2 could have been caught by a pre-GA smoke test that (a) built a production Docker image locally and (b) issued one bounded command against it. The test suite runs from source and never exercises the compiled + pruned production layout. **Followup**: add `npm run build && node dist/index.js --self-check-bounded` or a docker smoke step to CI.

---

## [1.3.1] - 2026-04-20

**Hotfix.** Production deployments (Docker image built with `npm prune --omit=dev` in the runtime stage) crashed the first time any session issued a bounded-mode command — `peggy` was in `devDependencies` but imported at runtime by `src/parser/parse.ts`. This bug shipped in v1.2.0 but was never deployed to prod (the production VPS jumped v1.1 → v1.3 directly), so it only surfaced during the v1.3.0 smoke test.

### Fixed

- `package.json`: move `peggy` from `devDependencies` to `dependencies`. `package-lock.json` regenerated. Confirmed via `npm ci --omit=dev` that `peggy` is now installed in the runtime layer.
- No code changes. Same 384 tests still passing on the dev machine (`peggy` was always available in dev where the suite installs all deps). The bug was purely a packaging miscategorization.

### Impact

- v1.2.0 Docker images are also affected. If you built and deployed v1.2.0 via `npm prune --omit=dev`, bounded mode would return `INTERNAL` (`Cannot find package 'peggy' imported from /app/dist/parser/parse.js`) on every exec. Rebuild with v1.3.1 or apply the package.json patch on top of v1.2.0.
- v1.1.0 and earlier are unaffected — bounded mode didn't exist.
- Unrestricted mode unaffected at any version.

### Migration

None. Same `v1.3.0` surface. Rebuild the Docker image from the `v1.3.1` tag.

---

## [1.3.0] - 2026-04-20

Final release of v1.3 — **MCP breadth**. All rc.1 surface is promoted to GA:

- **stdio transport** for MCP servers (subprocess + line-framed JSON-RPC). Unlocks the majority of MCP servers in the wild (stdio-only reference implementations, Postgres, filesystem, git) that previously required an HTTP wrapper.
- **`Mcp-Session-Id` threading** per MCP 2025-06-18 §2.1.4. Servers with per-session state (OAuth, pagination cursors, cached auth) now stay threaded across requests. Rotated ids adopted transparently. SHA-8 hashes in logs, never raw.
- **Multi-server hardening**: per-server `rate_limit_rpm` (default 600/min), sliding 60s window, client-side enforcement. Concurrent 4-server load test confirms no global lock contention.

All changes additive on top of v1.2. No breaking changes to v1.1/v1.2 surface. Existing sessions that don't opt into `transport: "stdio"` or set `rate_limit_rpm` behave byte-identically to v1.2.

### Deliverables frozen at this tag

- `src/mcp/schema.ts` — `McpServerSpec` is now a discriminated union on `transport` (http/sse/stdio); both branches accept optional `rate_limit_rpm`.
- `src/mcp/stdio-client.ts` — subprocess lifecycle + line-framed JSON-RPC. Same `McpClient` interface as HTTP.
- `src/mcp/connect.ts` — transport-agnostic dispatcher. Resolves stdio bare-name `command` via the session's binary allowlist.
- `src/mcp/rate-limit.ts` — sliding-60s-window per-server limiter.
- `src/mcp/client.ts` — Mcp-Session-Id capture + echo + rotation + invalidation retry; SHA-8 hash logger.
- `tests/integration/mcp-stdio.test.ts`, `mcp-session-id.test.ts`, `mcp-multi-server.test.ts` — 21 new cases total.
- `tests/fixtures/mcp-stdio-server.mjs` — minimal Node MCP server fixture.
- `docs/rfcs/002-mcp-stdio-and-breadth.md` — spec.

### Empirical numbers

| Scenario | Wall time |
|---|---:|
| 40 `tools/call` × 1 server, sequential, 20ms latency/call | ~800ms |
| 40 `tools/call` × 4 servers via `Promise.all`, same latency | **<500ms** |

Per-server isolation confirmed — no global lock contention.

### v1.2 → v1.3 migration

None required. Existing `mcp_servers` arrays continue to work byte-identically. Opting into stdio requires explicit `transport: "stdio"` + `command`. `rate_limit_rpm` defaults to 600 — set explicitly to `0` if you want the v1.2 unlimited behavior.

### Deferred to v1.4

- **Server-initiated notification stream** — long-lived GET for `notifications/resources/list_changed` etc.
- **`resources/subscribe`** — client-driven subscription; pairs with the notification stream.
- **`command: "npm:@modelcontextprotocol/..."` sugar** — security footgun; needs threat-model work.
- **Explicit undici Agent with pool size cap** — Node's default keep-alive is sufficient per the v1.3 load test.

### Deferred from v1.2 (continues)

- **SSE streaming for bounded sessions** — low priority; bounded responses are point-in-time canonical.

### Tests

384 passed / 0 todo across 25 files. Typecheck clean.

---

## [1.3.0-rc.1] - 2026-04-20

**Theme**: MCP breadth. Three additive items on top of v1.2 — stdio transport, `Mcp-Session-Id` header threading, and multi-server hardening. Purely additive; `transport: "stdio"` / `rate_limit_rpm` are opt-in fields, existing sessions are byte-identical. Spec: [`docs/rfcs/002-mcp-stdio-and-breadth.md`](docs/rfcs/002-mcp-stdio-and-breadth.md).

### Added — MCP stdio transport (RFC 002 §1-§3)

Unlocks the majority of MCP servers in the wild (reference implementations, Postgres, filesystem, git) that ship stdio-only and previously required an HTTP wrapper for a2e-shell to consume.

- `McpServerSpec` is now a discriminated union on `transport`: existing `http`/`sse` branches unchanged, new `stdio` branch with `command`, `args`, `env`, `cwd`, `timeout_ms`, `rate_limit_rpm`.
- `src/mcp/stdio-client.ts` — subprocess spawn + line-framed JSON-RPC on stdin/stdout. Same `McpClient` interface as the HTTP client, so the rest of the system is transport-agnostic.
  - Lifecycle: spawn → initialize → parallel discovery → live → EOF → `SIGTERM` at 2s → `SIGKILL` at 5s on close.
  - Framing: MAX_LINE_BYTES = 1 MiB; longer lines surface `SIZE_LIMIT`. Non-JSON lines dropped at debug level (stderr cross-contamination guard).
  - Crash handling: subprocess exit (non-zero, non-our-signal) rejects all pending requests with `MCP_SERVER_UNREACHABLE`. No auto-restart — operator recreates the session.
  - stdin resilience: `'error'` handler swallows `ERR_STREAM_WRITE_AFTER_END`; `rpc()` pre-checks `stdin.writable`.
- `src/mcp/connect.ts` — transport-agnostic dispatcher. Resolves stdio bare-name `command` via the session's binary allowlist (same policy gating bash exec + bounded `call`). Unknown command → `CAPABILITY_DENIED` before any subprocess is created.

### Added — Mcp-Session-Id threading (RFC 002 §4)

Honors MCP 2025-06-18 §2.1.4. Fixes the second-most-common HTTP MCP misbehavior: servers with per-session state (OAuth, pagination cursors, cached auth) previously saw each a2e-shell request as a cold start.

- Captures `Mcp-Session-Id` from the initialize response, echoes on every subsequent request (including `notifications/initialized`).
- Adopts rotated ids transparently. Logged as `mcp.session_id.rotated {old_hash, new_hash}`.
- On `400` with session-id-shaped body (heuristic: contains "session" + one of `mcp-session-id` / `session_id` / `session id` / a `-32xxx` code), drops the cached id and retries once without the header. Logged as `mcp.session_id.invalidated {dropped_hash}`.
- **SHA-8 hashes in logs, never raw**: full ids can carry auth-equivalent value on some servers. Hash is first 8 hex chars of SHA-256; stable across events for operator correlation.

### Added — Multi-server hardening (RFC 002 §5)

- **Per-server rate limit**: new optional field `rate_limit_rpm` on both `McpServerSpec` branches (default 600/min, `0` = disabled). Enforced client-side before the wire call via a sliding 60s window. Throws `RATE_LIMITED` (HTTP 429) with the server id in the message. Separate from the session-level `rateLimitPerMinute`.
- **`src/mcp/rate-limit.ts`**: standalone limiter module, 50 lines, no dependencies. One instance per `(session, MCP server)` isolated inside the client closure.
- **Concurrent multi-server load test**: 40 `tools/call` across 4 HTTP servers with Promise.all completes in <500ms (20ms/call × 40 / 4 servers ≈ 200ms + overhead), vs ~800ms if globally serialized. Confirms no global lock contention.
- **HTTP connection reuse**: relies on Node's built-in undici keep-alive (same-origin sockets reused automatically). Explicit per-server pool sizing deferred — the default behavior is sufficient per the load test.

### Schema changes

All additive, backward-compatible:

- `McpServerSpec` — new `transport: "stdio"` branch; both branches now accept optional `rate_limit_rpm: number` (default 600).
- No route changes, no existing-field changes, no new HTTP headers required from clients that don't opt in.

### Tests

384 passed / 0 todo across 25 files. Typecheck clean.

New test files:
- `tests/integration/mcp-stdio.test.ts` (9 cases): handshake + all 4 primitives, garbage-line drop, mid-call crash, spawn failure, close lifecycle.
- `tests/integration/mcp-session-id.test.ts` (5 cases): capture + echo, no-id backward compat, rotation, session-id 400 retry, non-session-id 400 surfaces as unreachable.
- `tests/integration/mcp-multi-server.test.ts` (7 cases): RateLimiter unit (3), HTTP client rate-limit enforcement (2), 4-server parity band (1), 40-concurrent-call isolation (1).

New fixture:
- `tests/fixtures/mcp-stdio-server.mjs` — minimal Node MCP server (~130 LoC) implementing all 4 primitives with test hooks for `crash` / `garbage` modes.

### Deferred

- **Server-initiated notification stream** (long-lived GET for `notifications/resources/list_changed` etc.) — v1.4.
- **resources/subscribe** — v1.4, pairs with the notification stream.
- **`command: "npm:..."` sugar** — v1.4 if ever; needs threat-model work first.
- **SSE streaming for bounded sessions** — continues deferred; low priority until a concrete use case appears.
- **Explicit undici Agent with pool size cap** — revisit only if load-test numbers regress. Node's default behavior is sufficient today.

---

## [1.2.0] - 2026-04-20

Final release of v1.2 — **bounded-verb shell**. All rc.1 surface is promoted to GA:

- Closed-grammar DSL (8 verbs + 6 meta) as an optional per-session execution mode alongside the default unrestricted bash pipeline. Opt-in via `mode: "bounded"` at session create.
- HTTP wiring is byte-identical to v1.1 for any session that doesn't pass `mode`. The only addition is the already-reserved bounded path through the existing `/sessions` and `/exec` endpoints.
- Persistence, real `foreach --parallel=N`, and cross-tokenizer validation all shipped inside rc.1 and freeze as stable v1.x surface at this tag.

### Deliverables frozen at this tag

- `src/parser/` — peggy-compiled grammar + typed AST + R2/R5/R7 enforcement.
- `src/runtime/` — session state, canonical response builder, evaluator (with AsyncLocalStorage iteration frames), dispatcher, persist module.
- `src/verbs/` — call (HTTP + CLI), filter, transform, save, wait, merge. if/foreach blocks dispatched from `runtime/execute.ts`.
- `src/meta/` — describe, head, show, env, history, help.
- `src/exec/pipeline-bounded.ts` — bridge between HTTP Session surface and the bounded runtime. WeakMap-backed lifecycle, lazy hydration, fire-and-forget persistence.
- `GRAMMAR.ebnf` + `docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md` — spec and ampliation RFC.
- `tests/golden/bounded/` + `tests/integration/golden.test.ts` — 4 golden traces with semantic-diff replay and aggregate coverage assertion.
- `tests/benchmarks/bounded-vs-a2e-json.ts` + `tests/integration/token-budget.test.ts` — per-regime + cross-tokenizer gates.

### Empirical token cost (cl100k_base / o200k_base, drift ≤1pp per trace)

| Trace | Ratio |
|---|---:|
| `large-response-workload` (≥2KB responses) | 14.0% / 14.1% |
| `call-filter-transform` (mixed mid) | 52.4% / 52.9% |
| `foreach-save-merge` (small) | 103.8% / 103.5% |
| `if-wait-history` (small) | 106.5% / 105.6% |
| **Aggregate** | **31.9% / 32.2%** |

Finding: bounded is a **large-response optimizer**, not a universal compressor. Cross-tokenizer drift <1pp confirms the win is not a cl100k artifact.

### v1.1 → v1.2 migration

None required. Existing clients that don't pass `mode` on session creation continue to default to `"unrestricted"` and behave identically to v1.1. Opting into bounded mode is explicit and scoped per session; persistence, transcript, metrics, idempotency, rate limits, redaction, and all existing operator tooling apply uniformly to both modes.

### Deferred to v1.3

- **SSE streaming for bounded sessions**: JSON path is live; `Accept: text/event-stream` on a bounded session still routes through the unrestricted streaming code. Low priority — bounded responses are point-in-time canonical, not progressive streams.
- **v1.2 MCP breadth items**: stdio transport, Mcp-Session-Id threading, server-initiated notifications, resources/subscribe, multi-server hardening. See [docs/ROADMAP.md](docs/ROADMAP.md).

### Tests

363 passed / 0 todo across 22 files. Typecheck clean.

---

## [1.2.0-rc.1] - 2026-04-20

**Theme**: bounded-verb shell. Optional execution mode alongside the default unrestricted bash pipeline. When a session is created with `mode: "bounded"`, `POST /sessions/:id/exec` routes through a closed-grammar DSL instead of `bash -c`. Purely additive — unrestricted mode is byte-identical to v1.1.

Shipped as an ampliation RFC — see [`docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md`](docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md).

### Added

- **Closed-grammar parser** (`src/parser/`): peggy-compiled EBNF from [`GRAMMAR.ebnf`](GRAMMAR.ebnf). 8 verbs (`call`, `filter`, `transform`, `if`, `foreach`, `save`, `wait`, `merge`) + 6 meta (`describe`, `head`, `show`, `env`, `history`, `help`). Typed AST with discriminated unions. Enforces R2 (interpolation regex), R5 (`$_` reserved), R7 (MAX_LINE_LENGTH=4096, MAX_BLOCK_DEPTH=4).
- **Bounded runtime** (`src/runtime/`): session state (bindings + TTL + transcript), canonical response builder with shape inference (scalar/record/list/table/bytes/void), value + predicate + path evaluation, dispatcher. 512B preview truncation with row-aware row-count for list/table.
- **Verbs** (`src/verbs/`): all 8 executable end-to-end.
  - `call` HTTP with `--header` / `--body` / `--query` / `--timeout`, domain allowlist, content-type-based decoding.
  - `call` CLI via `spawn(shell:false)` with binary allowlist, SIGKILL timeout, UTF-8/Buffer auto-detect.
  - `if` / `foreach` blocks (re-entrant dispatch). `foreach --on-error=abort|continue`.
  - `save` accepts interpolated names (`save $x as "stats_${$repo.name}"`) — enables per-iteration accumulators in `foreach` bodies.
  - `filter` / `transform` (pick/omit/rename/set/map) / `merge` (inner/left/right/outer, right-wins on overlap) / `wait`.
- **Meta commands** (`src/meta/`): all 6 executable. `show` bypasses the preview-truncation budget (only command that does).
- **HTTP wiring** (`src/exec/pipeline-bounded.ts`): WeakMap-side-table bridges the outer HTTP session to a bounded runtime session (lazy init, lifetime-coupled). `executeTurn` forks on `policy.mode === "bounded"` and dynamic-imports the bounded dispatcher. Canonical response → ExecResponse translation preserves the existing HTTP contract.
- **Golden traces** (`tests/golden/bounded/`): 4 fixtures covering 8/8 verbs + 6/6 meta + 4 rejection paths.
- **Golden replay harness** (`tests/integration/golden.test.ts`): structural validation + aggregate coverage assertion + per-trace replay. `grammar-rejected` byte-precise; HTTP-dependent traces use global `fetch` stub + semantic diff (OK/ERR, verb, shape.kind with list↔table relaxation, rows, binding, error.code).
- **Token-cost benchmark** (`tests/benchmarks/bounded-vs-a2e-json.ts`, `npm run bench:bounded`): measures bounded vs A2E declarative JSON per trace with cl100k_base. CLI + library (importable by tests). Gates live in `tests/integration/token-budget.test.ts`.

### Empirical token cost vs A2E-JSON

The RFC originally claimed "≤20% tokens universal". Measurement refined this to three regimes:

| Trace | Regime | cl100k_base | o200k_base | drift |
|---|---|---:|---:|---:|
| `large-response-workload` (synthetic, ≥2KB responses) | large | **14.0%** | **14.1%** | 0.1pp |
| `call-filter-transform` (mixed ~600B responses) | medium | **52.4%** | **52.9%** | 0.5pp |
| `foreach-save-merge` (small payloads <200B) | small | 103.8% | 103.5% | 0.3pp |
| `if-wait-history` (small payloads <200B) | small | 106.5% | 105.6% | 0.9pp |
| **Aggregate** | | **31.9%** | **32.2%** | 0.3pp |

Cross-tokenizer drift is 0.1–0.9pp per trace (0.3pp aggregate), confirming the win is NOT an artifact of cl100k_base's specific segmentation. Both OpenAI-family encoders (covering GPT-3.5/4 and GPT-4o/5) agree on the efficiency claim within noise. Gates: see `tests/integration/token-budget.test.ts` — ≤5pp drift per trace, ≤3pp aggregate.

**Finding**: bounded wins on large responses (preview truncation amortizes) and matches parity on small responses (canonical-wrapper overhead dominates when there's nothing big to truncate). The method is a **large-response optimizer**, not a universal compressor. CHANGELOG + RFC + README all reflect this.

### Gates (RFC §6)

Live in `tests/integration/token-budget.test.ts`; all green:

- `large-response-workload` ≤ 30% (empirical 14%)
- `call-filter-transform` ≤ 70% (empirical 53%)
- Small traces ≤ 130% (empirical 104-106%)
- Aggregate ≤ 50% (empirical 32%)

Margins are generous on top of empirical to absorb tokenizer/shape-inference drift without hiding real regressions.

### Changed

- `GRAMMAR.ebnf` already existed at the repo root (authored in v1.0-rc.3 as the bounded-mode spec). It is now **executable** — the peggy grammar at `src/parser/grammar.pegjs` derives from it.
- `docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md` §1 and §6 updated to reflect the per-regime cost claims, replacing the universal "≤20%" with an honest breakdown.

### Persistence

- **Bounded state is persisted** alongside the outer session's `state.json` as a side-file `bounded-state.json`. Zero coupling with the PersistedSession schema (unchanged from v1.1). When `A2E_SESSION_PERSISTENCE=true`, every successful bounded turn triggers a fire-and-forget atomic write (stage-to-tmp + fsync + rename). On `POST /sessions/:id/resume`, the bounded runtime hydrates lazily on first turn.
- `src/runtime/persist.ts`: serialize/deserialize BoundedSession.
  - Buffer values encoded as `{ __buffer__: "<base64>" }` sentinel → round-trips back to Buffer on read.
  - Transcript `stmt` (parsed AST) dropped on serialize; `command` source preserved. `history` meta shows "?" for pre-restore turns, real verb for post-restore.
  - Schema version pinned at 1; mismatches throw on read.
- `src/exec/pipeline-bounded.ts`: hydrate-or-fresh on first access (WeakMap coalesces concurrent hydrations), schedule-persist after every turn (WeakMap coalesces concurrent writes).
- **Corrupt file fallback**: unreadable/invalid `bounded-state.json` logs a warning (`bounded.persist.read_failed`) and starts fresh. The corrupt file is NOT overwritten until the next successful turn — operators can inspect it.

### Real `--parallel=N` in `foreach`

Previously the flag parsed but iterations ran sequentially. rc.1 ships real concurrency:

- The iteration variable is now a **lexical frame** carried by `AsyncLocalStorage`, not a session binding. Each iteration pushes `{itemVar → item}` via `withPushedFrame`; the evaluator walks the frame stack before falling back to session scope. `Promise.all` branches keep isolated `$item` bindings without racing on shared state.
- `runBounded(total, concurrency, task)`: worker-pool loop pulls indices from a shared counter until drained. First error wins under `--on-error=abort`; remaining workers drain-and-exit.
- Iteration records are ordered by index in the output (not by completion time), so downstream consumers keep deterministic row ordering regardless of scheduling.
- Verbs that write shared session names (e.g. `save $x as fixed`) still race in parallel mode — use interpolated save names (`"item_${$n}"`) for per-iteration accumulators. Documented in the runtime's module banner.

### Not in this release (deferred)

- **SSE streaming for bounded**: the JSON path is live; `Accept: text/event-stream` on a bounded session still routes through the unrestricted streaming code and will produce no useful output.

### Tests

363 passed across 22 files. Typecheck clean.

### Migration

None required. Existing sessions that don't pass `mode` continue to default to `"unrestricted"` and behave identically to v1.1. Opting into bounded is explicit per session.

---

## [1.1.0] - 2026-04-19

Final release of v1.1 — **MCP gateway (inbound)**. All RFC 001 scope is implemented end-to-end:

- HTTP + SSE Streamable transports for MCP servers
- All three read-side primitives: `tools`, `resources`, `prompts`
- Progress notification relay over exec SSE
- Redaction, rate limiting, transcript, idempotency — all unchanged from v1.0 and applied uniformly to MCP invocations
- Canonical response wrapping for every MCP output (preview + shape + binding + stderr + truncated)

### Benchmark

A new benchmark ([`tests/benchmarks/mcp-gateway.ts`](tests/benchmarks/mcp-gateway.ts), run via `npm run bench:mcp`) compares token consumption between the naive MCP client pattern (Claude Desktop / Cursor: monolithic tool injection + verbatim response dumps + no cross-turn bindings) and a2e-shell's gateway pattern on a realistic 3-turn scenario (fetch 50 GitHub issues → filter → summarize 5):

| Pattern | Prompt tokens | Completion tokens | Total |
|---|---|---|---|
| Baseline (naive MCP client) | 64,816 | 279 | **65,095** |
| Gateway (a2e-shell) | 2,545 | 119 | **2,664** |
| **Savings** | **96.1%** | **57.3%** | **95.9%** |

At Gemma-4 pricing ($0.10/$0.30 per M), this is $0.006565 → $0.000290 per task — **23× cheaper at scale**. The savings come from three additive sources:

1. **Reachability filtering**: 1 tool schema exposed out of 15 (operator-controlled via session capabilities), reducing the system prompt by ~93%
2. **Canonical preview**: ~2 KB preview instead of ~150 KB raw `list_issues` response
3. **Binding reuse**: the list is captured under `$issues`, enabling a single `jq` pipe that avoids 5 follow-up `get_issue` tool calls

Real-world numbers will vary with task shape, tool output sizes, and reachability discipline — but the architectural ratio (close to 20× at scale) is reliable across scenarios with heavy responses and multi-turn follow-ups.

### What's frozen in v1.1

The following surface is now a stable contract from v1.1 onward:

- `CreateSessionRequest.mcp_servers`: optional array of `{id, transport, url, auth?, timeout_ms}`
- `CreateSessionResponse.mcp_servers[]`: per-server status with counts for tools, resources, prompts
- `McpAuthSpec`: discriminated union with `token` variant (`env_var`, `scheme`, `header`)
- Error codes: `MCP_SERVER_UNREACHABLE` (503), `MCP_AUTH_FAILED` (401), `MCP_TOOL_NOT_FOUND` (200), `MCP_PROTOCOL_ERROR` (200), `MCP_TIMEOUT` (200)
- Virtual commands: `/bin/mcp-invoke`, `/bin/mcp-read`, `/bin/mcp-prompt`
- SSE exec event types: `start`, `stdout`, `stderr`, `progress`, `done`, `error`
- Transport enum: `"http" | "sse"` (stdio reserved for v1.2+)
- Reachability report structure: `{tools, resources, prompts, summary}` written to `<catalog>/index/mcp-tools.json`

Additive changes (new error codes, new transport values, new event types) remain allowed as minor version bumps. Breaking changes require v2.0 under `/v2/*`.

### Deferred to v1.2+

- stdio transport (subprocess-launched MCP servers)
- `Mcp-Session-Id` threading for stateful MCP sessions
- Server-initiated GET listening channel (long-lived notification stream)
- `resources/subscribe` + live cache invalidation
- External security audit findings

### Test suite

180/180 green on CI. No flakes observed in the last 5 CI runs.

---

## [1.1.0-rc.3] - 2026-04-19

Third release candidate for v1.1. Adds SSE response handling + progress notification relay. Completes the read-side MCP primitive surface planned for v1.1.

### Added

- **SSE response mode on MCP tools/call**: when an MCP server responds with `Content-Type: text/event-stream` (per MCP Streamable HTTP), a2e-shell parses the event stream, correlates the response to its request id, and forwards any interleaved notifications to a listener. Servers that stream progress during long-running tool calls now work end-to-end.
- **`transport: "sse"` in `McpServerSpec`**: explicitly opt a server into SSE response mode. Functionally identical to `"http"` on the client side (both accept `application/json` + `text/event-stream`); the flag is documentation for the operator + guard against non-MCP servers.
- **Progress notification relay**: when an exec is streamed via SSE (`Accept: text/event-stream` on `POST /exec`) AND the command is `/bin/mcp-invoke`, any `notifications/progress`, `notifications/message`, etc. from the MCP server are forwarded as `event: progress` SSE messages. Payload shape: `{ method: "notifications/progress", params: { progressToken, progress, total?, message? } }`.
- **`progressToken` injection**: `callTool` mints a short random token and places it under `params._meta.progressToken` when a notification listener is supplied. Servers that honor MCP's progress contract use the token on their notifications so the client can correlate them to the in-flight request.
- **`src/mcp/sse.ts`**: minimal SSE parser (~120 lines). Handles LF-LF and CRLF-CRLF event boundaries, comment lines, multi-line ignored fields, invalid-JSON tolerance, and partial trailing events.

### Changed

- **`ExecSink` gains `onMcpNotification?`**: invoked by the pipeline when an MCP tool call is in flight under a streaming exec. Non-MCP execs never invoke this. Non-streaming execs (JSON response) pass `undefined` and notifications are silently dropped (no listener).
- **`McpClient.callTool` signature**: now accepts an optional third arg `{ onNotification?: (n: { method, params }) => void }`. Backward compatible — existing rc.1/rc.2 callers pass nothing and behavior is unchanged.
- **exec SSE contract**: the existing `start` / `stdout` / `stderr` / `done` / `error` events are now joined by `progress`. Clients that don't recognize the new event type should ignore it per SSE semantics.

### Deferred

- **stdio transport** for MCP (rc.4 / v1.2). Requires subprocess lifecycle management at session create/delete; orthogonal to the HTTP/SSE path.
- **Server-initiated long-lived GET stream** (spec's `GET <url>` listening channel for notifications outside an in-flight request). Deferred until there's a concrete use case; the POST-response SSE path already covers the progress scenario.
- **`Mcp-Session-Id` header threading** for resumable sessions (stateful MCP servers). Deferred.
- **Multi-server benchmark vs Claude Desktop** (v1.1.0 final).

### Tests

9 new tests: 7 unit tests for the SSE parser (LF/CRLF boundaries, comments, invalid JSON tolerance, partial tails), 1 schema test for `transport: "sse"`, 1 integration test spinning a mock server that streams progress and asserting the full event sequence (start → progress ×2 → done) reaches the a2e-shell SSE client.

Full suite: 180/180 green (up from 171 in rc.2).

### Backwards compatibility

Fully additive. Existing rc.1 / rc.2 sessions and clients work unchanged. The new `progress` event type is opt-in (only emitted when the exec is streamed AND the command is an MCP invocation).

---

## [1.1.0-rc.2] - 2026-04-19

Second release candidate for v1.1. Adds `resources/*` and `prompts/*` MCP primitives to the gateway. `tools/*` surface from rc.1 unchanged.

### Added

- **`resources/list` + `resources/read`**: the MCP handshake now also caches the server's resource catalog. Read content on-demand via the virtual `/bin/mcp-read <server> <uri>` exec command. Canonical response wraps text content as preview; blob content (base64) is surfaced as metadata only (`uri`, `mimeType`, `blob_bytes`) so the preview stays token-light.
- **`prompts/list` + `prompts/get`**: prompt catalog cached at handshake. Render templates via `/bin/mcp-prompt <server> <name> <args-json>`. Result is serialized as JSON (`{description, messages[]}`) so the agent can `jq` into specific fields.
- **New virtual commands**:
  - `/bin/mcp-read <server> <uri>` — resources/read
  - `/bin/mcp-prompt <server> <name> <args-json>` — prompts/get
  - `/bin/mcp-invoke` from rc.1 unchanged
- **Reachability report structure**: `buildMcpReachability` now produces a structured `{tools, resources, prompts, summary}` object instead of a flat tool map. Written to `<catalog>/index/mcp-tools.json` when a catalog is mounted. Each primitive gets its own keyed bucket so the agent can query by kind.
- **Graceful capability probing**: if a server responds to `resources/list` or `prompts/list` with JSON-RPC `-32601 Method Not Found`, a2e-shell treats it as "no primitives of that kind" and continues (rather than failing session creation). Matches MCP spec capability-negotiation posture.
- **`McpServerInfo` response shape**: now includes `resources_count` and `prompts_count` alongside `tools_count`.

### Changed

- `McpServerState` (internal) gained `resources: Map<uri, McpResource>` and `prompts: Map<name, McpPrompt>` alongside `tools`. Session.mcpClients API unchanged.
- `buildMcpReachability` return type evolved. Callers accessing the flat tool map directly would need updating (none known inside the repo).

### Deferred to rc.3

- SSE transport (required for progress notifications on long-running tools)
- Progress notification relay via SSE exec streaming
- stdio transport
- `resources/subscribe` + live cache invalidation
- Multi-server load testing + benchmarks vs Claude Desktop

### Backwards compatibility

Fully additive. rc.1 sessions and clients work identically. The new `/bin/mcp-read` and `/bin/mcp-prompt` commands only activate when the agent emits them.

### Tests

30 MCP-specific tests pass; full suite 171/171 green (up from 160 in rc.1). Mock MCP server fixture extended to serve all three primitives.

---

## [1.1.0-rc.1] - 2026-04-19

First release candidate for v1.1 — MCP gateway (inbound). Implements [RFC 001](docs/rfcs/001-mcp-gateway.md) rc.1 scope.

### Added

- **MCP gateway**: `POST /sessions` now accepts an optional `mcp_servers` array. At session creation, a2e-shell connects to each server, performs the `initialize` handshake, and caches the server's `tools/list` response. Auth via env-var-named tokens (same discipline as catalog auth — token value never inlined, never logged, always redacted).
- **`/bin/mcp-invoke` virtual command**: the agent invokes MCP tools via `exec` with `command: "/bin/mcp-invoke <server-id> <tool-name> <args-json>"`. The pipeline intercepts this pattern BEFORE state-intercept and BEFORE binary allowlist enforcement, routes the call to the right MCP client, wraps the result in the canonical response format (status_line + shape + preview + binding + stderr + truncated), and records it in the transcript identically to bash exec.
- **Canonical response over MCP**: token-efficient response shape applies to MCP tool outputs too. Large JSON responses are previewed (2KB) + shape-detected; `bind_as` captures the full payload under `$var` for cross-turn reference. Same 32–164× token savings measured on bash outputs transfer directly to MCP outputs.
- **MCP tools in reachability**: when a catalog is mounted AND MCP servers are connected, a2e-shell writes `<index_dir>/mcp-tools.json` containing every connected tool's schema. The agent sees them alongside git-backed skills via `$A2E_CATALOG_REACHABILITY`.
- **New error codes**: `MCP_SERVER_UNREACHABLE` (503), `MCP_AUTH_FAILED` (401), `MCP_TOOL_NOT_FOUND` (200 inside ExecResponse.error), `MCP_PROTOCOL_ERROR` (200), `MCP_TIMEOUT` (200).
- **New fields on `CreateSessionResponse`**: `mcp_servers` array with per-server `{id, url, protocol_version, tools_count, server_info}`.
- **Redaction**: MCP auth env var values join the session redactor pipeline; any echo in stderr, protocol error message, or transcript entry is scrubbed.

### Deferred to later rc's

- SSE transport (rc.2), stdio transport (rc.3 or v1.2)
- `resources/*` + `prompts/*` primitives (rc.2)
- Progress notification relay (rc.2)
- `sampling/createMessage`, `elicitation/create`, `roots/list` (out of v1.1 scope)
- `resources/subscribe` + live invalidation (v1.2)

### Backwards compatibility

Fully additive. Sessions without `mcp_servers` behave identically to v1.0.0-rc.3. `CreateSessionResponse` gains a required `mcp_servers` field (defaults to `[]` when no servers configured) — clients deserializing with strict schemas may need to accept the new field.

### Tests

27 new tests covering the parser, schema, client handshake, tool invocation, auth failures, and canonical response wrapping. Total suite: 160/160 green on Linux + Windows.

---

## [1.0.0-rc.3] - 2026-04-19

### Fixed
- **Schema lock gap**: `SERVICE_UNAVAILABLE` / HTTP 503 (emitted by the drain gate during graceful shutdown) was missing from [docs/API.md](docs/API.md)'s HTTP codes table and error codes inventory. Clients validating strictly against the v1.0 contract would have rejected legitimate 503 responses. Contract now matches code.
- **Persistence was fire-and-forget**: `session.markDirty()` kicked off `runFlush()` without awaiting, and mutation routes returned HTTP 200 before the disk write completed. A crash between the response and the async write silently dropped the turn from `POST /resume`'s view. Every mutating route (`POST /exec`, its SSE variant, idempotent-hit replay, `PATCH /cwd`, `PATCH /env`) now `await`s `session.flush()` before responding. `manager.create()` also forces an initial `state.json` via new `session.touchForPersistence()` + flush so a crash right after `POST /sessions` 201 doesn't leave the client with an unresumable session id. Noops when persistence is off (default).

### Notes
- Third-round internal review surfaced 8 candidate findings; 2 were real (above), 6 were verified false positives and not applied. See commit [12836df](https://github.com/MauricioPerera/a2e-shell/commit/12836df) for the full triage.

---

## [1.0.0-rc.2] - 2026-04-19

### Added
- Performance SLO benchmark harness: [tests/benchmarks/http.bench.ts](tests/benchmarks/http.bench.ts) drives the Hono app in-process and asserts p95 latencies against budgets (`GET /healthz` ≤ 10ms, `POST /sessions` ≤ 200ms, `/exec` intercept ≤ 50ms, `/exec` subprocess ≤ 300ms). All budgets env-overridable.
- Token-consumption benchmark: [tests/benchmarks/tokens.ts](tests/benchmarks/tokens.ts) measures prompt-token savings vs. raw-dump (naive MCP / bash-tool) behavior across fixtures (tiny text, medium JSON, JSONL list, huge JSON, binary) for single-turn and 5-turn transcripts. Headline ratios on large outputs: **32× on JSONL lists, 131× on huge JSON, 164× on binary**. Canonical format loses on tiny outputs (overhead dominates below ~500 bytes) — surfaced honestly in the table.
- CI workflow [.github/workflows/ci.yml](.github/workflows/ci.yml): `verify` (typecheck + tests) and `bench` (SLO gate, uploads JSON artifact). Regressions fail the PR.
- `npm run bench:http` + `npm run bench:tokens` scripts.

### Changed
- Knocks one of the two items off the v1.0.0-final blocker list (perf SLO benchmarks). External security audit remains out-of-band.

---

## [1.0.0-rc.1] - 2026-04-19

First release candidate for the v1.0 stability promise. Every HTTP route, error code, request/response shape, env var name, and response header listed in [docs/API.md](docs/API.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) is now a **stable contract**. Additive changes (new fields / codes / vars) ship as minors; anything breaking ships under `/v2/*`.

### Added
- `X-API-Version: 1` header on every response. Clients can pin and alert on drift. Breaking changes will ship under `/v2/*` while current paths keep honoring v1.
- TLS opt-in via `A2E_TLS_CERT_PATH` + `A2E_TLS_KEY_PATH`. mTLS via `A2E_TLS_CLIENT_CA_PATH` (turns on `requestCert` + `rejectUnauthorized`).
- Deployment reference templates under [`deploy/`](deploy/):
  - Kubernetes Deployment + Service + nginx Ingress (sticky cookie, SSE-friendly timeouts) + HPA + PDB.
  - Docker Compose with Traefik TLS termination via Let's Encrypt.
  - Terraform AWS module: ECS Fargate + ALB (`lb_cookie` stickiness) + EFS + Secrets Manager.
  - `deploy/README.md` documenting the non-negotiables (affinity, grace, SSE buffering, secrets) and explicit out-of-scope list.
- `tests/setup.ts` resolves bash on Windows so the full suite runs locally under Git-for-Windows.

### Changed
- Documentation: versioning contract section in [API.md](docs/API.md), TLS section in [OPERATIONS.md](docs/OPERATIONS.md), Deployment section now points at `deploy/`.

### Known gaps (tracked for v1.0.0 final)
- External security audit — out-of-band; blocker findings must land before tag.
- Performance SLO benchmark suite in CI — harness is planned for `rc.2`.

### Contract surface frozen at this tag
- Routes: `/healthz`, `/metrics`, `/sessions`, `/sessions/:id`, `/sessions/:id/exec`, `/sessions/:id/state`, `/sessions/:id/cwd`, `/sessions/:id/env`, `/sessions/:id/transcript`, `/sessions/:id/replay`, `/sessions/:id/resume` (experimental — requires `A2E_SESSION_PERSISTENCE=true`).
- Response headers: `X-Request-Id`, `X-Worker-Id`, `X-API-Version`.
- Error codes: `PARSE_ERROR`, `CAPABILITY_DENIED`, `INTERPOLATION_REJECTED`, `SCOPE_MISS`, `TIMEOUT`, `SIZE_LIMIT`, `UPSTREAM_ERROR`, `INTERNAL`, `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `NOT_IMPLEMENTED_V1`, `SERVICE_UNAVAILABLE`.

---

## [0.3.0] - 2026-04-19

**Theme**: resilience. Survive worker restarts and container recycling without dropping sessions silently.

### Added
- Graceful shutdown: SIGTERM / SIGINT trigger `accepting → draining → stopped`. Drain rejects new mutating requests with 503 while letting in-flight ones finish; `A2E_GRACE_PERIOD_MS` bounds the wait.
- `A2E_WORKER_ID` (random UUID per process by default). Emitted as `X-Worker-Id` on every response; load balancers use it for session affinity in multi-worker deployments.
- `A2E_PID_FILE`: writes the real `process.pid` at startup so init systems targeting env-prefixed launch commands hit the right PID.
- SSE streaming on `POST /sessions/:id/exec` when the client sends `Accept: text/event-stream`. Emits `start`, `stdout`, `stderr`, `done`, `error` events with per-chunk redaction.
- Cross-process catalog cache lock via atomic `open(path, 'wx')` with stale-stealing.
- Experimental session persistence: `A2E_SESSION_PERSISTENCE=true` writes `state.json` atomically on every mutation; `POST /sessions/:id/resume` reconstructs in-memory state from disk after a restart.
- Transcript rotation on 80% threshold; `readFullTranscript()` iterates all segments in order.
- `lifecycle.ts` module with state machine; `drainGate` middleware; `SERVICE_UNAVAILABLE` error code.

### Fixed
- Idempotency race: concurrent requests with the same `Idempotency-Key` now coalesce through an in-flight map instead of racing.
- Rate limit GC was hit-based; now timer-based (`setInterval.unref()`), bounded under low traffic.
- `/sessions` (create) was not rate-limited; `A2E_RATE_LIMIT_CREATE_PER_MINUTE` added, keyed by bearer token.
- `validateCwd` followed symlinks; now compares `realpath` against `resolve` and rejects divergence.
- `bash` spawn ENOENT when only builtins were allowlisted: bash path resolved at module load (`/bin/bash` → `/usr/bin/bash` → `/usr/local/bin/bash`), overridable via `A2E_BASH_PATH`.
- Catalog cache LRU sweep could race with in-flight materialize; sweep now consults the in-flight map and re-checks live worktrees before `rm`.
- `catalogMirrorsActive` gauge now seeds from on-disk mirrors at boot (was stale after restart).
- `ExecTurnResult` now returns an explicit outcome so state-intercept commands are distinguishable from exec.

---

## [0.2.0] - 2026-04-19

**Theme**: production observability and catalog hardening.

### Added
- Structured logging via pino. Configurable level via `A2E_LOG_LEVEL`. Defensive internal redact list on top of the user-configured redactor.
- Prometheus metrics at `GET /metrics`: `http_requests_total`, `http_duration_ms`, `sessions_active`, `session_lifecycle_total`, `exec_duration_ms`, `exec_total`, `errors_total`, `catalog_mirrors_active`, `catalog_mirror_events_total`, `rate_limit_hits_total`, `redactor_secrets`, `transcript_rotations_total`.
- Catalog LRU cache: shared bare-mirror mode with sweep by total bytes; worktree prune timer cleans orphan worktrees.
- Transcript rotation to cap a single segment's size; cross-segment read surface preserved.
- `docs/ROADMAP.md` with v0.2 → v2.0 plan and explicit out-of-scope list.

### Fixed
- 10 findings from the internal review (see [efea548](https://github.com/MauricioPerera/a2e-shell/commit/efea548)).

---

## [0.1.1] - 2026-04-19 (retroactive)

### Fixed
- `LD_PRELOAD` privilege escalation via `export` intercept: `RESERVED_ENV_KEYS` now enforced inside `session.setEnv` / `session.unsetEnv`, covering both the state-intercept path and `PATCH /sessions/:id/env`.
- Race + rate-limit + cwd-validation gaps surfaced by the first security review.

---

## [0.1.0] - 2026-04-19

Initial release. HTTP server exposing a real OS shell as a primitive tool for LLM agents.

- Session-scoped bash with per-session capability policy (binary allowlist, blocked builtins, reserved env keys).
- Catalog layer: content-addressable git index branch + lazy blob hydration.
- Credential redaction pipeline: byte-level scrub at stdout, stderr, transcript, HTTP error messages.
- Zod-validated HTTP I/O. Structured error codes. Bearer auth.
- Idempotency keys on `/exec`. Per-session + per-token rate limits.
- Canonical exec response: `preview`, `shape`, `size_bytes`, `stderr`, `truncated`, `bind_as`.
- Transcript as append-only audit log. Replay endpoint computing an integrity hash.
- Default capability surface via Dockerfile: `curl`, `jq`, `gh`, `aws-cli`, `kubectl`, `git`, `grep`, `sed`, `gawk`, `ripgrep`.

[1.1.0]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.1.0
[1.1.0-rc.3]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.1.0-rc.3
[1.1.0-rc.2]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.1.0-rc.2
[1.1.0-rc.1]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.1.0-rc.1
[1.0.0-rc.3]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.1
[0.3.0]: https://github.com/MauricioPerera/a2e-shell/compare/0a4b85a...0f6aae3
[0.2.0]: https://github.com/MauricioPerera/a2e-shell/compare/28af4c1...efea548
[0.1.1]: https://github.com/MauricioPerera/a2e-shell/commit/28af4c1
[0.1.0]: https://github.com/MauricioPerera/a2e-shell/commit/46aead1
