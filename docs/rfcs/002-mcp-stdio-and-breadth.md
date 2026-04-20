# RFC 002 — MCP stdio transport + breadth (v1.3)

| | |
|---|---|
| **Status** | Draft |
| **Author** | Mauricio Perera |
| **Created** | 2026-04-20 |
| **Target release** | v1.3 |
| **Prerequisite** | RFC 001 (v1.1) — MCP gateway HTTP/SSE transport |

## Summary

Close the MCP feature gap that v1.1 left open. Three additive items, sequenced by dependency:

1. **stdio transport** — spawn MCP server as a subprocess, pipe line-framed JSON-RPC. Unlocks the large population of MCP servers distributed as stdio-only binaries (reference implementations, Postgres, filesystem, git, etc.).
2. **`Mcp-Session-Id` threading** — for HTTP/SSE servers that maintain state (session cookies, request correlation), propagate the session id header across requests.
3. **Multi-server hardening** — load tests with 4+ servers per session, per-server rate limiting, connection pooling for HTTP transports.

Deferred to v1.4 (noted explicit, not in v1.3 scope):

- **Server-initiated notification stream** — long-lived GET for `notifications/resources/list_changed` etc. arriving outside in-flight requests. Requires subscription model on the session side.
- **resources/subscribe** — client-driven subscription to resource URIs; cache invalidation on `notifications/resources/updated`.
- **SSE streaming for bounded mode** — low-priority symmetry item from v1.2.

## Motivation

Of the top 20 MCP servers listed in the [official registry][registry] and the [awesome-mcp-servers][awesome] list (as of 2026-Q2), **14 distribute as stdio-only**. That's a material fraction of the MCP ecosystem that v1.1 cannot consume — operators must wrap each one in an HTTP shim before a2e-shell can mount it.

stdio is also the lowest-friction path for local-only integrations: filesystem, git, Postgres, local-LLM (whisper, llama.cpp MCP bridges). Many of these are security-sensitive precisely because they need no network exposure; the HTTP wrapper forces one.

`Mcp-Session-Id` threading is the second-most-common reason HTTP MCP servers misbehave today: servers that rely on per-session state (OAuth flows, cursor pagination, cached authorization) see each a2e-shell request as a cold start. The MCP spec (2025-06-18 §2.1.4) mandates clients honor the `Mcp-Session-Id` header across requests to the same server.

Multi-server hardening is a latent gap: v1.1 shipped with 8 MCP servers per session as a cap (`McpServersArray.max(8)`), but real load tests stopped at 2. The number of plausible-production-sized deployments that actually hit 4+ is growing; we should have concurrent-server numbers before operators hit that ceiling.

[registry]: https://github.com/modelcontextprotocol/registry
[awesome]: https://github.com/punkpeye/awesome-mcp-servers

## Non-goals

- Spawning MCP servers in containers or sandboxes. Subprocess isolation is the operator's problem (seccomp, bwrap, systemd unit). a2e-shell runs them as children of the current process with inherited permissions.
- Replacing the HTTP/SSE transport from v1.1. stdio is additive; existing `transport: "http" | "sse"` sessions continue unchanged.
- Windows subprocess semantics beyond what `child_process.spawn({ shell: false })` already guarantees. MCP stdio servers in practice target Unix-style IPC; Windows support follows what Node natively offers.

## Design

### 1. Session spec extension

Extend `McpServerSpec` (currently HTTP-only) to accept two transport shapes — HTTP/SSE (existing) and stdio (new). The schema becomes a discriminated union on `transport`:

```ts
type McpServerSpec =
  | {
      id: string;
      transport: "http" | "sse";       // existing, unchanged
      url: string;
      auth?: McpAuthSpec;
      timeout_ms?: number;
    }
  | {
      id: string;
      transport: "stdio";              // NEW
      command: string;                 // binary path or name (allowlist-checked)
      args?: string[];                 // argv for the subprocess
      env?: Record<string, string>;    // additional env vars (overlay on server env)
      cwd?: string;                    // working dir; defaults to session cwd
      timeout_ms?: number;             // request timeout, as before
    };
```

