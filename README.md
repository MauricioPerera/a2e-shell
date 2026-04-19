# a2e-shell

HTTP server exposing a real OS shell as a **primitive tool** for LLM agents. One endpoint — `POST /sessions/:id/exec` — that takes a bash command and returns a canonical response optimized for LLM consumption.

- **Shell-as-tool**: the agent writes bash; the server executes. No JSON workflow DSL, no curated tool catalog.
- **Stateful sessions**: `cwd`, env, variable bindings, and transcript persist across calls.
- **Catalog layer**: optional git repo of skills/docs/prompts/templates, auto-cloned on session create, with reachability analysis + SHA pinning + shared cache.
- **Credential discipline**: secrets are resolved from server env vars named by the client; values never touch the LLM, the wire, the transcript, or HTTP error messages.
- **Provider-neutral**: any agent framework (Claude, GPT, Llama, in-house) consumes the same HTTP API.

## Design philosophy

See the [CONTRACT](./CONTRACT.md) for the full specification and acceptance criteria. The short version:

1. **The LLM is a programmer, not a selector.** Bash is its native medium; JSON tool-calling is friction.
2. **Credentials live at the runtime boundary.** The request body names env vars; the server resolves them. No secret ever transits through the LLM or the wire.
3. **Content addressable everything.** Sessions, catalog refs, transcripts, cache mirrors — all keyed by hashes so behavior is reproducible.
4. **Fail loudly at authoring, not at runtime.** Every boundary (auth spec, env var name, cwd path, skill frontmatter) is validated up front with specific error codes.

## Quickstart

### Development (Linux)

```bash
npm install
npm run typecheck
npm test                       # 104 tests, ~1.5s
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

### First request

```bash
# Create a session
SID=$(curl -s -X POST http://localhost:8080/sessions \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{}' | jq -r .session_id)

# Exec a command
curl -s -X POST http://localhost:8080/sessions/$SID/exec \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{"command":"curl -sS https://api.github.com/zen","bind_as":"zen"}'

# Reference the binding
curl -s -X POST http://localhost:8080/sessions/$SID/exec \
  -H "authorization: Bearer dev-token-1234" \
  -H "content-type: application/json" \
  -d '{"command":"echo ${$zen} | wc -c"}'

# Cleanup
curl -s -X DELETE http://localhost:8080/sessions/$SID \
  -H "authorization: Bearer dev-token-1234"
```

## Documentation

| File | Audience | Purpose |
|---|---|---|
| [docs/API.md](./docs/API.md) | Client developers | Full HTTP reference with schemas |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Operators | Env vars, Dockerfile, auth, rate limits, caps |
| [docs/CATALOG.md](./docs/CATALOG.md) | Both | Catalog feature: spec, auth, pinning, cache |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Maintainers | Security model, module layout, failure modes |
| [docs/LLM-PROMPT.md](./docs/LLM-PROMPT.md) | LLM | 500-token system prompt consumed by the agent |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | All | Release plan v0.2 → v2.0 + out-of-scope |
| [CONTRACT.md](./CONTRACT.md) | Implementers | Formal contract for the implementation (acceptance criteria) |
| [GRAMMAR.ebnf](./GRAMMAR.ebnf) | (reserved) | Bounded-mode grammar for v2 |

## Development on Windows

Runtime targets Linux. On Windows:

- **Unit tests run natively** — pure TypeScript, no subprocess dependencies.
- **Integration tests** that spawn `git` / `bash` require a POSIX bash. Set `A2E_BASH_PATH` or use WSL/Git Bash. Without it, integration suite skips automatically.
- **Docker builds** should happen on Linux CI, not locally.

```bash
npm run typecheck                # cross-platform
npm run test:unit                # unit tests only, Windows-compatible
```

## License

MIT (or whatever the project settles on — not yet committed).
