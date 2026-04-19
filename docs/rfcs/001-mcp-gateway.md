# RFC 001 — a2e-shell as MCP gateway (inbound)

| | |
|---|---|
| **Status** | Draft |
| **Author** | Mauricio Perera |
| **Created** | 2026-04-19 |
| **Target release** | v1.1 |
| **Companion RFC** | `a2e-skills` RFC 001 — MCP-serveable substrate (outbound) |

## Summary

Extend a2e-shell so that a session can connect to one or more external MCP servers. Their tools, resources, and prompts become entries of the session's catalog — indistinguishable from git-backed entries from the agent's perspective. All canonical-response discipline (preview/shape/binding), reachability analysis, redaction, transcript, and rate limiting apply to MCP calls identically to bash exec.

a2e-shell becomes a **token-disciplined MCP client**. The agent sees a unified capability surface; the operator gets compliance, audit, and cost control across any backend — bash, MCP, or future transports.

## Motivation

The MCP ecosystem has real, vetted servers (GitHub, Cloudflare, Anthropic reference, Postgres, Playwright, etc.) that would be foolish to reimplement. Yet typical MCP clients (Claude Desktop, Cursor, VS Code extensions) break token economy in five measurable ways:

1. **Monolithic tool injection**: all N tools from all connected servers go into the system prompt every turn
2. **Verbatim response dump**: 200 KB JSON in → 200 KB in context out
3. **No cross-call state**: each `tools/call` is stateless; agents re-fetch same data across turns
4. **All-or-nothing discovery**: no filtering by session capability surface
5. **Multi-server overhead scales linearly**: 5 servers = 5× schema footprint regardless of which tools are used

a2e-shell already solves each of these problems for bash exec via canonical responses, catalog reachability, and `$bind_as` variables. Applying the same discipline to MCP calls yields (per our own token benchmark) **60-70% token reduction per task** with validated backends, no agent changes, no MCP server changes.

## Non-goals

- Reimplementing MCP servers. Use existing ones.
- `sampling/createMessage` (server→client LLM inference). a2e-shell is headless.
- `elicitation/create` (server asks user for input mid-flow). Requires UI layer.
- MCP stdio transport in v1.1 (HTTP + SSE only). stdio deferred.

## Design

### 1. Session spec extension

Add optional `mcp_servers` field to `POST /sessions` request body:

```json
{
  "catalog": { "repo_url": "...", "index_ref": "index", "content_ref": "main" },
  "mcp_servers": [
    {
      "id": "github",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "type": "token", "env_var": "GITHUB_MCP_TOKEN" }
    },
    {
      "id": "cloudflare",
      "transport": "sse",
      "url": "https://mcp.cloudflare.com/sse",
      "auth": { "type": "oauth", "access_token_env_var": "CF_OAUTH_TOKEN" }
    }
  ]
}
```

`id` is the logical name the catalog references. `auth` reuses the same env-var-naming pattern as catalog `auth`; tokens are read from process.env at each call (for rotation), never inlined, never logged.

### 2. MCP server lifecycle in a2e-shell

On session creation, for each entry in `mcp_servers`:

```
manager.create(req)
  └── for each mcp_servers[i]:
      ├── validate auth env var exists (fail fast — AUTH_MISSING)
      ├── establish transport connection
      ├── send `initialize` with capability declaration
      ├── receive `initialized` + server capabilities
      ├── send `tools/list`    → cache tool definitions
      ├── send `resources/list` → cache resource URIs + metadata
      ├── send `prompts/list`  → cache prompt definitions
      └── store in session.mcpClients[i]
```

Connections persist for the lifetime of the session. On `DELETE /sessions/:id`, each MCP client is gracefully disconnected.

### 3. Catalog unification

The catalog becomes the single capability surface. Existing git-backed `skills.json` / `docs.json` / `prompts.json` partitions now conceptually have siblings from MCP servers — merged at the reachability layer.

New `entry_type` field in SKILL.md frontmatter (and its doc/prompt equivalents):

```yaml
# Existing — bash-backed skill from git
entry_type: bash          # default when omitted
entry: run.sh
args: [...]

# New — MCP-backed tool
entry_type: mcp-tool
entry:
  server: "github"        # id from session's mcp_servers
  tool: "create_issue"
args: [...]               # MUST match the MCP tool's schema

# New — MCP-backed resource
entry_type: mcp-resource
entry:
  server: "cloudflare"
  uri: "worker://my-worker/logs"

# New — MCP-backed prompt
entry_type: mcp-prompt
entry:
  server: "anthropic-ref"
  prompt: "summarize"
```