Backward compatibility: existing sessions that pass `transport: "http"` or `"sse"` (or omit the field) get the v1.1 behavior byte-identically. Only `transport: "stdio"` triggers the new code path.

The stdio `command` runs through the same binary allowlist that gates `call <binary>` in bounded mode and bash `exec` in unrestricted mode. No special allowlist — one source of truth.

### 2. Subprocess lifecycle

Per-session subprocess map: `stdioClients: Map<id, ChildProcess>`.

On `POST /sessions` with a stdio MCP entry:

1. Resolve `command` against the binary allowlist → absolute path (via existing `policy.resolveBinaryPath`).
2. `spawn(absPath, args, { shell: false, cwd, env, stdio: ["pipe", "pipe", "pipe"] })`.
3. Handshake: send `initialize` request on stdin (line-framed JSON-RPC), read response from stdout.
4. Store the child in `stdioClients`. Failure at any step rolls back — partial subprocesses are killed, the session create returns `500 MCP_SERVER_UNREACHABLE`.

On `DELETE /sessions/:id` (or GC at expiry):

1. Send `notifications/initialized` → peer cleanup (best-effort; errors logged, not propagated).
2. Close stdin (EOF signal to the server).
3. `SIGTERM` after 2s, `SIGKILL` after 5s if still alive.
4. Unref the child handle so Node's event loop doesn't keep the process alive beyond the session.

Crash handling: if the child exits unexpectedly mid-session, subsequent `tools/call` on that server return `MCP_SERVER_UNREACHABLE` with `details: "subprocess exited with code N"`. No auto-restart in v1.3 — operator must recreate the session.

### 3. Line-framed JSON-RPC

Bidirectional line-framed protocol on stdin/stdout:

- **Outgoing**: `JSON.stringify(msg) + "\n"` on stdin.
- **Incoming**: read stdout chunks, accumulate into a buffer, split on `\n`, parse each line as JSON.
  - Non-JSON lines (stderr cross-contamination, server debug output) → log + drop.
  - Parse errors → log + drop the line; keep reading.
- Request correlation by `id` field — same as HTTP/SSE transport. In-flight request map reused.

Large responses: a 256 KiB line is plausible for real workloads. The parser accepts lines up to `caps.maxResponseBytes` (default 1 MiB); longer lines surface as `SIZE_LIMIT`.

### 4. `Mcp-Session-Id` threading

For HTTP/SSE transports only (stdio has no headers). After `initialize`, capture any `Mcp-Session-Id` header the server returned and include it on every subsequent request. Spec: [MCP 2025-06-18 §2.1.4][spec-sessid].

If the server rotates the id (returns a new one mid-session), adopt the new value from that response onward. If the server returns `400 Bad Request` citing the session id (heuristic: body contains `"session"` and `400`), drop the cached id and retry once — the server likely expired it.

No UI surface — threading is invisible to the agent. Observability: the existing `mcp.call` log event gains an optional `mcp_session_id` field (SHA-8 truncated so full id never lands in logs).

[spec-sessid]: https://spec.modelcontextprotocol.io/specification/2025-06-18/basic/transports/

### 5. Multi-server hardening

Concrete tests + caps to add:

- **Load test**: 6 concurrent MCP servers per session (2 stdio + 4 HTTP), 50 sequential `tools/call` round-robin. Assert p95 < 200ms added latency vs single-server baseline.
- **Per-server rate limit**: `capabilities.mcp_per_server_rpm` (default 600/min per server). Honored at the client layer before the wire call. Separate from the session-level `rateLimitPerMinute`.
- **HTTP connection reuse**: switch from per-request `fetch()` to a keep-alive `undici` agent per (server id, session). Already partially done via Node's default agent; make it explicit with a pool size cap (4 sockets per server, configurable).

