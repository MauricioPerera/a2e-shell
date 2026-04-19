# Architecture

Internal module layout, request lifecycle, security model, and failure modes.

## Module layout

```
src/
├── index.ts                     entry: env parse, TLS opt-in, cache init, manager init, app build, listen, SIGTERM/SIGINT shutdown
├── errors.ts                    ErrorCode enum (incl. SERVICE_UNAVAILABLE), A2EError class, httpStatusForCode table
├── http/
│   ├── server.ts                Hono app build, middleware stack, onError serializer, API_VERSION constant
│   ├── lifecycle.ts             accepting → draining → stopped state machine, in-flight counter, waitForDrain
│   └── routes/
│       ├── sessions.ts          POST /sessions, DELETE /sessions/:id, POST /sessions/:id/resume (experimental)
│       ├── exec.ts              POST /sessions/:id/exec + SSE streaming variant + idempotency + post-response flush
│       ├── state.ts             GET /state, PATCH /cwd, PATCH /env, GET /transcript
│       └── replay.ts            POST /sessions/:id/replay
├── session/
│   ├── manager.ts               registry of live sessions, create+resume+get+delete+sweep
│   ├── state.ts                 Session factory: cwd, env overlay, bindings, idempotency cache, transcript rotation, persistence orchestration
│   ├── persistence.ts           atomic state.json writes (tmp + fsync + rename), schema-versioned read path
│   ├── transcript.ts            JSONL append-only, read iterator, hashFinal
│   └── validation.ts            shared validators for cwd (realpath symlink check), env, reserved keys (create + PATCH)
├── exec/
│   ├── pipeline.ts              orchestrator for a single turn; returns TurnResult {response, outcome}
│   ├── interpolate.ts           ${$var} resolver with strict regex (single pass, no recursion)
│   ├── state-intercept.ts       cd/export/unset classifier (pure)
│   └── run.ts                   spawn BASH_PATH -c with argv-array, streaming truncation, stream-mode TextDecoder
├── capabilities/
│   └── policy.ts                policy resolver + enforceBinaryAllowlist + isBinaryReachable
├── credentials/
│   └── redactor.ts              byte-level scrubber, longest-match replacement, MIN_SECRET_LEN=8
├── catalog/
│   ├── bootstrap.ts             orchestrates index+content materialization, builds auth args+env
│   ├── cache.ts                 shared bare mirror + worktree + cross-process flock + LRU sweep + in-flight coalescing
│   └── reachability.ts          static analysis skills.requires ↔ policy.binaries_allowlist
├── logging/
│   └── logger.ts                pino with A2E_LOG_LEVEL + defensive internal redact list
├── metrics/
│   └── metrics.ts               prom-client registry: http, exec, sessions, catalog, rate limits, redactor, transcript
└── io/
    ├── protocol.ts              ALL Zod schemas (requests, responses, catalog, auth)
    └── format.ts                canonical ExecResponse builder, shape detector
```

## Request lifecycle

### Middleware stack (every request)

```
requestId           → X-Request-Id (UUID)
workerIdHeader      → X-Worker-Id (stable per-process id for LB affinity)
apiVersionHeader    → X-API-Version: 1 (v1.0 schema lock)
observability       → structured log + Prometheus metrics (route label bounded)
drainGate           → 503 SERVICE_UNAVAILABLE on mutating ops during shutdown
bodyLimit           → 413 PAYLOAD_TOO_LARGE if over A2E_MAX_REQUEST_BYTES
auth                → 401 UNAUTHORIZED if bearer missing/invalid (disabled when tokens list empty)
rateLimit           → 429 RATE_LIMITED per-session; separate bucket on POST /sessions
```

Unauthenticated routes: `GET /healthz`, `GET /metrics`. Both always return; neither gated by drainGate so k8s probes and scrapers keep working through shutdown.

### `POST /sessions`

```
request
  ├── middleware stack (above)
  └── route handler
      ├── JSON parse                  → 400 PARSE_ERROR on malformed
      ├── Zod schema validation       → 400 PARSE_ERROR on unknown fields, etc.
      └── manager.create(req)
          ├── resolvePolicy()         → merges env defaults + request overrides
          ├── build redactor          → includes auth.env_var if catalog+token
          ├── validateEnvMap          → 400 on reserved keys / invalid names
          ├── validateCwd             → 400 on relative / missing / not-directory
          ├── mkdir sessions/<id>
          ├── if req.catalog:
          │     bootstrapCatalog()    → {buildGitAuth, cache.materialize ×2, compute reachability}
          │     on failure → rm -rf sessions/<id>, throw
          ├── createSession()         → in-memory Session object
          ├── sessions.set(id, ...)
          └── if persistenceEnabled: session.touchForPersistence() + await flush()
                                     → state.json on disk before 201 returns
      └── return 201 + CreateSessionResponse
```

