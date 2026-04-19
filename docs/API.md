# HTTP API reference

Request-response over HTTP/1.1. `Content-Type: application/json` on all requests with bodies. Auth via `Authorization: Bearer <token>` when the server is configured with tokens.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe. No auth required. |
| POST | `/sessions` | Create a session. |
| DELETE | `/sessions/:id` | Terminate a session. Awaits disk cleanup. |
| POST | `/sessions/:id/exec` | Execute a command. |
| GET | `/sessions/:id/state` | Session snapshot. |
| PATCH | `/sessions/:id/cwd` | Set cwd (validated). |
| PATCH | `/sessions/:id/env` | Set/unset env vars (validated). |
| GET | `/sessions/:id/transcript` | Full JSONL transcript. |
| POST | `/sessions/:id/replay` | Integrity hash of transcript responses. |

## HTTP codes

| Code | Meaning |
|---|---|
| `200` | OK (also for exec-level errors returned in response body) |
| `201` | Session created |
| `204` | Session deleted |
| `400` | Payload malformed or validation failed (`PARSE_ERROR`) |
| `401` | Missing / invalid bearer (`UNAUTHORIZED`) |
| `403` | Capability denied at session level (`CAPABILITY_DENIED`) |
| `404` | Session or resource not found (`NOT_FOUND`) |
| `409` | Session expired or transcript empty (`CONFLICT`) |
| `413` | Request body over `A2E_MAX_REQUEST_BYTES` (`PAYLOAD_TOO_LARGE`) |
| `429` | Rate limit exceeded (`RATE_LIMITED`) |
| `500` | Internal error (`INTERNAL`) |

Error responses:

```json
{ "error": "ERROR_CODE", "request_id": "uuid", "message": "optional human-readable" }
```

The `message` field passes through a server-level redactor built from `A2E_REDACT_ENV_KEYS`.

## Error codes inventory

`PARSE_ERROR` · `CAPABILITY_DENIED` · `INTERPOLATION_REJECTED` · `SCOPE_MISS` · `TIMEOUT` · `SIZE_LIMIT` · `UPSTREAM_ERROR` · `INTERNAL` · `UNAUTHORIZED` · `NOT_FOUND` · `CONFLICT` · `PAYLOAD_TOO_LARGE` · `RATE_LIMITED` · `NOT_IMPLEMENTED_V1`.

Some codes (`TIMEOUT`, `SIZE_LIMIT`, `UPSTREAM_ERROR`, `INTERPOLATION_REJECTED`, `SCOPE_MISS`, `CAPABILITY_DENIED`) can appear inside an `ExecResponse.error` at HTTP 200 when the session survives but the specific exec failed.

---

## `POST /sessions`

### Request

```ts
{
  mode?: "unrestricted" | "bounded",    // default "unrestricted" (bounded = v2)
  capabilities?: {
    binaries_allowlist?: string[],
    http_domains_allowlist?: string[],  // stored, not enforced in v1
    max_exec_timeout_ms?: number,
    max_response_bytes?: number,
    max_session_ttl_s?: number
  },
  initial_cwd?: string,                 // absolute, must exist; default: session dir
  initial_env?: Record<string,string>,  // keys must not be reserved
  catalog?: {
    repo_url: string,                   // http(s)://, git@, ssh://, file://
    index_ref?: string,                 // branch, tag, or 40-hex SHA. default: "index"
    content_ref?: string,               // same. default: "main"
    auth?: {
      type: "token",
      env_var: string,                  // UPPER_SNAKE_CASE
      username?: string                 // default "x-access-token"
    } | {
      type: "ssh_key",
      key_path_env_var: string,
      known_hosts_env_var?: string
    }
  }
}
```

### Response — `201 Created`

```ts
{
  session_id: string,                   // uuid v4
  mode: "unrestricted" | "bounded",
  cwd: string,
  expires_at: string,                   // ISO-8601
  catalog: null | {
    index_dir: string,
    content_dir: string,
    index_sha: string,                  // 40-hex
    content_sha: string,                // 40-hex
    manifest_source_sha: string,        // 40-hex
    in_sync: boolean,                   // content_sha === manifest.source_sha
    reachability: {
      total: number,
      reachable: number,
      unreachable: number,
      report_path: string               // points to catalog/reachability.json
    },
    mirror_path: string | null          // null in direct-clone mode
  }
}
```

### Notable errors

- `400 PARSE_ERROR`: malformed body, unknown field (schemas are strict), reserved env key, relative `initial_cwd`, invalid env var name pattern.
- `403 CAPABILITY_DENIED`: catalog auth env var not set; SSH key file missing; known_hosts file missing.
- `500 UPSTREAM_ERROR`: git clone failed (network, auth, ref not found).

On bootstrap failure, the session is NOT registered and the partial dir on disk is removed.

---

## `POST /sessions/:id/exec`

### Request

```ts
{
  command: string,                      // 1..16384 chars; bash-compatible
  bind_as?: string,                     // bare identifier; stores stdout as $<name>
  stdin?: string,                       // literal or "${$var}"
  timeout_ms?: number,                  // capped by policy.max_exec_timeout_ms
  idempotency_key?: string              // 1..128 chars; TTL 5min, cap 128 entries per session
}
```

### Response — `200 OK`