Skills declared with `entry_type: mcp-*` don't need a corresponding file in the content branch — they reference the MCP server, not a script.

For ad-hoc discovery (MCP tools without a corresponding SKILL.md), a2e-shell auto-synthesizes virtual catalog entries during the reachability pass:

```
reachability.by_category.mcp_tools = {
  "github.create_issue": { reachable: true, server: "github", schema: {...} },
  "github.search_code": { reachable: true, ... },
  ...
}
```

The agent discovers them via the same `$A2E_CATALOG_REACHABILITY` env var.

### 4. Invocation routing

When the agent calls a catalog entry (via `exec` executing the skill's `run.sh`, or — for MCP entries — a new implicit protocol):

```
exec session /bin/mcp-invoke <server> <tool> <args_json>
  └── a2e-shell intercepts (builtin reserved path)
      ├── look up mcpClients[server]
      ├── send JSON-RPC tools/call { name, arguments }
      ├── await response
      ├── wrap in canonical response:
      │   { status_line: "[exit 0]",
      │     shape: detectShape(result),
      │     preview: truncatePreview(result),
      │     stderr: null,
      │     binding: "$<bind_as>" if provided,
      │     truncated: <bool> }
      └── return
```

The `/bin/mcp-invoke` path is reserved (not a real binary). a2e-shell parses it specially and routes to MCP. The agent sees a normal `exec` call.

Alternative considered: new explicit endpoint `POST /sessions/:id/mcp/call`. Rejected because it forces the agent to learn two invocation patterns. The `/bin/mcp-invoke` approach keeps the agent-facing surface uniform (everything is `exec`).

### 5. Resource reads

`resources/read` follows the same pattern — a builtin `/bin/mcp-read <server> <uri>` that fetches, wraps in canonical response with `shape` detected from the MIME type or content.

### 6. Progress notifications

MCP `notifications/progress` events from long-running tools relay through a2e-shell's SSE streaming machinery. When the agent invokes an MCP tool with `Accept: text/event-stream`, a2e-shell:

1. Opens the SSE response to the client
2. Forwards MCP progress notifications as SSE `event: progress` messages
3. On completion, emits the canonical response as `event: done`

This matches the existing SSE shape of bash exec streaming.

### 7. Error codes (additions to `src/errors.ts`)

```ts
export const ERROR_CODES = [
  // ...existing...
  "MCP_SERVER_UNREACHABLE",      // 503 — couldn't connect on session create
  "MCP_AUTH_FAILED",              // 401 — server rejected credentials
  "MCP_TOOL_NOT_FOUND",           // 404 — tool id doesn't exist on that server
  "MCP_RESOURCE_NOT_FOUND",       // 404 — URI doesn't match any resource
  "MCP_PROTOCOL_ERROR",           // 502 — server returned malformed JSON-RPC
  "MCP_TIMEOUT",                  // 200 (in exec-level error) — tool call exceeded timeout
] as const;
```

All MCP-level errors surface in the canonical response's `error.code` field when the session survives; server-level errors (auth failed on connect, server unreachable) surface as HTTP errors on `POST /sessions`.

### 8. Redaction

Tokens used for MCP server auth are added to the session's redactor pipeline identically to `A2E_REDACT_ENV_KEYS`. The redactor runs on:

- MCP response bodies (before canonical formatting)
- Error messages mentioning the server
- Transcript entries recording the call

No token ever appears in `stderr`, preview, transcript, or HTTP error responses.

### 9. Rate limits

Each MCP server gets its own per-session bucket, independent of the session's `rateLimitPerMinute`. Config:

```
A2E_MCP_RATE_LIMIT_PER_SERVER_PER_MINUTE  (default: 60)
```

Exceeding raises `RATE_LIMITED` with message noting the server id.

### 10. Observability

New Prometheus metrics:

- `mcp_calls_total{server, tool, status}`
- `mcp_call_duration_ms{server, tool}` (histogram)
- `mcp_connections_active{server}` (gauge)
- `mcp_protocol_errors_total{server, reason}`

Structured log events:

- `mcp.server.connected` / `mcp.server.disconnected` / `mcp.server.unreachable`
- `mcp.call.invoked` / `mcp.call.succeeded` / `mcp.call.failed`
- `mcp.progress.relayed`

## Security considerations

1. **Capability surface expands with each server**. Operators must vet which MCP servers a session can connect to. Recommend a server allowlist config:
   ```
   A2E_MCP_SERVERS_ALLOWLIST="github,cloudflare,internal-*"
   ```
   Requests referencing servers outside the allowlist fail with `CAPABILITY_DENIED` at session creation.

2. **Tool metadata is untrusted input**. Per the MCP spec, tool descriptions/annotations from third-party servers should be treated as untrusted. a2e-shell surfaces them to the agent but **does not allow them to override session policy** — binary allowlist, env key restrictions, cwd bounds continue to apply (but can be bypassed by MCP tools if the server chooses to run arbitrary code; that's on the operator for choosing that server).

3. **Prompt injection via resources**. An attacker who controls a connected MCP server could return crafted resources that manipulate the agent. a2e-shell cannot prevent this at the protocol level; recommend operator-level mitigation (allowlist + sandboxed resource rendering).

## Migration / backwards compatibility

Fully additive. `mcp_servers` is optional. Existing sessions with only `catalog` work unchanged. Existing skills without `entry_type` default to `bash`.

A session without `mcp_servers` has identical behavior to today. No breaking changes to the v1.0 contract.

## Alternatives considered

### A. Separate `/sessions/:id/mcp/call` endpoint

Rejected — forces the agent to learn two invocation patterns. Unified via `/bin/mcp-invoke` is cleaner.

### B. MCP as a first-class transport (not via catalog)

Rejected — the catalog is already the "capability surface" abstraction. Adding a parallel "mcp_capabilities" field would fragment the mental model.

### C. Proxy tools only, skip resources and prompts

Rejected after the analysis in this conversation — resources are the biggest win (tree-first/blob-on-demand in MCP semantics); ignoring them discards too much value. Prompts cheap to add once resources are there.

### D. Use an MCP CLI binary in the allowlist

Tempting (zero work on a2e-shell's side) but loses: the canonical response wrapping, the per-server rate limiting, the redaction pipeline, the reachability analysis integration. Not chosen.

## Open questions

1. Should the `/bin/mcp-invoke` convention be exposed as a real binary (a small wrapper script) that agents could learn without special casing? Pro: simpler mental model. Con: slightly worse perf + one more moving part.
2. How to handle MCP servers that expose 500+ tools? Reachability filter should mask most, but the `tools/list` cache itself would be large. Pagination via `cursor` is in the MCP spec; we'd implement it.
3. Should resource `subscribe` be in v1.1 or deferred? Subscribes introduce stateful updates that complicate the session model. Leaning v1.2.

## Rollout plan

### v1.1.0-rc.1
- HTTP transport only
- `mcp_servers` accepts array, one server per session
- `entry_type: mcp-tool` + auto-synthesized catalog entries
- Redaction + rate limits + canonical response

### v1.1.0-rc.2
- SSE transport
- Multiple servers per session
- `entry_type: mcp-resource` + reads
- Progress notification relay

### v1.1.0
- `entry_type: mcp-prompt`
- Benchmarks against Claude Desktop as MCP client — token savings demonstrated
- External security review includes MCP surface

### v1.2+ (deferred)
- stdio transport
- `resources/subscribe` + live cache invalidation
- `sampling/createMessage` (optional, requires LLM integration at the a2e-shell layer)

## Benchmark plan

Same methodology as `docs/benchmarks/workers-ai-models-2026-04-19.md`:

- **Baseline**: Claude Desktop connected to GitHub MCP server, same task
- **Treatment**: a2e-shell + Gemma 4 + GitHub MCP server via this RFC
- **Metric**: total prompt + completion tokens to complete "list my 5 latest PRs with status and reviewer names"

Expected result: 60-70% reduction in treatment vs baseline, driven by:
- Tool list not injected monolithically (only reachable subset)
- Responses wrapped in canonical format (preview cuts large PR bodies)
- Binding reuse across turns (one `gh.search_prs` → `$prs` → multiple follow-ups without re-fetch)

Benchmark ships in `tests/benchmarks/mcp-gateway.mjs` alongside the release.

## Related

- Companion RFC: [a2e-skills RFC 001 — MCP-serveable substrate](https://github.com/MauricioPerera/a2e-skills/blob/main/docs/rfcs/001-mcp-adapter.md)
- Token benchmark that motivates this: [docs/benchmarks/workers-ai-models-2026-04-19.md](../benchmarks/workers-ai-models-2026-04-19.md)
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18
