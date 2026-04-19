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

v1 has no structured logs or metrics. `request_id` (uuid) is in every error response and in response header `X-Request-Id` — useful for correlation if you add a logger (planned v2).

`GET /sessions/:id/transcript` is the per-session audit. `GET /sessions/:id/state` for snapshot.

## Cleanup and lifecycle

- **DELETE** is synchronous for disk cleanup (session dir removed before 204 returns). Worktree prune on the mirror is fire-and-forget.
- **Expired sessions** are swept every 60s by a background interval. Same cleanup behavior.
- **Cache mirror** never shrinks in v1 — no LRU eviction. Monitor `A2E_CATALOG_CACHE_DIR` disk usage and prune manually for long-running hosts (safe to `rm -rf` any `<repo-hash>/` subdir; next session will re-clone).
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
