# RFC 004 — Server-initiated notifications + `resources/subscribe`

**Status**: draft — awaiting approval before implementation
**Depends on**: RFC 001 (MCP gateway), RFC 002 (stdio transport)
**Ships in**: v1.4.0
**Supersedes (partial)**: "Deferred to v1.4" items in `docs/ROADMAP.md` §v1.3

## Motivation

v1.1–v1.3 treat the MCP server catalog as a point-in-time snapshot captured at `connect`. Tools, resources, and prompts are cached then; if the server publishes new ones, adds new resource URIs, or mutates resource contents, a2e-shell never learns. Two gaps follow:

1. **Stale list**. An agent asks for `mcp-read some://new-uri` — fails with `MCP_TOOL_NOT_FOUND` even though the server exposes it.
2. **Stale content**. An agent reads `config://current` once, it's cached at some other layer (or the agent caches it), and mutations in the server are invisible.

The MCP 2025-06-18 spec provides the mechanism:

- Servers with mutable catalogs emit `notifications/{tools,resources,prompts}/list_changed`.
- Servers with mutable resource contents emit `notifications/resources/updated` *only to subscribed clients*.
- Subscription is explicit via `resources/subscribe` / `resources/unsubscribe`.
- The transport channel for server→client messages, on HTTP, is a long-lived `text/event-stream` GET to the MCP endpoint (Streamable HTTP §2.1.3). stdio already has a full-duplex pipe.

v1.4 wires all three pieces.

## Non-goals

- **No agent-facing subscribe surface** in v1.4. Subscribe is internal; auto-subscribe all known resources when the server advertises the capability. Agent-driven subscribe deferred until a concrete use case shows up.
- **No delta protocol**. `list_changed` triggers a full `*/list` re-fetch — we don't try to reconcile inserts/deletes at the wire level. MCP itself doesn't define a delta format.
- **No SSE-to-agent forwarding**. The exec-over-SSE endpoint stays scoped to a single `tools/call`. List-invalidation is transparent to the agent.
- **No client-initiated reconnect on stdio**. If the subprocess dies, we keep the v1.3 behavior (`MCP_SERVER_UNREACHABLE`, no restart).

## Surface changes

### 1. New `McpClient` methods

```ts
interface McpClient {
  // ... existing ...
  /**
   * Subscribe to resource-update notifications for `uri`. Idempotent.
   * No-op if the server did not advertise the `resources.subscribe` capability.
   * Returns true on success, false if the server lacks the capability.
   */
  subscribeResource(uri: string): Promise<boolean>;

  /** Unsubscribe. Idempotent. Errors on the wire are swallowed. */
  unsubscribeResource(uri: string): Promise<void>;
}
```

Internal. Not exposed through any virtual command in v1.4.

### 2. `McpServerState` becomes swap-able

Current:

```ts
interface McpServerState {
  readonly tools: ReadonlyMap<string, McpTool>;
  // ...
}
```

Problem: HTTP routes serialize `client.state.resources.size` directly. If the map is frozen and the dispatcher needs to replace it, we either mutate (breaks the type) or hand out a stale snapshot (breaks correctness).

Solution: wrap the maps in a mutable ref inside `client`, expose a snapshot accessor.

```ts
interface McpClient {
  readonly state: McpServerState;               // current snapshot; read each access
  // ... (size reads will see the latest list after list_changed)
}
```

Internally, `McpServerState` becomes a getter-backed object that reads from a mutable `currentCatalog` ref. Consumers (`resources_count` in the HTTP response, reachability scan, invoke dispatch) see the latest atomically.

This is backward-compatible for all current call sites. One subtle break: iterators held across a notification see the old map. Document this in the client.

### 3. Event subscription on `McpClient`

```ts
type CatalogEvent =
  | { kind: "tools/list_changed" }
  | { kind: "resources/list_changed" }
  | { kind: "prompts/list_changed" }
  | { kind: "resources/updated"; uri: string };

interface McpClient {
  /** Register a listener for catalog-level events. Returns an unsubscribe fn. */
  onCatalogEvent(listener: (e: CatalogEvent) => void): () => void;
}
```

The session manager uses this to write transcript entries when a notification lands — same pattern as bash exec logs but with source `mcp-notification`.

## Wire mechanics

### HTTP transport — long-lived GET

After `initialize` succeeds, the client opens a second HTTP connection:

```
GET <spec.url>
Accept: text/event-stream
Mcp-Session-Id: <captured>
Authorization: <spec.auth>
```

Outcomes:

| Server response | Action |
|-----------------|--------|
| `200 OK` + `text/event-stream` | Parse events as JSON-RPC notifications; dispatch. |
| `405 Method Not Allowed` / `404` | Server doesn't support server-initiated stream. Log at `info`, disable notifications. |
| Network failure | Exponential backoff: 1s, 2s, 4s, give up after 3 attempts. Log `mcp.stream.disconnected`; catalog events stop but the client still serves requests. |
| 401/403 | Log `mcp.stream.auth_failed` once, disable. Don't spam. |

Lifecycle:
- Stream is closed when `client.close()` runs (via `AbortController`).
- Server emits `event: endpoint` / `event: message` — only `message` events are treated as notifications. Anything else logged at `debug`.

### stdio transport — use the existing pipe

The subprocess's stdout is already parsed line-by-line. Today the client forwards unsolicited notifications to "all pending request listeners" (see `stdio-client.ts` §handleIncomingLine). That's incorrect for catalog events — they aren't tied to an in-flight request.

Fix: intercept `notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`, and `notifications/resources/updated` **before** the per-request listener loop. Dispatch them to the catalog-event subscribers; the per-request progress/message path is unchanged.

## Invalidation flow

### `*/list_changed`

1. Dispatcher receives the notification.
2. Emit `onCatalogEvent` event to subscribers (session manager writes a transcript entry).
3. Enqueue a re-fetch (`tools/list` / `resources/list` / `prompts/list`).
4. On response: atomically swap the appropriate map in the mutable ref. Log `mcp.catalog.refreshed` with old/new counts.
5. Errors during re-fetch: log at `warn`, leave the old map in place. Next notification retries.

Debouncing: if multiple notifications arrive within 500ms (e.g. bursty add-tool loops), coalesce into a single re-fetch. Per-category independently.

### `resources/updated`

1. If `uri` is in our subscribed set: emit `onCatalogEvent` with the uri.
2. a2e-shell does not maintain a content cache of resources (every `/bin/mcp-read` is a round-trip). So the invalidation is advisory — the agent sees the new content on its next `mcp-read` regardless.
3. Transcript entry: the agent knows a watched resource changed.

Future (v1.5+): if we ever cache resource contents, invalidate here.

### Auto-subscribe policy

At connect time, after `resources/list` returns:

```
if (initResult.capabilities?.resources?.subscribe === true) {
  for (const r of resources) subscribeResource(r.uri);  // fire-and-forget, sequential to respect rate limit
}
```

Opt-out:

```jsonc
{ "id": "s", "url": "...", "resources_subscribe": false }  // default true
```

Rationale: on by default, because the transcript gains signal with zero agent friction. Operators who want to reduce MCP call volume can disable per-server.

## Schema changes

### `McpServerSpec`

Add optional `resources_subscribe: boolean` (default `true`) to both the http/sse and stdio branches.

### `CreateSessionResponse.mcp_servers[]`

Add `notifications_stream: "connected" | "unsupported" | "disabled"` — lets operators see at a glance which servers feed catalog events.

### Telemetry

New log events:

- `mcp.stream.connected` — GET succeeded, stream live. Fields: `server_id`, `transport`.
- `mcp.stream.disconnected` — stream closed. Fields: `server_id`, `reason` (eof / error / shutdown), `attempts` (for reconnect count).
- `mcp.stream.unsupported` — 405/404 on the stream GET. Emitted once per connect.
- `mcp.catalog.refreshed` — `list_changed` handled. Fields: `server_id`, `category` (tools/resources/prompts), `before_count`, `after_count`, `duration_ms`.
- `mcp.resource.updated` — `resources/updated` for a subscribed URI. Fields: `server_id`, `uri_sha8`.

New Prometheus metrics:

- `a2e_mcp_notifications_total{server_id,event}` — counter (`tools_list_changed`, `resources_list_changed`, `prompts_list_changed`, `resources_updated`).
- `a2e_mcp_stream_reconnects_total{server_id}` — counter.
- `a2e_mcp_stream_connected{server_id}` — gauge 0/1.

## Error handling

