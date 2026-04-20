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

### Reference templates

Ready-to-adapt manifests live under [deploy/](../deploy/):

- `deploy/kubernetes/a2e-shell.yaml` — Deployment, Service, Ingress (nginx with sticky cookie + SSE-friendly timeouts), HPA, PDB.
- `deploy/docker-compose.yml` — Single-host VM with Traefik TLS termination via Let's Encrypt.
- `deploy/terraform/aws/` — Terraform module for ECS Fargate + ALB (sticky cookie) + EFS for `/sessions`.

Read `deploy/README.md` before deploying: it documents the non-negotiables (session affinity, termination grace, buffering-off for SSE, secret handling) that every template encodes but that are easy to miss if you adapt them.

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

---

## Runbooks

Each subsection is the landing page for a Prometheus alert's `runbook_url` annotation. All alerts are defined in [`deploy/monitoring/alert.rules.yml`](../deploy/monitoring/alert.rules.yml).

Format: symptoms → immediate checks → remediation → why this happens. Keep edits tight — a runbook that runs past one screen won't get read at 3am.

Prerequisites for every runbook below:

- SSH (Tailscale or direct) to the VPS running a2e-shell.
- `docker`, `curl`, `journalctl` available on the host.
- Grafana open at https://grafana.ardf.dev (the "a2e-shell — overview" dashboard is home).

### service-down

**Alert**: `A2eShellDown` · **Severity**: critical

Prometheus can't reach `/metrics` for 1 minute. The container is down, the port binding is broken, or the Node process is wedged.

**Immediate checks** (30 seconds):

```bash
# Is the container alive?
ssh root@<vps> 'docker ps --filter name=a2e-shell --format "{{.Status}}"'

# Does the app respond on its loopback port?
ssh root@<vps> 'curl -fsS --max-time 5 http://127.0.0.1:8090/healthz'

# Public reachability (through Cloudflare + nginx)
curl -fsSI https://a2e.ardf.dev/healthz
```

**Remediation decision tree**:

| Symptom | Action |
|---|---|
| `docker ps` shows `Exited (code N)` | `docker logs a2e-shell \| tail -50` to see why. If OOM, bump container memory. If crash loop, check for corrupt `sessions` volume. |
| `docker ps` empty (no container) | `docker start a2e-shell` or recreate via [release playbook](RELEASING.md#after-tagging-prod-deploy). |
| Container `Up (unhealthy)` but `/healthz` loops forever | `docker restart a2e-shell`. If restart doesn't clear it, inspect the event loop: `docker exec a2e-shell kill -USR1 1` (dumps async hooks to stderr, visible via `docker logs`). |
| Public 502 but loopback OK | nginx is the problem: `nginx -t && systemctl reload nginx`. |

**Why this happens**: usually one of three: uncaught rejection in an async handler (see [`A2eShellInternalErrorsFiring`](#internal-errors)), memory exhaustion (see [`A2eShellHighMemory`](#high-memory)), or OS-level kill (OOM killer, manual `docker stop`). Check `dmesg \| grep -i kill` if RSS was trending up.

---

### internal-errors

**Alert**: `A2eShellInternalErrorsFiring` · **Severity**: critical

Any `error.code=INTERNAL` means an uncaught exception slipped past all handlers — a bug, not a user error.

**Immediate checks**:

```bash
# The unhandled-error log entries carry the stack trace:
ssh root@<vps> 'docker logs a2e-shell 2>&1 | grep http.error.unhandled | tail -5'

# How many users hit it in the last 5m?
ssh root@<vps> 'curl -sS "http://127.0.0.1:9090/api/v1/query?query=sum(rate(a2e_errors_total\{code=%22INTERNAL%22\}%5B5m%5D))" | jq .data.result[0].value[1]'
```

**Remediation**:

1. **Read the stack trace**. The `err.stack` field in the log entry points to the exact file/line.
2. If the stack references a packaging/asset path (`ERR_MODULE_NOT_FOUND`, `ENOENT: ... /dist/...`), you shipped a bug from the family that broke v1.3.0. See [RELEASING.md postmortem](RELEASING.md#postmortem) — the docker-smoke CI gate exists to catch these. If it somehow slipped through, rebuild with the affected file moved to `dependencies` / copied in the build step.
3. For any other stack: open an issue with the full trace, mark it `bug`, and **keep the broken version running only if the error rate is low**. If `INTERNAL` rate > 1/sec sustained, roll back via the [release playbook](RELEASING.md#hotfix-protocol).

**Why this happens**: the app is designed to convert everything to a canonical `A2EError` with a specific code. `INTERNAL` fires when something escapes that conversion — historically packaging bugs (v1.3.0 peggy / grammar.pegjs) and a few unhandled promise rejections.

---

### high-error-rate

**Alert**: `A2eShellHighErrorRate` · **Severity**: warning

More than 25% of requests over the last 5 minutes returned some error code.

**Immediate checks**:

```bash
# Break the rate down by code to identify the source:
curl -sS -u 'admin:<pw>' 'https://grafana.ardf.dev/api/datasources/proxy/uid/a2e-prometheus/api/v1/query?query=sum%20by%20(code)%20(rate(a2e_errors_total%5B5m%5D))' | jq '.data.result[] | {code: .metric.code, rate: .value[1]}'
```

**Remediation**:

| Dominant code | Likely cause | First step |
|---|---|---|
| `UNAUTHORIZED` | token rotated or client misconfigured | rotate back or fix the client |
| `PARSE_ERROR` | bounded-mode grammar mismatch (agent using wrong syntax) | check [CHANGELOG](../CHANGELOG.md) for grammar changes; LLM prompt may need refresh |
| `CAPABILITY_DENIED` | allowlist too tight or agent asked for unexpected binary | review `A2E_DEFAULT_BINARIES_ALLOWLIST` + per-session `capabilities.binaries_allowlist` |
| `RATE_LIMITED` | see [rate-limit-sustained](#rate-limit-sustained) |
| `SCOPE_MISS` | usually agent-side bug referencing unbound `$var`; benign if isolated |
| `INTERNAL` | see [internal-errors](#internal-errors) — this is the one that matters |

If no single code dominates, check whether `a2e_http_requests_total` has spiked — a DoS-shape surge can push the ratio up without a real bug. Cross-reference with Cloudflare firewall events.

---

### p95-latency-high

**Alert**: `A2eShellP95LatencyHigh` · **Severity**: warning

Exec turns are taking >1s at p95 for 5+ minutes.

**Immediate checks**:

```bash
# p95 per-route (narrows down to specific tool calls)
curl -sS -u 'admin:<pw>' 'https://grafana.ardf.dev/api/datasources/proxy/uid/a2e-prometheus/api/v1/query?query=histogram_quantile(0.95,sum%20by%20(route,le)%20(rate(a2e_http_request_duration_ms_bucket%5B5m%5D)))' | jq '.data.result[] | {route: .metric.route, p95_ms: .value[1]}'

# Is the event loop saturated?
curl -sS -u 'admin:<pw>' 'https://grafana.ardf.dev/api/datasources/proxy/uid/a2e-prometheus/api/v1/query?query=nodejs_eventloop_lag_seconds' | jq .data.result[0].value[1]
```

**Remediation**:

1. **Event loop lag > 200ms** → see [event-loop-lag-high](#event-loop-lag-high). Same underlying cause.
2. **p95 concentrated on one route**: probably the upstream that route hits. Check MCP server response times (`a2e_mcp_request_duration_ms_bucket`), catalog mirror sync (large partial clones stall), or a specific bash subprocess blocking.
3. **p95 elevated across the board without ELL spike**: network to Cloudflare/upstreams is the bottleneck. Check `traceroute` from the VPS.
4. **No upstream dependency slow**: bounded-mode sessions doing `foreach --parallel=N` with large N may queue on rate limits. Check [rate-limit-sustained](#rate-limit-sustained) in parallel.

**Why this happens**: the histogram captures end-to-end turn time, including all pipeline stages (auth, interpolation, spawn, output formatting). Any stage can spike. p95 is sensitive to a handful of slow outliers — 10% of turns being slow is enough to trip this.

---

### event-loop-lag-high

**Alert**: `A2eShellEventLoopLagHigh` · **Severity**: warning

Node's event loop is stuck for more than 200ms — the process is CPU-saturated or blocked on synchronous I/O. New requests queue.

**Immediate checks**:

```bash
# Current lag value
ssh root@<vps> 'curl -sS http://127.0.0.1:8090/metrics | grep nodejs_eventloop_lag_seconds'

# CPU load on the host (container shares host CPU)
ssh root@<vps> 'top -bn1 | head -15'

# Flame-graph-style blocked ops snapshot:
ssh root@<vps> 'docker exec a2e-shell kill -USR1 1 && docker logs --tail 100 a2e-shell'
# (prints async hook state + recent setImmediate backlog)
```

**Remediation**:

1. If the host is CPU-saturated (other containers fighting for CPU), that's the root cause — either add CPU or isolate a2e-shell with `--cpus=` cgroup limits.
2. If the host has CPU headroom but a2e-shell's own process is saturated: someone is doing a huge synchronous operation. Common culprits: enormous regex over big input, JSON.parse of 100MB+, unbounded `filter` on a giant in-memory list.
3. Restart as a stopgap: `docker restart a2e-shell`. Fix the upstream cause before it recurs.

**Why this happens**: Node is single-threaded for JS execution. Any synchronous call that takes >50ms starves every other request. The canonical a2e-shell pipeline offloads I/O to async, so sustained lag means someone bypassed that (or a bug introduced a sync hot path).

---

### high-memory

**Alert**: `A2eShellHighMemory` · **Severity**: warning

Process RSS exceeded 800 MiB for 10 minutes. Normal baseline is 80-120 MiB.

**Immediate checks**:

```bash
# How many sessions alive?
ssh root@<vps> 'curl -sS http://127.0.0.1:8090/metrics | grep a2e_sessions_active'

# Session binding size totals (if any session has accumulated >100MB of bindings)
ssh root@<vps> 'ls -lh /var/lib/a2e-shell/sessions/*/state.json 2>/dev/null | sort -k5 -h | tail -5'
```

**Remediation**:

1. **Sessions > baseline × 2** → bindings may be accumulating. Check [sessions-high](#sessions-high) runbook. Sessions whose `state.json` is >50MB are the concrete leak sites; delete via `DELETE /sessions/:id` with that id.
2. **Sessions normal but RSS climbing** → real leak (Buffer from exec not freed, listener never removed, etc.). Restart is the stopgap: `docker restart a2e-shell`. Open a bug with a heap snapshot: `docker exec a2e-shell kill -USR2 1 && docker logs a2e-shell | grep 'heapsnapshot'`.
3. **RSS high for minutes after restart** → not a leak, baseline shifted. Raise the alert threshold in `alert.rules.yml`.

**Why this happens**: every session holds its bindings in-process until DELETE or TTL expiry. An agent that binds 500 MB of data and never DELETEs the session keeps that memory forever. TTL sweeper runs every 60s to limit this.

---

### sessions-high

**Alert**: `A2eShellSessionsHigh` · **Severity**: warning

More than 500 sessions registered simultaneously for 10+ minutes.

**Immediate checks**:

```bash
# Exact count + trend
ssh root@<vps> 'curl -sS http://127.0.0.1:8090/metrics | grep -E "a2e_sessions_active|a2e_sessions_total"'

# Sessions on disk (should match active)
ssh root@<vps> 'ls /var/lib/a2e-shell/sessions/ | wc -l'

# Sessions NOT being cleaned up at TTL — should be empty:
ssh root@<vps> 'find /var/lib/a2e-shell/sessions/ -maxdepth 1 -mindepth 1 -mmin +60 -type d | wc -l'
```

**Remediation**:

1. **Sessions on disk ≫ active sessions** → TTL sweeper has a backlog. Check `docker logs a2e-shell | grep session.sweep` — if the sweeper is erroring, the stale sessions accumulate. Manual sweep: `find /var/lib/a2e-shell/sessions/ -maxdepth 1 -mmin +120 -type d -exec rm -rf {} +`.
2. **Active sessions ≫ normal traffic shape** → a client is creating without DELETEing. Check transcript for client patterns; reach out to the client owner. Short-term: lower `A2E_SESSION_TTL_S` to force faster reaping.
3. **Legitimate traffic spike** → sessions are fine, the threshold is wrong. Raise it in `alert.rules.yml`.

**Why this happens**: `POST /sessions` without a matching `DELETE /sessions/:id` (plus TTL not yet expired). Typical baseline: a few sessions at rest, maybe 10-20 under active load.

---

### rate-limit-sustained

**Alert**: `A2eShellRateLimitSustained` · **Severity**: warning

Rate-limit rejections > 1/sec for 10+ minutes.

**Immediate checks**:

```bash
# Which bucket is hitting the limit?
curl -sS -u 'admin:<pw>' 'https://grafana.ardf.dev/api/datasources/proxy/uid/a2e-prometheus/api/v1/query?query=sum%20by%20(bucket)%20(rate(a2e_rate_limit_hits_total%5B5m%5D))' | jq '.data.result[] | {bucket: .metric.bucket, rate: .value[1]}'
```

**Remediation** (by bucket):

| Bucket | Meaning | Action |
|---|---|---|
| `session` | Per-session request limit hit — client is bursting beyond `A2E_RATE_LIMIT_PER_MINUTE` | If legitimate load, bump the env var + `docker restart a2e-shell`. If abusive, identify the client via request logs and revoke their token. |
| `create` | Too many `POST /sessions` per minute — probably an agent in a session-create loop | Same: bump cap or revoke. Check the transcript for the actual usage. |
| `mcp` | Per-MCP-server cap (`rate_limit_rpm` on a spec) | The agent is calling one MCP server too hard. Raise `rate_limit_rpm` or throttle the agent prompt. |

If ALL three buckets are hitting their limits simultaneously → you're almost certainly under a misbehaving client. Revoke the token and investigate.

**Why this happens**: rate limits exist to protect the server from runaway clients AND to protect downstream MCP servers from agent loops. A 10-minute sustained breach indicates it's working as designed, not a false positive.
