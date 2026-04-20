# a2e-shell

[![CI](https://github.com/MauricioPerera/a2e-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/MauricioPerera/a2e-shell/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MauricioPerera/a2e-shell?include_prereleases)](https://github.com/MauricioPerera/a2e-shell/releases)

HTTP server exposing a real OS shell as a **primitive tool** for LLM agents. One endpoint — `POST /sessions/:id/exec` — that takes a bash command and returns a canonical response optimized for LLM consumption.

- **Shell-as-tool**: the agent writes bash; the server executes. No JSON workflow DSL, no curated tool catalog.
- **Bounded mode** (v1.2): optional per-session execution under a closed-grammar DSL (8 verbs + 6 meta) instead of bash. For compliance-grade deployments where `eval` / `$(...)` / arbitrary CLIs are off the table. Empirical 14% token cost vs A2E declarative JSON on large-response workloads.
- **MCP gateway** (v1.1): mount MCP servers on a session, invoke their tools / resources / prompts through the same canonical response pipeline as native bash.
- **Stateful sessions**: `cwd`, env, variable bindings, and transcript persist across calls.
- **Catalog layer**: optional git repo of skills/docs/prompts/templates, auto-cloned on session create, with reachability analysis + SHA pinning + shared cache.
- **Credential discipline**: secrets are resolved from server env vars named by the client; values never touch the LLM, the wire, the transcript, or HTTP error messages.
- **Provider-neutral**: any agent framework (Claude, GPT, Llama, in-house) consumes the same HTTP API.
- **Production-ready**: TLS/mTLS opt-in, graceful shutdown, Prometheus metrics, structured logs, idempotency, rate limits, SSE streaming, cross-process catalog cache.

## Status

**v1.2.0-rc.1** — bounded-verb shell shipped as an additive RFC on top of v1.1. All existing v1.1 surface is byte-identical; opting into `mode: "bounded"` on session creation is explicit and scoped per session. See [CHANGELOG.md](./CHANGELOG.md) for the release history and [`docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md`](./docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md) for the bounded-mode spec.

Schema lock from v1.0 remains in effect: routes, error codes, request/response shapes, response headers, and env var names are stable contracts. Only addition this release is the already-reserved `mode: "bounded"` path through the existing `/sessions` and `/exec` endpoints.

## Design philosophy

See [CONTRACT.md](./CONTRACT.md) for the full specification and acceptance criteria. The short version:

1. **The LLM is a programmer, not a selector.** Bash is its native medium; JSON tool-calling is friction.
2. **Credentials live at the runtime boundary.** The request body names env vars; the server resolves them. No secret ever transits through the LLM or the wire.
3. **Content addressable everything.** Sessions, catalog refs, transcripts, cache mirrors — all keyed by hashes so behavior is reproducible.
4. **Fail loudly at authoring, not at runtime.** Every boundary (auth spec, env var name, cwd path, skill frontmatter) is validated up front with specific error codes.

## Quickstart

### Development

```bash
npm install
npm run typecheck
npm test                       # 345 tests
npm run bench:bounded          # bounded vs A2E-JSON token cost table
npm run build && node dist/index.js
```

### Docker

```bash
docker build -t a2e-shell .
docker run --rm -p 8080:8080 \
  -e A2E_AUTH_TOKENS=dev-token-1234 \
  -e A2E_DEFAULT_BINARIES_ALLOWLIST=curl,jq,gh,git,cat \
  a2e-shell
```

### Production templates

Ready-to-adapt manifests under [`deploy/`](./deploy/):

- [`deploy/kubernetes/`](./deploy/kubernetes/a2e-shell.yaml) — Deployment + nginx Ingress (sticky cookie, SSE-friendly) + HPA + PDB.
- [`deploy/docker-compose.yml`](./deploy/docker-compose.yml) — Traefik + Let's Encrypt TLS termination.
- [`deploy/terraform/aws/`](./deploy/terraform/aws/) — ECS Fargate + ALB + EFS + Secrets Manager.

Read [`deploy/README.md`](./deploy/README.md) before deploying — it documents the non-negotiables (session affinity, termination grace, SSE buffering, secret handling).

### First request

```bash
SID=$(curl -s -X POST http://localhost:8080/sessions \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{}' | jq -r .session_id)

# Exec
curl -s -X POST http://localhost:8080/sessions/$SID/exec \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{"command":"curl -sS https://api.github.com/zen","bind_as":"zen"}'

# Reference the binding
curl -s -X POST http://localhost:8080/sessions/$SID/exec \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{"command":"echo ${$zen} | wc -c"}'

# Stream output
curl -s -X POST http://localhost:8080/sessions/$SID/exec \
  -H "authorization: Bearer dev-token-1234" \
  -H "accept: text/event-stream" \
  -H "content-type: application/json" \
  -d '{"command":"for i in 1 2 3; do echo chunk $i; sleep 0.2; done"}'

# Cleanup
curl -s -X DELETE http://localhost:8080/sessions/$SID \
  -H "authorization: Bearer dev-token-1234"
```

## Benchmarks

```bash
npm run bench:http      # HTTP p95 latencies vs budgets (CI gate)
npm run bench:tokens    # prompt-token savings vs raw-dump baseline (unrestricted mode)
npm run bench:mcp       # MCP gateway vs naive MCP client (v1.1 RFC 001)
npm run bench:bounded   # bounded-verb shell vs A2E declarative JSON (v1.2 RFC)
```

**Unrestricted mode** — canonical response vs raw subprocess dump:

| fixture | raw tokens | canonical tokens | savings |
|---|---|---|---|
| 500-row JSONL (`kubectl get pods`) | 23,321 | 721 | 96.9% (32×) |
| ~200 KB npm metadata JSON | 140,118 | 1,065 | 99.2% (131×) |
| 8 KB binary tarball | 7,713 | 47 | 99.4% (164×) |

On sub-500-byte outputs the canonical format loses (wrapper overhead) — surfaced honestly in the full table.

**Bounded mode** — closed-grammar shell vs A2E declarative JSON workflow DSL:

| trace | regime | ratio |
|---|---|---:|
| `large-response-workload` (≥2KB responses) | large | **14%** |
| `call-filter-transform` (mixed ~600B) | medium | **53%** |
| `foreach-save-merge` / `if-wait-history` (<200B payloads) | small | 104-106% |
| **Aggregate across 4 traces** | | **32%** |

Finding: bounded mode is a **large-response optimizer**, not a universal compressor. The preview-truncation amortizes on big payloads; on tiny ones the canonical-wrapper overhead sits at rough parity with A2E-JSON. Gated in `tests/integration/token-budget.test.ts`.

## Documentation

| File | Audience | Purpose |
|---|---|---|
| [docs/API.md](./docs/API.md) | Client developers | HTTP reference, schemas, error codes, headers |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Operators | Env vars, TLS, auth, deployment modes, graceful shutdown |
| [docs/CATALOG.md](./docs/CATALOG.md) | Both | Catalog feature: spec, auth, pinning, cache |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Maintainers | Security model, module layout, failure modes |
| [docs/LLM-PROMPT.md](./docs/LLM-PROMPT.md) | LLM | ~500-token system prompt consumed by the agent |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | All | v0.1 → v2.0 plan + out-of-scope |
| [CONTRACT.md](./CONTRACT.md) | Implementers | Formal contract with acceptance criteria |
| [CHANGELOG.md](./CHANGELOG.md) | All | Release history; frozen surface listed per tag |
| [GRAMMAR.ebnf](./GRAMMAR.ebnf) | (reserved) | Bounded-mode grammar for v2 |

## Development on Windows

Runtime targets Linux. On Windows the test suite still runs fully:

- [`tests/setup.ts`](./tests/setup.ts) probes Git-for-Windows (`C:/Program Files/Git/bin/bash.exe` etc.) and sets `A2E_BASH_PATH` so spawn resolves cleanly.
- Unit tests are pure TypeScript — no subprocess.
- Integration + cache tests invoke real `bash` + `git` and require one of: Git-for-Windows, MSYS2, or WSL.

```bash
npm run typecheck
npm test
```

Docker builds happen on Linux CI, not locally.

## License

MIT (or whatever the project settles on — not yet committed).