### `POST /sessions/:id/exec`

```
request
  ├── middleware stack (auth + drainGate + rateLimit by session id)
  └── route handler
      ├── JSON parse + schema         → 400 PARSE_ERROR
      ├── manager.get(id)             → 404 NOT_FOUND / 409 CONFLICT (expired)
      ├── if Accept: text/event-stream → stream path (SSE)
      ├── if idempotency_key:
      │     session.idempotencyInflight() → await live promise if racing
      │     session.idempotencyGet()  → on hit, replay + transcript + 200
      ├── executeTurn(session, req)   → see below
      ├── session.idempotencyPut()
      ├── session.appendTranscript()  → redactor + JSONL append + byte cap (rotates on threshold)
      ├── await session.flush()       → persistence write durable before 200 (noop if off)
      └── return 200 + ExecResponse

SSE variant emits: start → {stdout,stderr}* → done (canonical ExecResponse) → flush
```

### `POST /sessions/:id/resume` (experimental)

Requires `A2E_SESSION_PERSISTENCE=true`. Reads `sessions/<id>/state.json`, validates `schema_version`, reconstructs the in-memory `Session` (cwd, env overlay, bindings, turn counter, transcript metadata). Returns the same shape as `POST /sessions`. Best-effort: cross-worker coordination is out of scope — pin the `X-Worker-Id` you got on create.

### `executeTurn` pipeline

```
req.command
  └── interpolate(command, bindings)
      ├── generic /${...}/ scan       → INTERPOLATION_REJECTED if any ≠ ${$name}
      └── replace ${$name}            → SCOPE_MISS if binding missing

interpolated
  └── classifyIntercept(interpolated)
      ├── if cd/export/unset pure     → applyIntercept()
      │     ├── cd: stat + setCwd     → UPSTREAM_ERROR if not a dir
      │     ├── export: setEnv
      │     └── unset: unsetEnv
      │     └── return [exit 0] intercept response
      └── else spawn path

spawn path
  ├── enforceBinaryAllowlist          → CAPABILITY_DENIED on $( / ` / blocked builtin / unknown binary
  ├── interpolate(stdin)              → INTERPOLATION_REJECTED / SCOPE_MISS
  ├── buildSubprocessEnv              → HOME/USER/LANG + overlay + PATH from policy + catalog envs
  ├── run(command, cwd, env, ...)     → spawn bash -c, stream stdout/stderr with cap
  ├── redactor.redact(stdout, stderr) → scrub secrets
  ├── format(...)                     → { status_line, shape, preview, stderr, truncated, binding }
  ├── if bind_as:
  │     session.bind(name, binding)   → SIZE_LIMIT if caps exceeded
  └── return response
