# Architecture

Internal module layout, request lifecycle, security model, and failure modes.

## Module layout

```
src/
├── index.ts                     entry: env parse, cache init, manager init, app build, listen
├── errors.ts                    ErrorCode enum, A2EError class, httpStatusForCode table
├── http/
│   ├── server.ts                Hono app build, middleware stack, onError serializer
│   └── routes/
│       ├── sessions.ts          POST /sessions, DELETE /sessions/:id
│       ├── exec.ts              POST /sessions/:id/exec (+ idempotency handling)
│       ├── state.ts             GET /state, PATCH /cwd, PATCH /env, GET /transcript
│       └── replay.ts            POST /sessions/:id/replay
├── session/
│   ├── manager.ts               registry of live sessions, create+get+delete+sweep
│   ├── state.ts                 Session factory: cwd, env overlay, bindings, idempotency cache
│   ├── transcript.ts            JSONL append-only, read iterator, hashFinal
│   └── validation.ts            shared validators for cwd, env, reserved keys (create + PATCH)
├── exec/
│   ├── pipeline.ts              orchestrator for a single turn
│   ├── interpolate.ts           ${$var} resolver with strict regex
│   ├── state-intercept.ts       cd/export/unset classifier (pure)
│   └── run.ts                   spawn bash -c with argv-array, streaming truncation
├── capabilities/
│   └── policy.ts                policy resolver + enforceBinaryAllowlist + isBinaryReachable
├── credentials/
│   └── redactor.ts              byte-level scrubber, longest-match replacement
├── catalog/
│   ├── bootstrap.ts             orchestrates index+content materialization, builds auth args+env
│   ├── cache.ts                 bare mirror + worktree + concurrency coalescing
│   └── reachability.ts          static analysis skills.requires ↔ policy.binaries_allowlist
└── io/
    ├── protocol.ts              ALL Zod schemas (requests, responses, catalog, auth)
    └── format.ts                canonical ExecResponse builder, shape detector
```

## Request lifecycle

### `POST /sessions`

```
request
  ├── requestId middleware           → set X-Request-Id
  ├── bodyLimit middleware            → 413 if > A2E_MAX_REQUEST_BYTES
  ├── auth middleware                 → 401 if bearer missing/invalid
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
          └── sessions.set(id, ...)
      └── return 201 + CreateSessionResponse
```

### `POST /sessions/:id/exec`

```
request
  ├── requestId
  ├── bodyLimit
  ├── auth
  ├── rateLimit                       → 429 if over A2E_RATE_LIMIT_PER_MINUTE
  └── route handler
      ├── JSON parse + schema         → 400 PARSE_ERROR
      ├── manager.get(id)             → 404 NOT_FOUND / 409 CONFLICT (expired)
      ├── if idempotency_key:
      │     session.idempotencyGet()  → on hit, return cached + transcript
      ├── executeTurn(session, req)   → see below
      ├── session.idempotencyPut()
      ├── session.appendTranscript()  → redactor + JSONL append + byte cap
      └── return 200 + ExecResponse
```

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
2. **Key/path validation** — reserved env keys rejected, cwd must be absolute+existing+directory.
3. **Interpolation** — only `${$bare_name}` tokens accepted. Any other `${...}` form rejected.
4. **Command substitution rejected** — `$(...)` and backticks trigger `CAPABILITY_DENIED` at parse.
5. **Binary allowlist** — static parse of the command splits on shell operators, checks argv[0] of each segment against `SAFE_BUILTINS ∪ binaries_allowlist \ BLOCKED_BUILTINS`.
6. **Subprocess isolation** — `spawn bash -c <cmd>` with argv-array (never `shell: true` with concatenation), explicit cwd, custom env (no inheritance of host PATH or secrets not in overlay), timeout, streaming size cap.
7. **Redactor** — scrubs known secret values from stdout/stderr before anything reaches the formatter.
8. **Transcript redaction** — secrets that might appear in the request body (in `command`, `stdin`) are scrubbed from the serialized JSONL entry before write.
9. **HTTP error redaction** — server-level redactor runs over all `A2EError.message` values in `onError`.

### What the LLM cannot do

- Escape the subprocess into the parent Node process (no `eval`, no `vm`, no `isolated-vm`, no FFI).
- Source arbitrary code (`source`, `.`, `eval` blocked at the allowlist layer).
- Exfiltrate credentials (never inherits the parent env — only HOME/USER/LANG/LC_ALL + session overlay + PATH derived from allowlist).
- Bypass PATH via inline env: the allowlist enforcer strips leading `KEY=val` prefixes before checking argv[0].
- Hide in command substitution: `$(...)` and backticks rejected.
- Break out via quoted operators: the segment splitter respects `"..."` and `'...'`.
- Leak secrets via transcript or HTTP error messages: both pass through the redactor.

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
| Unknown session | `manager.get` | 404 `NOT_FOUND` |
| Expired session on get | `manager.get` | 409 `CONFLICT` + cleanup |
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
| Hono internal error | `app.onError` | 500 `INTERNAL` |

## Concurrency

- **Session Map access**: single-threaded (Node event loop), no races within a process.
- **Catalog cache coalescing**: multiple sessions requesting the same `repo_url` share one in-flight promise for mirror setup.
- **Rate limit counter**: per-session Map, also single-threaded.
- **Transcript appends**: each session is a single event-loop consumer — no interleaving.
- **Multi-process deployments**: each worker has its own Map + cache. Session routing must be sticky (reverse proxy) OR sessions restricted to a single worker. Shared cache across workers requires pointing all workers at the same `A2E_CATALOG_CACHE_DIR` — git operations hold their own locks.

## Testing

- **Unit tests** (`tests/unit/`): pure functions with no subprocess. Run on any platform with Node 22. 95 tests, <1s.
- **Integration tests** (`tests/integration/`): Hono `app.request` against the full middleware stack with in-memory manager. 12 tests, <100ms total.
- **Cache tests** invoke real `git` via `sh` — Linux only. Skipped on Windows by default.

Coverage by concern:

| Concern | Tests |
|---|---|
| interpolation grammar | 10 |
| state intercept classifier | 10 |
| binary allowlist + substitution rejection | 12 |
| credential redactor | 7 |
| canonical formatter (incl. stderr + truncated) | 18 |
| catalog auth spec schema | 13 |
| git auth builder (token + ssh_key) | 9 |
| catalog cache + concurrency + filter | 5 |
| reachability analysis | 8 |
| HTTP routes + auth + rate limit | 12 |

## Version

v0.1. Breaking changes allowed freely. v1.0 will lock the HTTP schemas and env var names.