| Code | HTTP | Trigger |
|------|------|---------|
| `MCP_STREAM_UNSUPPORTED` | — | internal; logged once, not surfaced to agent. Catalog stays static for that server. |
| `MCP_PROTOCOL_ERROR` | 502 | malformed notification payload (wrong shape, unparseable JSON). Existing code. |
| `RATE_LIMITED` | 429 | re-fetch triggered by `list_changed` hits the per-server rpm. We skip the fetch, log warning, try again on the next notification. Existing code. |

No new error codes surfaced to the agent.

## Threat model

| # | Threat | Mitigation | Residual |
|---|--------|------------|----------|
| T1 | Malicious server floods `list_changed` to DoS our fetch loop | Debounce 500ms per category + respect per-server rate limit | Server can still starve its own rate budget; harmless to us |
| T2 | Server sends bogus `resources/updated` for never-subscribed URIs | Ignore if `uri` not in our subscribed set; log at debug | None |
| T3 | Server emits `list_changed` with a new tool named to shadow a trusted local bin | The tool is MCP-only; it doesn't touch the binary allowlist. Worst case: agent invokes `mcp-invoke evil-tool` and the server runs whatever it runs. No new surface vs v1.3. | Operator-owned (trust boundary at server selection) |
| T4 | Long-lived GET leaks session-id / auth if connection is proxied through untrusted middleboxes | Same TLS requirement as every other request; `Mcp-Session-Id` is per-session, rotatable. No new credential surface. | None |
| T5 | Memory growth from unbounded notification backlog | Debounce + coalesce; listeners are synchronous callbacks, not queues | None |
| T6 | Subscribed URI list grows without bound (server publishes 10k resources) | Hard cap: 512 subscribed URIs per server. If `resources/list` exceeds, auto-subscribe stops at 512; log `mcp.subscribe.truncated`. | Operator-owned (disable auto-subscribe for huge catalogs) |

## Test plan

### Unit

- Dispatcher: routes each notification type to the right handler.
- Debouncer: two `list_changed` within 500ms → one fetch; one outside 500ms → two fetches.
- Subscription set: idempotent subscribe; unsubscribe removes; cap at 512.

### Integration (mock stdio server)

- Emit `notifications/tools/list_changed` mid-session → client re-fetches, `state.tools` reflects new tool.
- Emit `notifications/resources/updated` for a subscribed URI → `onCatalogEvent` fires.
- Emit `resources/updated` for an UN-subscribed URI → event dropped silently.
- Cap test: server advertises 1000 resources → auto-subscribe truncated at 512.

### Integration (mock HTTP server)

- GET returns 200 + SSE stream → notifications parsed.
- GET returns 405 → fall back to no-stream mode; client still serves requests.
- Stream drops mid-session → 3 reconnect attempts with backoff; log confirms.
- `client.close()` → stream aborts cleanly, no stray reconnect attempts.

### Golden (end-to-end)

Existing `tests/integration/mcp-*.test.ts` should all still pass unchanged.

## Backward compatibility

- Default `resources_subscribe: true` — new behavior on by default. Operators running v1.3 specs unchanged will see auto-subscribe activate the moment they upgrade. Log volume per session goes up modestly (one `mcp.stream.connected` per server on connect).
- Any v1.3 mock server or fixture that doesn't handle `resources/subscribe` will return `method not found`, the client logs `mcp.stream.unsupported` and continues. No break.
- No API schema break on `POST /sessions`. New `notifications_stream` field in the response is additive.

## Rollout

1. Implement dispatcher + list_changed invalidation (both transports).
2. Implement HTTP long-lived GET + reconnect.
3. Implement auto-subscribe.
4. Tests.
5. Ship behind `A2E_MCP_NOTIFICATIONS_ENABLED=1` env flag for one release cycle; flip to default-on in v1.4.1 once a week of production data looks clean.

Alternatively: ship default-on immediately if we believe the threat model is tight enough. Lean toward this — the feature is self-contained, the default behavior in v1.3 is "never see updates" which is strictly worse, and the flag adds drift between deployments.

## Open questions (need user input)

1. **Auto-subscribe default**: `true` (as proposed) or `false` (safer but less useful)?
2. **Subscription cap**: 512 per server reasonable? Or expose as a knob (`resources_subscribe_max`)?
3. **Env flag rollout vs direct default-on**: which posture?
4. **Agent-facing surface**: confirm deferred to v1.5.