```

## Security model

### Trust boundary

The LLM is treated as **hostile** from the server's perspective:

- Its output (`command`, `stdin`, `bind_as` name) is untrusted input.
- Its goals are not relevant; what matters is the **alphabet of effects reachable** from the subprocess given the session's policy.

### Enforcement layers (in order)

1. **Zod schema** — structural validation. Strict objects reject unknown fields.
2. **Key/path validation** — reserved env keys rejected; cwd must be absolute, exist, resolve without symlinks, and lie within `A2E_ALLOWED_CWD_PREFIXES`.
3. **Interpolation** — only `${$bare_name}` tokens accepted. Any other `${...}` form rejected.
4. **Command substitution rejected** — `$(...)` and backticks trigger `CAPABILITY_DENIED` at parse.
5. **Binary allowlist** — static parse of the command splits on shell operators, checks argv[0] of each segment against `SAFE_BUILTINS ∪ binaries_allowlist \ BLOCKED_BUILTINS`.
6. **Reserved env at mutation time** — `session.setEnv` / `unsetEnv` throw `CAPABILITY_DENIED` on any reserved key. This is the choke point for both `export`/`unset` intercepts AND PATCH `/env`, so `LD_PRELOAD` / `A2E_CATALOG_*` / etc. cannot be shadowed through any path.
7. **Subprocess isolation** — `spawn` invokes an absolute bash path (resolved at startup) with argv-array (never `shell: true` with concatenation), explicit cwd, custom env (no inheritance of host PATH or secrets not in overlay; catalog env vars applied AFTER overlay so they win), timeout, streaming size cap.
8. **Redactor** — scrubs known secret values from stdout/stderr before anything reaches the formatter.
9. **Transcript redaction** — secrets that might appear in the request body (in `command`, `stdin`) are scrubbed from the serialized JSONL entry before write.
10. **HTTP error redaction** — server-level redactor runs over all `A2EError.message` values in `onError`.
11. **Rate limiting** — per-session and per-caller-on-create limiters cap request volume at the app layer.

### What the LLM cannot do

- Escape the subprocess into the parent Node process (no `eval`, no `vm`, no `isolated-vm`, no FFI).
- Source arbitrary code (`source`, `.`, `eval` blocked at the allowlist layer).
- Exfiltrate credentials (never inherits the parent env — only HOME/USER/LANG/LC_ALL + session overlay + PATH derived from allowlist + catalog env).
- Hijack the dynamic linker (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, etc.): reserved-env enforcement in `session.setEnv` blocks both intercept and PATCH paths.
- Shadow catalog paths (`A2E_CATALOG_*` also reserved; and even if enforcement were missed, the catalog env is applied AFTER overlay when building subprocess env).
- Point `initial_cwd` or PATCH cwd at arbitrary paths: canonical path must lie within `A2E_ALLOWED_CWD_PREFIXES`, and symlink-resolution divergence is rejected.
- Bypass PATH via inline env: the allowlist enforcer strips leading `KEY=val` prefixes before checking argv[0].
- Hide in command substitution: `$(...)` and backticks rejected.
- Break out via quoted operators: the segment splitter respects `"..."` and `'...'`.
- Leak secrets via transcript or HTTP error messages: both pass through the redactor.
- Cause concurrent exec duplication under network retries: idempotency key uses both a cache AND an in-flight promise map, collapsing concurrent same-key calls to a single execution.

### What the LLM *could* do within the rules

- Pipe large data through `curl` to any domain resolvable by the subprocess — the HTTP domain allowlist is NOT enforced at the app layer (v1 limitation). Operators needing egress control must run inside a network namespace with firewall.
- DoS a single session via infinite loops — bounded by `max_exec_timeout_ms` + `RATE_LIMITED`.
- Fill session binding memory — bounded by binding caps.
- Fill transcript disk — bounded by transcript cap (exec starts failing with `SIZE_LIMIT`).

### What the OPERATOR can do wrong

- Set `A2E_AUTH_TOKENS` empty in production → any client can create sessions.
- Forget to add a credential env var name to `A2E_REDACT_ENV_KEYS` → it can leak via stderr that passes through the redactor but doesn't match.
- Mount a shared volume as `A2E_SESSIONS_DIR` → cross-session leaks possible via catalog cache.
- Leave `http_domains_allowlist` empty and not deploy an egress firewall → agents can reach anywhere on the internet.

## Session state lifecycle

```
CREATED                  after manager.create() returns — registered in Map
  │
  ├── bindings grow       bind() adds entries; hits caps → SIZE_LIMIT
  ├── cwd mutates         via `cd <path>` intercept OR PATCH /cwd
  ├── env mutates         via export/unset intercept OR PATCH /env
  └── transcript grows    every exec appends one line
  │
TERMINATED               via DELETE OR TTL expiry OR sweepExpired
  ├── session removed from Map
  ├── sessionsDir/<id> rm -rf (synchronous on DELETE, async on sweep/expiry)
  └── git worktree prune on mirror (fire-and-forget)
