# Changelog

All notable changes to a2e-shell. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/) from 1.0 onward.

Pre-1.0 releases (v0.x) allowed breaking changes between minors. From 1.0, breaking HTTP/API changes require a new major under a new route prefix (`/v2/*`). Additive changes (new optional fields, new error codes, new env vars) land as minors.

---

## [1.0.0-rc.2] - 2026-04-19

### Added
- Performance SLO benchmark harness: [tests/benchmarks/http.bench.ts](tests/benchmarks/http.bench.ts) drives the Hono app in-process and asserts p95 latencies against budgets (`GET /healthz` ≤ 10ms, `POST /sessions` ≤ 200ms, `/exec` intercept ≤ 50ms, `/exec` subprocess ≤ 300ms). All budgets env-overridable.
- CI workflow [.github/workflows/ci.yml](.github/workflows/ci.yml): `verify` (typecheck + tests) and `bench` (SLO gate, uploads JSON artifact). Regressions fail the PR.
- `npm run bench:http` script.

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

[1.0.0-rc.2]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/MauricioPerera/a2e-shell/releases/tag/v1.0.0-rc.1
[0.3.0]: https://github.com/MauricioPerera/a2e-shell/compare/0a4b85a...0f6aae3
[0.2.0]: https://github.com/MauricioPerera/a2e-shell/compare/28af4c1...efea548
[0.1.1]: https://github.com/MauricioPerera/a2e-shell/commit/28af4c1
[0.1.0]: https://github.com/MauricioPerera/a2e-shell/commit/46aead1