No change to public API for multi-server hardening — all internal. Benchmarks land as a new `npm run bench:mcp-load`.

## Acceptance criteria

### stdio transport

- [ ] `POST /sessions` with `transport: "stdio"`, `command: "...", args: [...]` creates the session and returns `201` with the mcp_server's tool count populated.
- [ ] The subprocess is alive after session create (`ps` confirmation in test).
- [ ] `tools/call` over stdio round-trips JSON-RPC with correct id correlation.
- [ ] Subprocess crash (killed externally) → next `tools/call` returns `MCP_SERVER_UNREACHABLE`.
- [ ] `DELETE /sessions/:id` sends EOF → SIGTERM → SIGKILL in sequence; subprocess exits within 5s.
- [ ] Unknown stdio `command` (not in allowlist) → session create returns `400 CAPABILITY_DENIED`.
- [ ] Unrestricted mode sessions can also use stdio MCP (not just bounded). Verified end-to-end in integration test.
- [ ] `large-response-workload` equivalent for stdio shows ≤30% token ratio (same gate as HTTP).

### Mcp-Session-Id

- [ ] After server returns `Mcp-Session-Id: abc` in the initialize response, the next `tools/call` sends `Mcp-Session-Id: abc` header.
- [ ] Server rotating the id in a mid-session response updates the cached value.
- [ ] `400` with a session-id-shaped error retries once without the id, then surfaces `MCP_PROTOCOL_ERROR` if the retry also fails.
- [ ] Structured log `mcp.call` event includes `mcp_session_id` (SHA-8 hash, never the raw value).

### Multi-server hardening

- [ ] 6-server concurrent load test passes with p95 < 200ms overhead vs single-server.
- [ ] Per-server rate limit exceeded → `MCP_RATE_LIMITED` (new code or existing `RATE_LIMITED` scoped to MCP).
- [ ] HTTP keep-alive verified: two sequential calls to the same server reuse the same socket (assertion via mocked undici agent).

## Out of scope for v1.3

- **Server-initiated notification stream** — deferred to v1.4. Needs client-side subscription bookkeeping beyond `initialize`-time discovery.
- **resources/subscribe** — same; pairs with the notification stream.
- **SSE streaming for bounded sessions** — low-priority symmetry item; defer until a concrete use case shows up.
- **Auto-restart of crashed stdio children** — operator concern; document recovery via session recreate.
- **Windows-specific stdio quirks** — we rely on what Node gives us; no custom Windows pipe handling.

## Versioning

v1.3 remains a minor release: all changes are additive on the existing HTTP contract. Schema lock from v1.0 remains in effect. Schema changes:

- `McpServerSpec` gains a third branch (`transport: "stdio"`). Existing branches unchanged.
- `CallCapabilities` gains `mcp_per_server_rpm` (optional, defaulted).
- New error code candidates: `MCP_SUBPROCESS_CRASHED` (subtype of `MCP_SERVER_UNREACHABLE`), `MCP_RATE_LIMITED` (scoped variant of `RATE_LIMITED`). Decision at implementation time.

## Open questions

1. **stdio server discovery**: do we support a `command: "npm:@modelcontextprotocol/server-everything"` sugar that resolves via `npx`? Adds a useful shortcut but a security footgun (arbitrary npm execution). Decision: **defer to v1.4**; v1.3 requires explicit absolute path or allowlisted binary name.
2. **Per-server isolated credentials**: can one stdio server see another stdio server's env? Current design: each subprocess gets an env that's `process.env` ∩ (session env overlay) ∩ (spec.env). No cross-contamination beyond what the parent already has.
3. **Subprocess memory caps**: Linux `setrlimit` to bound RSS. Nice-to-have; **not in v1.3** unless load tests reveal runaway children. Document as operator-layer concern (systemd unit, cgroups).