```

## Failure modes and handling

| Failure | Where caught | Response |
|---|---|---|
| Malformed request body | route + Zod | 400 `PARSE_ERROR` |
| Missing / invalid bearer | `auth` middleware | 401 `UNAUTHORIZED` |
| Unknown session | `manager.get` | 404 `NOT_FOUND` |
| Expired session on get | `manager.get` | 409 `CONFLICT` + cleanup |
| Mutating op during drain | `drainGate` | 503 `SERVICE_UNAVAILABLE` |
| Rate limit exceeded | `rateLimit` | 429 `RATE_LIMITED` |
| Catalog auth env var missing | `buildGitAuth` | 403 `CAPABILITY_DENIED` |
| Catalog ref not resolvable | `cache.resolveSha` → bubbles | 500 `UPSTREAM_ERROR` + cleanup |
| Catalog clone times out | `cache.runGit` | 500 `TIMEOUT` or `UPSTREAM_ERROR` + cleanup |
| Interpolation malformed | `interpolate` | 200 `ExecResponse.error: INTERPOLATION_REJECTED` |
| Binding missing | `interpolate` | 200 `ExecResponse.error: SCOPE_MISS` |
| Binary not allowed | `enforceBinaryAllowlist` | 200 `ExecResponse.error: CAPABILITY_DENIED` |
| Exec timeout | `run.ts` timer | 200 `ExecResponse.error: TIMEOUT` |
| Binding too big | `session.bind` | 200 `ExecResponse.error: SIZE_LIMIT` |
| Transcript full | `session.appendTranscript` | 200 `ExecResponse` + transcript append fails on NEXT exec |
| Stdin write EPIPE | `run.ts` stdin.on('error') | Swallowed; exit code tells the story |
| Subprocess crashes | `run.ts` close event | 200 with actual exit code |
| Persistence write failure | `runFlush` | logged as `session.persist.failed`; response still sent (state kept in memory) |
| Hono internal error | `app.onError` | 500 `INTERNAL` |

## Concurrency

- **Session Map access**: single-threaded (Node event loop), no races within a process.
- **Catalog cache coalescing**: multiple sessions requesting the same `repo_url` share one in-flight promise for mirror setup. Cross-process races resolved via atomic `open(path, 'wx')` flock with stale-stealing.
- **Idempotency on /exec**: per-session `Map<key, Promise<ExecResponse>>` inflight tracker plus TTL-bounded response cache coalesces concurrent duplicate requests to a single execution.
- **Rate limit counter**: per-session Map, single-threaded. Timer-based GC (`setInterval.unref()`).
- **Transcript appends**: each session is a single event-loop consumer — no interleaving. Rotates at 80% of the size cap.
- **Persistence flush**: `markDirty()` sets a flag and kicks off an async writer; mutation routes `await session.flush()` before 200 so a crash doesn't silently drop the turn. Coalescing: multiple markDirty() calls during one write collapse to a single follow-up write.
- **Multi-process deployments**: each worker has its own Map + cache. Session routing must be sticky via `X-Worker-Id` (every response carries it). Shared cache across workers requires pointing all workers at the same `A2E_CATALOG_CACHE_DIR`.

## Graceful shutdown

```
SIGTERM / SIGINT
  └── lifecycle.beginDrain()            state: accepting → draining
      ├── drainGate now rejects mutating ops with 503 SERVICE_UNAVAILABLE
      ├── GET /healthz, GET /metrics still serve (probes/scrapers)
      └── GET reads on existing sessions still serve
  └── lifecycle.waitForDrain(timeoutMs)
      ├── resolves when in-flight counter hits 0, OR
      └── rejects after A2E_GRACE_PERIOD_MS
  └── server.close()                    stop accepting connections
  └── catalogCache.shutdown()           clear sweep interval
  └── logger.flush()
  └── setTimeout(200ms) → process.exit(cleanDrain ? 0 : 1)
```

`A2E_GRACE_PERIOD_MS` must be strictly below the orchestrator's kill timeout (`terminationGracePeriodSeconds` in k8s, `stop_grace_period` in Compose). All three `deploy/` templates enforce that ratio.

## Testing

- **Unit tests** (`tests/unit/`): pure functions with no subprocess. Run on any platform with Node 22.
- **Integration tests** (`tests/integration/`): Hono `app.request` against the full middleware stack with in-memory manager.
- **Cache tests** invoke real `git` via `sh`. On Windows, `tests/setup.ts` resolves Git-for-Windows bash.
- **Benchmarks** (`tests/benchmarks/`): `http.bench.ts` (p95 SLO gate, runs in CI) and `tokens.ts` (prompt-token savings vs raw dump).

Total: **133 tests**, ~20s. CI runs typecheck + full suite + bench on every PR.

## Version

**v1.0.0-rc.3**. Schema lock in effect: HTTP routes, response headers, error codes, and env var names are a stable contract. Additive changes land as minors; breaking changes ship under `/v2/*`. See [CHANGELOG.md](../CHANGELOG.md) for the frozen surface per release.
