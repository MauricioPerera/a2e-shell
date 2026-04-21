# Roadmap

## Philosophy

The project optimizes for four properties, in order:

1. **Security by construction** — new features land with the threat model already defended, not patched later.
2. **LLM-native ergonomics** — every change must reduce token friction or add none.
3. **Operational honesty** — no silent failures, no lazy sweeps that hide problems, no "eventually consistent" where "now consistent" is achievable.
4. **Primitive over feature** — a smaller surface that composes beats a larger surface that assumes.

Items below are grouped by release, not by calendar. Ordering within a release is the natural dependency order.

---

## v0.1 — shipped

Initial HTTP API (`POST /sessions`, `POST /sessions/:id/exec`, state + transcript + replay + cwd + env PATCH, DELETE), exec pipeline, canonical response, catalog layer (git-backed, pinnable, shared bare mirror, partial clone, reachability, token + ssh_key auth), caps (bindings, transcript, rate limits, body size), reserved env keys single-source, redactor over all egress channels.

---

## v0.2 — Operability — **shipped**

**Theme**: deploy, watch, recover.

### Observability

- **Structured logs** via `pino`. Every `A2EError`, every session create/delete, every cache mirror creation and refresh, every sweepExpired cycle emits a JSON line with `request_id`, `session_id`, `event`, `duration_ms`.
- **Metrics endpoint** (`/metrics`, Prometheus format, opt-in via env): sessions alive, cache mirror count + disk, rate-limit windows active, exec durations (histogram), bootstrap durations, error counts by code.
- **Per-session audit log** summary in `GET /sessions/:id/state` — total exec count, total stderr lines, total SIZE_LIMIT hits, last error code.

### Cache lifecycle

- **LRU eviction for catalog cache**: cap the cache dir at `A2E_CATALOG_CACHE_MAX_BYTES` (default 2 GiB). Evict oldest mirrors by last-access time. `GET /admin/cache` lists mirrors with size + last-access.
- **Periodic `git worktree prune` sweep** across all mirrors on a timer (30min), not only on DELETE. Handles orphan metadata from crashed sessions.
- **Cache refresh backpressure**: if a mirror's `remote update` is in-flight, new sessions wait; don't spawn a second fetch. Already partially covered by in-flight map; extend to refresh.

### Transcript lifecycle

- **Rotation**: when a transcript hits 80% of `max_transcript_bytes`, the next append triggers rotation to `transcript.<ts>.jsonl` and starts a fresh file. Session stays alive. Signal sent in response as `transcript_rotated: true` (new response field).
- **Archival hook**: env `A2E_TRANSCRIPT_ARCHIVE_DIR`. On rotation and on DELETE, move completed transcripts there instead of deleting. For audit compliance.

### Small polish from the review

- `cd ~` expansion in intercept (resolve via `HOME` env).
- Defensive `Buffer.from(subarray)` copies in streaming truncation (run.ts).
- Retry transient network errors in `cache.resolveSha` (exponential backoff, max 3 attempts, opt-out via env).
- `delete()` return type enriched: `{ existed: boolean, reason: "deleted" | "expired" | "not_found" }`.

### Success criteria

- Prod deployment exposes `/metrics` scraped by Prometheus.
- Cache dir stays under configured cap across 24h of realistic traffic.
- Transcript rotation verified under load test (≥ 1k execs per session).
- `/admin/cache` endpoint documented and authed.

---

## v0.3 — Resilience — **shipped**

**Theme**: survive partial failures, handle long-running work.

### Multi-worker deployments

- **Sticky session routing contract**: document the header `X-Session-Worker-Id` that load balancers must honor. Add `GET /sessions/:id/state` returning worker id. Without sticky routing, sessions can't safely share a cache dir; this is the deployment guide half.
- **Cache mutual exclusion across workers**: use `flock` (POSIX) on `<cache_dir>/<repo-hash>/.lock` during mirror creation. Prevents two workers clobbering the same mirror.
- **Session eviction coordination**: if a worker dies mid-session, another worker can claim the session dir (PID file + liveness TTL). Optional v0.3 feature.