```ts
{
  status_line: string,                  // "[exit N]" | "[error: CODE]"
  shape: string | null,                 // "json<T>[N]" | "jsonl[N]" | "text[Nb]" | "binary[Nb]" | null
  preview: unknown | null,              // first policy.preview_bytes of stdout (truncated)
  binding: string | null,               // "$<name>" if bind_as captured
  stderr: string | null,                // first policy.stderr_preview_bytes of stderr, or null
  truncated: boolean,                   // true if stdout was cut at max_response_bytes
  idempotent_hit?: boolean,             // present and true on cache hits
  error?: { code: ErrorCode, message: string }
}
```

### Exec semantics

1. **Interpolation**: `${$name}` tokens in `command` and `stdin` are resolved from the session's bindings. Any other `${...}` form → `INTERPOLATION_REJECTED`. Missing name → `SCOPE_MISS`.
2. **Intercepts**: commands that trim to exactly `cd <path>`, `export KEY=VALUE`, or `unset KEY [...]` mutate session state without spawning. Compound commands (`cd /x && ls`) do spawn — state change dies with subprocess.
3. **Policy check**: static parse rejects commands that invoke binaries outside `binaries_allowlist` (safe bash builtins allowed; `eval`, `source`, `.` always blocked; `$(...)` / backticks rejected).
4. **Spawn**: `bash -c <command>` with argv-array form, `cwd = session.cwd`, `env = HOME/USER/LANG + session.env_overlay + PATH(allowlist)` plus catalog env if present.
5. **Redactor**: runs over stdout AND stderr before anything is formatted.
6. **Formatter**: produces the canonical response.
7. **Binding**: on `exit 0` with `bind_as`, captures the full redacted stdout. Throws `SIZE_LIMIT` if the binding would exceed `max_binding_bytes`, `max_total_binding_bytes`, or `max_bindings`.
8. **Transcript**: serialized entry + redactor pass + JSONL append.

### Catalog env exposed to subprocess

When the session has a catalog, every exec subprocess sees:

- `$A2E_CATALOG_INDEX` — path to index worktree
- `$A2E_CATALOG_CONTENT` — path to content worktree
- `$A2E_CATALOG_REACHABILITY` — path to `reachability.json`

---

## `PATCH /sessions/:id/cwd`

### Request

```ts
{ cwd: string }                         // absolute, must exist, must be a directory
```

### Response — `200 OK`

Same schema as `GET /sessions/:id/state`.

---

## `PATCH /sessions/:id/env`

### Request

```ts
{
  set?: Record<string,string>,          // values; keys must not be reserved, max 64 total
  unset?: string[]                      // keys; must not be reserved
}
```

Reserved keys rejected: `PATH`, `HOME`, `USER`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_BIND_NOW`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `IFS`, `CDPATH`, `BASH_ENV`, `ENV`, `A2E_CATALOG_INDEX`, `A2E_CATALOG_CONTENT`, `A2E_CATALOG_REACHABILITY` (case-insensitive).

The same list is enforced by `session.setEnv` / `unsetEnv`, so `export LD_PRELOAD=...` or `unset A2E_CATALOG_INDEX` via `POST /exec` also fail with `CAPABILITY_DENIED` (200 + exec-level error body).

### Response — `200 OK`

Same schema as `GET /sessions/:id/state`.

---

## `GET /sessions/:id/state`

### Response — `200 OK`

```ts
{
  session_id: string,
  cwd: string,
  env_overlay_keys: string[],           // names only; values never exposed
  bindings: Record<string, { shape: string, size_bytes: number }>,
  history_size: number,                 // transcript turn count
  expires_at: string
}
```

---

## `GET /sessions/:id/transcript`

### Response — `200 OK`, `Content-Type: application/jsonl`

One JSON object per line:

```ts
{
  t: number,                            // turn index (1-based)
  at: string,                           // ISO-8601
  req: unknown,                         // the normalized request payload
  res: unknown                          // the canonical response
}
```

Entries pass through the session redactor before writing.

---

## `POST /sessions/:id/replay`

### Response — `200 OK`

```ts
{
  replayed: number,                     // transcript entry count
  diverged_at: number | null,           // always null in v1
  final_state_hash: string              // sha256 over concatenated response JSONs
}
```

v1 does NOT re-execute commands — this endpoint verifies that a transcript is structurally intact and produces a stable hash for comparing two sessions.

---

## Auth

Bearer token required for all `/sessions*` routes when `A2E_AUTH_TOKENS` is non-empty. `/healthz` is always unauthenticated.

Auth is NOT scoped (no per-token capabilities in v1). Treat tokens like API keys.

## Rate limiting

Two independent fixed-window (60s) limiters:

- **Per-session** (`A2E_RATE_LIMIT_PER_MINUTE`, default 120): applied to `/sessions/:id` and `/sessions/:id/*`. Keyed by session id.
- **Per-caller on create** (`A2E_RATE_LIMIT_CREATE_PER_MINUTE`, default 20): applied to `POST /sessions`. Keyed by bearer token (or `anon` when auth is disabled). Tighter cap to throttle catalog-clone storms.

Either `0` disables that limiter. Exceeded → `429 RATE_LIMITED`.

## Idempotency

`POST /sessions/:id/exec` with `idempotency_key`:

- First call: executes, stores response in session's in-memory cache (TTL 5min, cap 128).
- Subsequent call with same key within TTL: returns cached response with `idempotent_hit: true`.
- Transcript records both the original turn and the hit (both append).
