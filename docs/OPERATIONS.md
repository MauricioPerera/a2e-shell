# Operations

Environment variables, deployment modes, Dockerfile, and capability configuration.

## Environment variables

### Server / transport

| Var | Default | Effect |
|---|---|---|
| `A2E_PORT` | `8080` | TCP port for HTTP listener |
| `A2E_SESSIONS_DIR` | `./sessions` | Filesystem root for session directories (transcripts, catalogs, cache) |
| `A2E_MAX_REQUEST_BYTES` | `1048576` (1 MiB) | Per-request body limit enforced by `Content-Length` check |
| `A2E_AUTH_TOKENS` | (empty) | Comma-separated bearer tokens. Empty = auth disabled (dev only) |
| `A2E_RATE_LIMIT_PER_MINUTE` | `120` | Per-session cap on `/sessions/:id` and `/sessions/:id/*`; `0` = disabled |
| `A2E_RATE_LIMIT_CREATE_PER_MINUTE` | `20` | Cap on `POST /sessions` (keyed by bearer token, else `anon`); `0` = disabled |
| `A2E_ALLOWED_CWD_PREFIXES` | `<sessionsDir>` | Comma-separated absolute prefixes allowed for `initial_cwd` / PATCH cwd. Empty env = default (sessionsDir only) |
| `A2E_LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `A2E_WORKER_ID` | random uuid | Stable id for this process. Emitted as `X-Worker-Id` on every response; load balancers MUST honor it for session affinity in multi-worker deployments |
| `A2E_GRACE_PERIOD_MS` | `30000` | Max time to wait for in-flight requests before forcing exit on SIGTERM/SIGINT. Keep strictly below your orchestrator's kill timeout (e.g. Kubernetes `terminationGracePeriodSeconds`) |
| `A2E_PID_FILE` | (unset) | If set, the node process writes its real PID here at startup. Use this (not shell `$!`) when the launch command includes env-var prefixes, which can fork an intermediate subshell |
| `A2E_SESSION_PERSISTENCE` | `false` | **Experimental.** When `true`, sessions write state.json atomically on every mutation. Enables `POST /sessions/:id/resume` to rebuild state after process restarts. Binding values are stored inline — disk cost scales with active bindings |

### TLS (opt-in)

| Var | Default | Effect |
|---|---|---|
| `A2E_TLS_CERT_PATH` | (unset) | Path to PEM certificate. When set together with `A2E_TLS_KEY_PATH`, the server listens over HTTPS instead of HTTP |
| `A2E_TLS_KEY_PATH` | (unset) | Path to PEM private key. Must be set together with `A2E_TLS_CERT_PATH` |
| `A2E_TLS_CLIENT_CA_PATH` | (unset) | Path to PEM CA bundle. When set (and TLS is on), enables mTLS: clients must present a certificate signed by this CA (`requestCert` + `rejectUnauthorized`) |

TLS is optional because the typical deployment terminates TLS at an ingress (ALB, nginx, Envoy, Caddy). Turn it on only when a2e-shell faces the network directly. mTLS is the recommended posture when exposing the server without a TLS-terminating proxy in front.

### Credential redaction

| Var | Default | Effect |
|---|---|---|
| `A2E_REDACT_ENV_KEYS` | (empty) | Comma-separated env var names. Their values are scrubbed from all subprocess output, transcripts, and HTTP error messages (server-level redactor). |

Values shorter than 8 characters are ignored (defense against trivial literals being redacted).

### Default session policy

All can be overridden per-session via the `capabilities` request field.

| Var | Default | Effect |
|---|---|---|
| `A2E_DEFAULT_BINARIES_ALLOWLIST` | `curl,jq,gh,aws,kubectl,git,grep,sed,awk,rg,head,tail,wc,cut,sort,uniq,xargs,pwd,echo,cat` | Binaries allowed via `call <bin>` or bare invocation |
| `A2E_DEFAULT_HTTP_DOMAINS_ALLOWLIST` | (empty) | Stored for audit; NOT enforced in v1 (requires network-namespace firewall) |
| `A2E_DEFAULT_MAX_EXEC_TIMEOUT_MS` | `30000` | Max per-exec wall-clock timeout |
| `A2E_DEFAULT_MAX_RESPONSE_BYTES` | `262144` (256 KiB) | Stdout/stderr truncation threshold |
| `A2E_DEFAULT_MAX_SESSION_TTL_S` | `3600` (1 h) | Session lifetime from creation |
| `A2E_DEFAULT_PREVIEW_BYTES` | `2048` | Preview length in exec response |
| `A2E_DEFAULT_STDERR_PREVIEW_BYTES` | `2048` | Stderr tail length in exec response |
| `A2E_DEFAULT_MAX_BINDINGS` | `128` | Binding count cap per session |
| `A2E_DEFAULT_MAX_BINDING_BYTES` | `10485760` (10 MiB) | Size cap for a single binding |
| `A2E_DEFAULT_MAX_TOTAL_BINDING_BYTES` | `52428800` (50 MiB) | Aggregate binding size cap per session |
| `A2E_DEFAULT_MAX_TRANSCRIPT_BYTES` | `104857600` (100 MiB) | Transcript file size cap before new turns fail with `SIZE_LIMIT` |

### Catalog cache

| Var | Default | Effect |
|---|---|---|
| `A2E_CATALOG_CACHE_ENABLED` | `true` | Shared bare mirror per repo_url. `false` → each session clones directly |
| `A2E_CATALOG_CACHE_DIR` | `<A2E_SESSIONS_DIR>/.catalog-cache` | Where bare mirrors live |
| `A2E_CATALOG_CACHE_REFRESH_S` | `60` | Branch/tag refetch interval. SHA refs never refresh |
| `A2E_CATALOG_CACHE_FILTER_BLOBS` | `true` | Apply `--filter=blob:none` to mirror clones. HTTPS-only benefit; file:// ignores |
| `A2E_CATALOG_CACHE_MAX_BYTES` | `2147483648` (2 GiB) | Soft cap for the cache directory. LRU sweep evicts idle mirrors over this size. `0` = unbounded |
| `A2E_CATALOG_CACHE_SWEEP_INTERVAL_S` | `300` | Background sweep interval for worktree-prune + LRU eviction. `0` disables |
| `A2E_CATALOG_BOOTSTRAP_TIMEOUT_MS` | `60000` | Per-git-operation timeout during session bootstrap |

### Subprocess runtime

| Var | Default | Effect |
|---|---|---|
| `A2E_BASH_PATH` | `bash` | Path to bash binary. Override for Windows Git Bash or custom builds |

## Deployment

### Docker (recommended)

The shipped [Dockerfile](../Dockerfile) produces a Debian-slim image with Node 22 and a base CLI set (`curl`, `jq`, `gh`, `aws-cli`, `kubectl`, `git`, `grep`, `sed`, `gawk`, `ripgrep`). Runs as non-root UID 10001.

```dockerfile
# Extend the base image with your tools:
FROM a2e-shell:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends mycustom-cli \
    && rm -rf /var/lib/apt/lists/*
USER a2e
```

Then add to `A2E_DEFAULT_BINARIES_ALLOWLIST`. The deployer owns the capability surface.

### Direct node

```bash
npm ci --omit=dev
npm run build
NODE_ENV=production node dist/index.js
```

Requires `bash`, `git`, and any allowlisted CLIs present in `PATH`.

## Auth configuration

### Single shared token

```bash
A2E_AUTH_TOKENS="$(openssl rand -hex 32)"
```

### Multiple tokens (e.g. per-client)

```bash
A2E_AUTH_TOKENS="token-for-client-a,token-for-client-b"
```

Tokens are compared literally against `Authorization: Bearer <token>`. No scopes in v1 — tokens are equivalent keys.

### Disabled (dev only)

Leave `A2E_AUTH_TOKENS` empty. **Do not deploy without auth**: a session with a catalog clones arbitrary URLs on your server.

## Private repos: credential wiring

### HTTPS with PAT (GitHub/GitLab/Bitbucket)

```bash
# On the server
export GITHUB_TOKEN=ghp_xxx...
export A2E_REDACT_ENV_KEYS=GITHUB_TOKEN

# Client creates session with:
{
  "catalog": {
    "repo_url": "https://github.com/org/private-repo",
    "auth": { "type": "token", "env_var": "GITHUB_TOKEN" }
  }
}
```

The server resolves `GITHUB_TOKEN` at bootstrap time and injects it as `Authorization: Basic base64(x-access-token:$GITHUB_TOKEN)` via `-c http.extraheader`. The token value is added to the session redactor automatically.

### SSH with key

```bash
# On the server
export MY_DEPLOY_KEY=/secrets/github-deploy-key
export MY_KNOWN_HOSTS=/secrets/known_hosts

# Client creates session with:
{
  "catalog": {
    "repo_url": "git@github.com:org/private-repo.git",
    "auth": {
      "type": "ssh_key",
      "key_path_env_var": "MY_DEPLOY_KEY",
      "known_hosts_env_var": "MY_KNOWN_HOSTS"
    }
  }
}
```

The server builds `GIT_SSH_COMMAND='ssh -i /secrets/github-deploy-key -o UserKnownHostsFile=/secrets/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes'` and injects it as subprocess env for every git call.

Without `known_hosts_env_var`: `StrictHostKeyChecking=accept-new` (trust-on-first-use). Fine for ephemeral CI; not for long-running servers — use explicit `known_hosts` in production.

## Caps and limits — decision tree

### Binding caps hit: `SIZE_LIMIT`

- Single binding too big → narrow upstream (pipe through `jq`/`head`/`grep` before `bind_as`).
- Too many bindings → reuse a scratch binding, or drop old ones (overwriting by same name is free).
- Aggregate too big → same as above.

Adjust `A2E_DEFAULT_MAX_BINDING_BYTES` / `A2E_DEFAULT_MAX_BINDINGS` / `A2E_DEFAULT_MAX_TOTAL_BINDING_BYTES` if real workload needs more. Don't raise blindly — LLMs are prone to runaway binding loops.

### Transcript size hit: `SIZE_LIMIT`

Transcript grows append-only. When size limit is reached, new execs fail. Options:

- End session and start fresh (normal).
- Raise `A2E_DEFAULT_MAX_TRANSCRIPT_BYTES`.
- Reduce verbosity: use `bind_as` more (binding metadata is lightweight; raw output isn't in transcript).

### Rate limit hit: `RATE_LIMITED`

Default 120/min per session. Raise for automation batches, lower for user-driven sessions. Set to `0` to disable entirely (e.g. behind an authenticated reverse proxy that handles rate limiting at a higher layer).

### Exec timeout hit: `TIMEOUT`

Don't just raise `timeout_ms`. Split the work: `head`-limit the input, paginate the API call, break iterations into batches with `xargs -n`.

## Observability

### Structured logs

JSON lines on stdout via `pino`. Every request, session lifecycle event, exec, and catalog mirror operation emits a structured event with `request_id`, `session_id`, `duration_ms`, and a stable `event` field (`http.request`, `session.created`, `session.deleted`, `session.expired`, `exec`, `catalog.bootstrap.ok`, `catalog.bootstrap.failed`, `catalog.mirror.created`, `catalog.mirror.refreshed`, `http.error`, `http.error.unhandled`, `server.listening`).

Config: `A2E_LOG_LEVEL=trace|debug|info|warn|error|fatal` (default `info`).

The logger has an internal redaction list for common secret-shaped keys (`authorization`, `token`, `password`, `*.token`, etc.) as a defense-in-depth measure. The primary credential redactor is `A2E_REDACT_ENV_KEYS`, which covers subprocess output and HTTP error messages.

### Prometheus metrics

`GET /metrics` (unauthenticated; place behind a reverse-proxy if restricted) exposes:

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `a2e_http_requests_total` | counter | `route`, `status` | HTTP request volume by route template |
| `a2e_http_request_duration_ms` | histogram | `route` | End-to-end HTTP latency |
| `a2e_sessions_active` | gauge | — | Currently-registered sessions |
| `a2e_sessions_total` | counter | `event` = created/deleted/expired/bootstrap_failed | Session lifecycle volume |
| `a2e_exec_duration_ms` | histogram | — | Exec turn duration (includes pipeline overhead) |
| `a2e_exec_total` | counter | `outcome` = ok/error/intercept | Exec outcomes |
| `a2e_errors_total` | counter | `code` | Error responses by error code |
| `a2e_catalog_mirrors_active` | gauge | — | Active catalog mirrors in cache |
| `a2e_catalog_mirror_events_total` | counter | `event` = created/refreshed/pruned | Mirror lifecycle volume |
| `a2e_rate_limit_hits_total` | counter | `bucket` = session/create | Rate-limit rejection volume |
| `a2e_redactor_secrets_count` | gauge | — | Secrets loaded into server-level redactor |

Plus default Node process metrics (heap, event-loop lag, file descriptors) from `prom-client`.

### Correlation

`request_id` (uuid) is in every log line, in every HTTP error response body, and in the response header `X-Request-Id`. Per-session audit is `GET /sessions/:id/transcript` (JSONL); per-session snapshot is `GET /sessions/:id/state`.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the process transitions through three lifecycle states:

1. **`accepting`** → default. All requests pass through.
2. **`draining`** → `POST /sessions`, `POST /sessions/:id/exec`, PATCH routes, and DELETE return `503 SERVICE_UNAVAILABLE`. `GET /state`, `GET /transcript`, `GET /healthz`, `GET /metrics` still serve (read-only and idempotent ops stay available so orchestrators can observe the shutdown). In-flight mutating ops continue until they finish.
3. **`stopped`** → the HTTP server has been closed; the process exits with code 0 (clean drain) or 1 (grace timeout).

The handler emits one structured log per transition: `server.signal.received`, `server.shutdown.begin` (with `in_flight` count), `server.draining`, `server.shutdown.done` (with `drained_cleanly: boolean`), `server.shutdown.http_closed`.

If `A2E_GRACE_PERIOD_MS` elapses before in-flight reaches 0, the server force-closes HTTP and exits 1. The event log shows `drained_cleanly: false`. Tune this to your longest exec + small slack; set your container orchestrator's kill timeout (e.g. Kubernetes `terminationGracePeriodSeconds`) to at least `A2E_GRACE_PERIOD_MS / 1000 + 5`.

### PID file

Kubernetes and systemd handle signals on their own. For shell-based deployments, use `A2E_PID_FILE`: the node process writes its real PID there at startup, surviving env-var prefix subshell forking that makes `$!` unreliable. Example:

```bash
A2E_PID_FILE=/run/a2e.pid A2E_PORT=8080 node dist/index.js &
# later...
kill -TERM "$(cat /run/a2e.pid)"
```

## Multi-worker deployments

Every session's transcript and catalog worktrees live on one specific worker's disk. Load balancers MUST route a session's subsequent requests to the same worker. The header `X-Worker-Id` on every response is the anchor for sticky routing.

Typical reverse-proxy setup:

- Extract `X-Worker-Id` from the session's create response on the client side.
- Send every follow-up request with `X-Worker-Id: <id>` to the upstream, letting the load balancer pin to that backend.
- Alternative: cookie-based affinity where the cookie value is the session_id; hash consistently to the backend that created the session.

**Shared catalog cache across workers**: the cache dir can safely be on a shared volume (network filesystem). Mirror creation is guarded by an advisory file lock at `<cache_dir>/<repo_hash>/.lock` (exclusive-create, stolen after 10 min idle). Concurrent workers either share an existing mirror read-only or wait for the lock holder to finish cloning — no duplicate clones, no partial-directory corruption.

## Cleanup and lifecycle

- **DELETE** is synchronous for disk cleanup (session dir removed before 204 returns). Worktree prune on the mirror is fire-and-forget.
- **Expired sessions** are swept every 60s by a background interval. Same cleanup behavior.
- **Cache mirror** is LRU-swept every `A2E_CATALOG_CACHE_SWEEP_INTERVAL_S` (default 5 min): `git worktree prune` runs on every mirror, then mirrors without live worktrees are evicted oldest-first until total disk is under `A2E_CATALOG_CACHE_MAX_BYTES` (default 2 GiB). Mirrors with active worktrees are never evicted. Setting `maxBytes=0` disables eviction entirely (unbounded growth — prune only).
- **Session directories** that escape cleanup (process crash mid-session) persist until manually removed. `A2E_SESSIONS_DIR` should be on a volume you can wipe on redeploy.

## Hardening checklist for production

- [ ] `A2E_AUTH_TOKENS` set to a rotated secret
- [ ] `A2E_REDACT_ENV_KEYS` includes every credential the server holds
- [ ] `A2E_DEFAULT_BINARIES_ALLOWLIST` curated — remove what you don't need
- [ ] `A2E_RATE_LIMIT_PER_MINUTE` sized for expected load
- [ ] Egress firewall restricting outbound network to known domains (since `http_domains_allowlist` is not enforced at the app layer)
- [ ] TLS termination in front (reverse proxy) — the server speaks plain HTTP
- [ ] Sessions volume monitored for disk pressure
- [ ] Catalog cache dir on a volume with auto-snapshot rotation or size cap
- [ ] Container runs non-root (the shipped Dockerfile does this; preserve it)