### Graceful shutdown

- On SIGTERM: stop accepting new requests (503 with `Retry-After`), drain in-flight execs up to a grace period (default 30s), flush all transcripts, run `git worktree prune` on all mirrors, then exit.
- `POST /admin/drain` endpoint to manually trigger before a scheduled restart.

### Streaming (opt-in)

- **SSE on `/sessions/:id/exec`** when request header `accept: text/event-stream` is set. Streams:
  - `status_line` event when subprocess starts
  - `stdout_chunk` events as bytes arrive (redacted, shape-tagged)
  - `stderr_chunk` events same
  - `final` event with the canonical `ExecResponse`
- Back-compat: absent header → current JSON response. Schema unchanged for non-streaming consumers.
- Justification: agents needing long-running commands (CI pipelines, data processing) currently hit `TIMEOUT` or receive silent output. SSE lets them decide on partial output.

### Session resumption (experimental)

- Persist session state (cwd, env overlay, bindings as hash refs to transcript, idempotency cache) to `<sessions_dir>/<id>/state.json` on every mutation.
- On server restart, `POST /sessions/:id/resume` reloads state. Catalog is re-bootstrapped if still valid.
- Transcript is the source of truth; state.json is a cache for fast resume.
- Behind an env flag (`A2E_SESSION_PERSISTENCE=true`) — default off in v0.3.

### Success criteria

- Two-worker deploy with shared cache dir runs 10k concurrent sessions without mirror corruption.
- Graceful shutdown loses zero transcript lines under load.
- SSE client (e.g. curl) receives partial output for a 30s sleep command.

---

## v1.0 — Stability — **shipped (rc series: rc.1 through rc.3)**

Final rc: [v1.0.0-rc.3](https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.3). Schema lock, TLS opt-in, deployment templates, performance SLO bench in CI, API version header. v1.0 final GA is gated on external security audit (out-of-band); the rc.3 tag is what v1.1 extends from.

**Theme**: freeze the promise; run it in real production.

### Schema lock

- All HTTP request/response shapes frozen. Breaking changes require version-prefixed routes (`/v1/...` → `/v2/...`).
- Env var names locked. New env vars can be added; existing cannot be renamed.
- Error code set locked. New codes can be added; existing cannot change meaning.
- Migration guide: v0.x → v1.0 published with every field-level diff.

### TLS terminator (opt-in)

- Built-in TLS support via `@hono/node-server`'s HTTPS mode.
- Env: `A2E_TLS_CERT_PATH`, `A2E_TLS_KEY_PATH`. When set, the server listens on HTTPS instead of HTTP. Mutually exclusive with running behind a reverse proxy.
- mTLS option: `A2E_TLS_CLIENT_CA_PATH` requires client certs signed by the given CA. Replaces or supplements bearer auth.

### External security audit

- Independent review of the threat model and enforcement layers.
- Findings triaged; blocker findings fixed before v1.0 tag.
- Audit report published with the release.

### Performance SLO

- Documented targets at v1.0:
  - `/exec` p95 < 50ms on empty commands (HTTP + pipeline overhead, no subprocess)
  - `/sessions` cold-start p95 < 200ms (no catalog)
  - Catalog bootstrap (cache hit, shared mirror) p95 < 100ms
  - Catalog bootstrap (cold, small repo) p95 < 3s
- Benchmark suite (`tests/benchmarks/http.bench.ts`) runs in CI; regressions block merge. Shipped in v1.0.0-rc.2.

### Deployment templates

- Kubernetes manifest with reverse-proxy (nginx/caddy), horizontal pod autoscaler, persistent volume for cache + sessions.
- Docker Compose with traefik TLS termination + SSH agent socket forwarding.
- Terraform module (AWS) with ECS service + EFS for sessions.

### Success criteria

- v1.0 tag shipped.
- Audit report public.
- At least one reference deployment (our own or partner's) running in production for 30 days.
- Schema versioning policy documented and enforced via CI.

---

## v1.1 — MCP gateway (inbound) — **shipped**

**Release tag: [v1.1.0](https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.1.0)**. Superseded by v1.2 / v1.3 (additive, no breaking changes).

a2e-shell is a token-disciplined MCP client. Sessions accept an `mcp_servers` array; connected servers' tools, resources, and prompts are exposed to the agent via the same canonical response format used for bash exec. Benchmark (95.9% token reduction vs naive MCP client on a realistic 3-turn agent task) ships with the release.

Complete scope per RFC 001:

- HTTP + SSE Streamable transports
- All three read-side primitives (tools/resources/prompts) with caching
- Progress notification relay over exec SSE
- Full inheritance of v1.0 discipline: redaction, rate limits, idempotency, transcript, canonical response

### What's frozen at v1.1

- `CreateSessionRequest.mcp_servers` shape
- `CreateSessionResponse.mcp_servers[]` shape (with resources_count / prompts_count)
- `McpAuthSpec` (token discriminated union)
- Virtual commands: `/bin/mcp-invoke`, `/bin/mcp-read`, `/bin/mcp-prompt`
- SSE exec `progress` event
- MCP error codes (5 new)
- Reachability report structure

### Deferred to v1.2+

- stdio transport for MCP
- `Mcp-Session-Id` header threading
- Server-initiated GET listening channel
- `resources/subscribe` + live invalidation

---

## v1.2 — Bounded mode — **shipped (GA)**

Additive scope on top of v1.1. No breaking changes to v1.1 surface. Tag: `v1.2.0`.

### Bounded mode — **shipped (rc.1 → GA)**

- `GRAMMAR.ebnf` enforced at runtime. `mode: "bounded"` session rejects any command that doesn't parse against the grammar.
- Parser emits canonical AST → validated → executed through a restricted interpreter (not bash).
- 8 verbs (`call`, `filter`, `transform`, `if`, `foreach`, `save`, `wait`, `merge`) + 6 meta (`describe`, `head`, `show`, `env`, `history`, `help`).
- `call` HTTP (domain allowlist + timeouts + content-type decoding) and CLI (binary allowlist + SIGKILL + UTF-8/Buffer auto-detect).
- `if` / `foreach` blocks with `--on-error=abort|continue`. `foreach --parallel=N` accepted but sequential in rc.1 (scope-stack needed for real concurrency).
- Interpolated save names (`save $x as "stats_${$repo.name}"`) — enables per-iteration accumulators.
- Empirical 14% token cost vs A2E declarative JSON on large-response workloads; ~50% on medium; parity on small. Gated in `tests/integration/token-budget.test.ts`.
- Spec: [`docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md`](rfcs/RFC-bounded-verb-shell-CONTRACT.md).
- Use case: compliance-grade deployments where `eval` / `$(...)` / arbitrary CLIs are not acceptable even with allowlist enforcement.

### Bounded mode — also shipped in rc.1 (out-of-band additions)

- **Persistence**: `bounded-state.json` side-file next to `state.json`, atomic writes (fsync+rename), lazy hydration on resume, corrupt-file fallback. Zero coupling with the v1.1 PersistedSession schema. Bindings + transcript (sans stmt) survive manager restart.
- **Real `--parallel=N` in foreach**: `AsyncLocalStorage`-backed lexical frames for the iteration variable; bounded-concurrency worker pool. Iteration records ordered by index. First-error-wins under `--on-error=abort`. Concurrent `save` to the same name still races — users emit interpolated names for per-iteration accumulators.
- **Multi-tokenizer benchmark**: `bench:bounded` runs both cl100k_base (GPT-3.5/4) and o200k_base (GPT-4o/5) and reports side-by-side ratios + per-trace drift. Empirical drift: 0.1–0.9pp per trace (0.3pp aggregate) → the token-cost win is NOT a cl100k artifact. Gate in `tests/integration/token-budget.test.ts` asserts ≤5pp per-trace, ≤3pp aggregate. Claude 3+ / Gemma / Llama tokenizers are not publicly shipped; the two OpenAI-family encoders we ship span the width of available public encoders.

---

## v1.3 — MCP breadth — **shipped (GA)**

**Theme**: close the MCP gap that v1.1 left open. Spec: [`docs/rfcs/002-mcp-stdio-and-breadth.md`](rfcs/002-mcp-stdio-and-breadth.md). Current tag: `v1.3.2` (rc.1 → GA → v1.3.1 peggy-as-dep hotfix → v1.3.2 grammar.pegjs-in-dist hotfix).

Additive on top of v1.2. No breaking changes to v1.1/v1.2 surface.

### Shipped in v1.3

- **stdio transport for MCP servers**: subprocess + line-framed JSON-RPC. Lifecycle EOF → SIGTERM(2s) → SIGKILL(5s). Binary allowlist enforced. Crash → next `tools/call` returns `MCP_SERVER_UNREACHABLE`. No auto-restart in v1.3.
- **`Mcp-Session-Id` threading**: capture on initialize, echo on every subsequent request (including `notifications/initialized`). Rotated ids adopted transparently. Invalid ids (400 with session-id-shaped body) trigger one retry without the header. SHA-8 hash logs, never raw.
- **Multi-server hardening**: per-server rate limit (`rate_limit_rpm`, default 600/min, 0=disabled) via sliding 60s window. Client-side enforcement throws `RATE_LIMITED` (HTTP 429). Load test: 40 concurrent calls across 4 HTTP servers in <500ms (vs 800ms globally-serialized baseline) confirms isolation.

### Deferred from v1.2 (continues deferred)

- **SSE streaming for bounded**: low priority (bounded responses are point-in-time canonical, not progressive). Defer until concrete use case appears.

### Deferred to v1.4

- **Explicit undici Agent with pool size cap**: Node's default undici behavior already provides keep-alive and is sufficient per the v1.3 load test. Revisit only if production numbers regress.

---

## v1.4 — MCP ergonomics — **in progress**

Additive on top of v1.3. No breaking changes to v1.1 / v1.2 / v1.3 surface.

### Shipped

- **`npm:<pkg>@<ver>` command sugar for stdio MCP servers** (RFC 003). `command: "npm:@modelcontextprotocol/server-filesystem@1.2.3"` expands to `npx -y <pkg>@<ver>` at connect time. Strict grammar: exact semver only (no tags, no ranges). `npx` must be in `binaries_allowlist` — otherwise `CAPABILITY_DENIED`. Threat model covered in RFC 003 §Threat model.
- **Server-initiated notification stream + auto-subscribe** (RFC 004). Both transports react to `notifications/{tools,resources,prompts}/list_changed` with atomic catalog refresh; both handle `notifications/resources/updated` for auto-subscribed URIs (capped at 512 per server). HTTP transport opens a long-lived `GET <url>` alongside the POST channel with backoff 1s/2s/4s on drops after a successful connect; degrades gracefully on 404/405 (`unsupported`) or 401/403 (`disabled`). `POST /sessions` response gains `notifications_stream` per server. Prometheus: `a2e_mcp_notifications_total`, `a2e_mcp_stream_reconnects_total`, `a2e_mcp_stream_connected`. Auto-subscribe default on; opt-out via `resources_subscribe: false` in the server spec. Agent-facing subscribe surface deferred to v1.5.

### Deferred (carry-overs from v1.3)

- **Explicit undici Agent with pool size cap**.

---

## v2.0 — Expressiveness

**Theme**: federated knowledge and plugin-extensible DSL (bounded mode is now in v1.2; this release builds on top).

### Federated catalog

- `CatalogSpec.federated` — manifest with entries pointing at OTHER repos (`{repo_url, ref, path}`).
- Agent consuming a federated index sees a unified catalog across N source repos.
- Each backing repo's auth resolved independently per-entry (different token/SSH key).
- Use case: a central "skill registry" aggregating teams' individual repos.

### Plugin verbs (bounded only)

- Bounded mode gets a plugin mechanism for adding new verbs via signed TypeScript modules.
- Verbs compile against a sandboxed SDK; loaded at session creation per-tenant config.
- Gate: Ed25519 signature verification against operator's trust anchor.
- Use case: vertical-specific DSLs (finance, medical) atop the bounded shell.

### Multi-shell backends

- Replace bash with `zsh`, `fish`, or PowerShell based on session config.
- Intercept logic re-implemented per shell.
- Low priority; bash covers 95% of real needs.

### Remote skill execution

- A skill's metadata can declare `remote: <a2e-shell-url>` — invoking hydrates the skill on the target server instead of locally.
- Cross-shell execution: the calling session's `exec` delegates to the remote's `exec`, stitches transcripts.
- Use case: compute-heavy skills pinned to beefier hardware.

---

## Out of scope — explicitly

Design decisions we've made NOT to chase:

- **Arbitrary code execution in the host process**. No `eval`, no `vm`, no in-process plugin system. Bounded mode's plugin verbs compile ahead of time; there is no runtime code injection.
- **a2e-shell as an MCP server**. a2e-shell CONSUMES external MCP servers (v1.1 gateway); it does not implement the MCP protocol as its own transport. Agents talk to a2e-shell via our HTTP API (`POST /sessions/:id/exec` with canonical response), not via JSON-RPC. If an MCP-speaking agent needs to drive a2e-shell, route via a thin adapter. The catalog-side MCP server (exposing a2e-skills over MCP) lives in a companion project — see [a2e-skills RFC 001](https://github.com/MauricioPerera/a2e-skills/blob/main/docs/rfcs/001-mcp-adapter.md).
- **LLM-specific optimizations hardcoded**. The HTTP API and the system prompt are generic. No Claude-specific or GPT-specific code paths.
- **State synchronization across geographic regions**. Sessions are a single-region primitive. Multi-region requires external coordination (reverse-proxy routing to home region).
- **Auth/identity provider integration (OIDC, OAuth2, SAML)**. Bearer tokens with external rotation are sufficient. Integrations belong in a reverse proxy.
- **Billing / quota integration beyond rate limits**. Rate limits are the surface; fine-grained accounting for paid plans belongs outside the server.
- **Built-in observability backend**. Metrics and logs are EMITTED; collection, storage, dashboards are the operator's concern.

---

## Near-term decisions blocking progress

Items below need a decision before they can be scheduled:

1. **Bounded mode parser strategy**: hand-rolled recursive descent (matches GRAMMAR.ebnf) vs generated (nearley, peggy). Trade-off: control vs maintenance.
2. **Transcript archival format**: raw JSONL vs compressed (gzip per rotation) vs batched (tarballs). Affects disk cost and audit tool compatibility.
3. **SSE vs long-polling for streaming**: SSE requires HTTP/1.1 semantics that some proxies break; long-polling works everywhere but is chattier.
4. **Session persistence granularity**: snapshot-every-mutation vs periodic snapshot + WAL from transcript. Perf vs correctness under crash.

These four are listed in the order they're likely to be needed.

---

## Versioning policy

- Pre-v1.0 (v0.x): breaking changes allowed freely, announced in commit messages and CHANGELOG. Minor releases (v0.1 → v0.2) can change HTTP schemas.
- v1.0+: semantic versioning. Breaking HTTP/API changes require a new major version and a new route prefix (`/v1/*`, `/v2/*`).
- Env var names: purely additive post-v1.0. Deprecated vars fall into a 2-minor grace period (log warnings, still honored) before removal in the next major.
- Error code set: additive post-v1.0. Removing a code is a major change.
