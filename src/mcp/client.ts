/**
 * Minimal MCP client — HTTP transport only for v1.1-rc.1.
 *
 * Responsibilities:
 *   - JSON-RPC 2.0 over POST
 *   - initialize handshake + capability negotiation
 *   - tools/list discovery
 *   - tools/call invocation
 *   - Auth token injection (env var → header)
 *   - Timeout enforcement
 *   - Error mapping from JSON-RPC codes → A2EError codes
 *
 * What it intentionally does NOT do:
 *   - SSE / stdio transports (deferred to rc.2+)
 *   - sampling/elicitation/roots (client capabilities we don't offer)
 *   - resources or prompts (rc.2)
 *   - persistent sessions (each call is a fresh request)
 */

import * as crypto from "node:crypto";
import { A2EError } from "../errors.js";
import { logger } from "../logging/logger.js";
import type { Redactor } from "../credentials/redactor.js";
import { buildRateLimiter, type RateLimiter } from "./rate-limit.js";
import type { McpServerSpecHttpT } from "./schema.js";
import { parseSseStream } from "./sse.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallToolResult,
  McpGetPromptResult,
  McpInitializeResult,
  McpPrompt,
  McpResource,
  McpResourceContents,
  McpServerState,
  McpTool,
} from "./types.js";
import {
  buildCatalogDispatcher,
  type CatalogEventListener,
} from "./catalog-dispatcher.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "a2e-shell";
const CLIENT_VERSION = "1.1.0-rc.1";

/**
 * Notifications observed during an in-flight request (typically
 * `notifications/progress`, `notifications/message`). Non-fatal — the
 * client forwards them to an optional listener and keeps waiting for the
 * matching response id.
 */
export interface McpNotificationListener {
  (notification: { method: string; params?: unknown }): void;
}

export interface McpCallToolOptions {
  readonly onNotification?: McpNotificationListener;
}

export interface McpClient {
  readonly state: McpServerState;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: McpCallToolOptions,
  ): Promise<McpCallToolResult>;
  readResource(uri: string): Promise<readonly McpResourceContents[]>;
  getPrompt(name: string, args: Record<string, unknown>): Promise<McpGetPromptResult>;
  /**
   * Subscribe to resource-update notifications for `uri` (RFC 004, v1.4).
   * Idempotent. Returns true on wire success, false if the server lacks
   * the `resources.subscribe` capability. Rejects with A2EError on protocol
   * error. Internal API — not exposed through any agent-facing verb in v1.4.
   */
  subscribeResource(uri: string): Promise<boolean>;
  /** Unsubscribe. Idempotent. Errors on the wire are swallowed at debug. */
  unsubscribeResource(uri: string): Promise<void>;
  /**
   * Register a listener for catalog-level events (RFC 004, v1.4). Returns
   * an unsubscribe fn. Events:
   *   - `tools/list_changed`
   *   - `resources/list_changed`
   *   - `prompts/list_changed`
   *   - `resources/updated` (only for subscribed URIs)
   * Debounced at 500ms per kind to bound refresh load.
   */
  onCatalogEvent(listener: import("./catalog-dispatcher.js").CatalogEventListener): () => void;
  close(): void;
}

export interface ConnectOptions {
  spec: McpServerSpecHttpT;
  /** Process env. Passed explicitly so tests can mock. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Session redactor to scrub tokens from error messages. */
  redactor: Redactor;
}

/**
 * Connect to an MCP server: resolve auth, send `initialize`, send
 * `notifications/initialized`, cache `tools/list`. Returns an `McpClient`
 * ready for `callTool`.
 *
 * Throws A2EError with one of:
 *   - MCP_AUTH_FAILED    (env var missing or server rejected)
 *   - MCP_SERVER_UNREACHABLE (network / 5xx)
 *   - MCP_PROTOCOL_ERROR  (malformed response, unexpected shape)
 */
export async function connectMcpServer(opts: ConnectOptions): Promise<McpClient> {
  const { spec, processEnv, redactor } = opts;
  const authHeaders = resolveAuthHeaders(spec, processEnv);

  let nextRequestId = 1;
  // MCP 2025-06-18 §2.1.4: servers that maintain state emit `Mcp-Session-Id`
  // on their initialize response. Clients MUST echo it back on every
  // subsequent request. Servers MAY rotate the id mid-session (we adopt the
  // new value from the response); servers MAY invalidate the id (we retry
  // once without the header — see rpc()).
  let cachedSessionId: string | null = null;
  // Per-server rate limiter. Enforced pre-flight so rate-capped clients fail
  // fast without burning server quota. 0 rpm = disabled.
  const rateLimiter: RateLimiter = buildRateLimiter(spec.id, spec.rate_limit_rpm);

  interface RpcOptions {
    /** Extra fields to merge into request.params._meta — used for progressToken. */
    meta?: Record<string, unknown>;
    /** Callback for notifications arriving before the matching response. */
    onNotification?: McpNotificationListener;
  }

  /**
   * Single HTTP round-trip. Public rpc() wraps this with the 400+session-id
   * retry-once logic so retries stay observable as a single RPC from the
   * caller's perspective.
   */
  async function rpcOnce<T>(
    method: string,
    params: unknown,
    rpcOpts: RpcOptions | undefined,
    includeSessionId: boolean,
  ): Promise<{ result: T; rotatedSessionId: string | null }> {
    // Rate limit BEFORE acquiring a request id so a rejected attempt doesn't
    // burn id space. The session-id-retry path (rpc() catch) also calls
    // rpcOnce so a retry counts as a separate call toward the budget — same
    // behavior as an immediate second call would see.
    rateLimiter.acquire();
    const id = nextRequestId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined || rpcOpts?.meta) {
      const p: Record<string, unknown> = (params as Record<string, unknown>) ?? {};
      if (rpcOpts?.meta) p["_meta"] = { ...((p["_meta"] as Record<string, unknown>) ?? {}), ...rpcOpts.meta };
      (body as { params: unknown }).params = p;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeout_ms);
    const started = Date.now();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Announce that we accept both response formats (MCP Streamable HTTP).
      accept: "application/json, text/event-stream",
      ...authHeaders,
    };
    if (includeSessionId && cachedSessionId !== null) {
      headers["Mcp-Session-Id"] = cachedSessionId;
    }

    let res: Response;
    try {
      res = await fetch(spec.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) {
        throw new A2EError(
          "MCP_TIMEOUT",
          `mcp '${spec.id}' ${method} exceeded ${spec.timeout_ms}ms`,
        );
      }
      throw new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' network error: ${redactMessage(msg, redactor)}`,
        503,
      );
    }

    // Capture any Mcp-Session-Id the server returned (even on error responses
    // — a 400 rejecting the cached id can still carry a new one). Returned via
    // `rotatedSessionId` so the caller decides whether to adopt.
    const rotated = res.headers.get("Mcp-Session-Id");
    const rotatedSessionId = rotated && rotated.length > 0 ? rotated : null;

    if (res.status === 401 || res.status === 403) {
      clearTimeout(timer);
      throw new A2EError(
        "MCP_AUTH_FAILED",
        `mcp '${spec.id}' auth rejected (http ${res.status})`,
        401,
      );
    }
    if (res.status === 400) {
      // Inspect the body to see if it looks like a session-id-invalidation
      // error. If so, surface a structured sentinel the outer rpc() can
      // catch and retry once without the header.
      clearTimeout(timer);
      let bodyText = "";
      try { bodyText = await res.text(); } catch { /* ignore */ }
      if (looksLikeSessionIdError(bodyText)) {
        throw new SessionIdRejectedError(rotatedSessionId);
      }
      throw new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' http 400: ${redactMessage(bodyText.slice(0, 200), redactor)}`,
        503,
      );
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' http ${res.status}`,
        503,
      );
    }

    // Branch on response Content-Type. Streamable HTTP servers may pick
    // either application/json or text/event-stream per request.
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    let parsed: unknown;
    try {
      if (contentType.includes("text/event-stream")) {
        if (!res.body) {
          throw new A2EError(
            "MCP_PROTOCOL_ERROR",
            `mcp '${spec.id}' ${method}: empty SSE stream`,
          );
        }
        parsed = await consumeSseForResponse(res.body, id, rpcOpts?.onNotification);
      } else {
        const text = await res.text();
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new A2EError(
            "MCP_PROTOCOL_ERROR",
            `mcp '${spec.id}' ${method}: non-JSON response`,
          );
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (!isJsonRpcResponse(parsed)) {
      throw new A2EError(
        "MCP_PROTOCOL_ERROR",
        `mcp '${spec.id}' ${method}: malformed JSON-RPC response`,
      );
    }
    const response = parsed as JsonRpcResponse<T>;
    logger.debug({
      event: "mcp.rpc",
      server_id: spec.id,
      method,
      duration_ms: Date.now() - started,
      has_error: "error" in response,
      transport: contentType.includes("text/event-stream") ? "sse" : "json",
      ...(cachedSessionId !== null || rotatedSessionId !== null
        ? { mcp_session_id: sessionIdHash(rotatedSessionId ?? cachedSessionId) }
        : {}),
    });

    if ("error" in response) {
      throw new A2EError(
        "MCP_PROTOCOL_ERROR",
        `mcp '${spec.id}' ${method} error ${response.error.code}: ${redactMessage(response.error.message, redactor)}`,
      );
    }
    return { result: response.result, rotatedSessionId };
  }

  /**
   * Public RPC wrapper that handles:
   *   1. Adopting a rotated `Mcp-Session-Id` on success (§2.1.4).
   *   2. Retrying once without the cached id when a 400 looks like an
   *      id-invalidation error (server dropped our session).
   *
   * Notifications (method starting with "notifications/") do NOT go through
   * rpc — they never expect a response, so we keep sendNotification separate.
   */
  async function rpc<T>(
    method: string,
    params?: unknown,
    rpcOpts?: RpcOptions,
  ): Promise<T> {
    try {
      const { result, rotatedSessionId } = await rpcOnce<T>(method, params, rpcOpts, /*includeSessionId*/ true);
      if (rotatedSessionId !== null && rotatedSessionId !== cachedSessionId) {
        logger.info({
          event: "mcp.session_id.rotated",
          server_id: spec.id,
          old_hash: sessionIdHash(cachedSessionId),
          new_hash: sessionIdHash(rotatedSessionId),
        });
        cachedSessionId = rotatedSessionId;
      }
      return result;
    } catch (e) {
      if (e instanceof SessionIdRejectedError) {
        // Server rejected our cached id. Drop it, retry once WITHOUT the
        // header. The second try still throws if the failure was real.
        logger.info({
          event: "mcp.session_id.invalidated",
          server_id: spec.id,
          dropped_hash: sessionIdHash(cachedSessionId),
        });
        cachedSessionId = null;
        const { result, rotatedSessionId } = await rpcOnce<T>(method, params, rpcOpts, /*includeSessionId*/ false);
        if (rotatedSessionId !== null) cachedSessionId = rotatedSessionId;
        return result;
      }
      throw e;
    }
  }

  /**
   * Pulls events from an SSE stream until we encounter the response
   * matching `expectedId`. Notifications (messages without `id`) are
   * forwarded to the optional listener. Returns the raw parsed message
   * so the caller can shape-check it.
   */
  async function consumeSseForResponse(
    body: ReadableStream<Uint8Array>,
    expectedId: number,
    onNotification?: McpNotificationListener,
  ): Promise<unknown> {
    for await (const message of parseSseStream(body)) {
      if (!isJsonRpcResponse(message)) continue; // ignore garbage events

      const m = message as { id?: number | string; method?: string; params?: unknown };
      // Matching response
      if (m.id !== undefined && m.id === expectedId) return message;
      // Notification (no id, has method) — dispatch, then forward.
      // Catalog events (tools/list_changed, resources/updated, etc.) are
      // claimed by the dispatcher; per-request listeners only see leftover
      // notifications (typically progress/message during tools/call).
      if (m.id === undefined && typeof m.method === "string") {
        const claimed = dispatcher.dispatch(m.method, m.params);
        if (!claimed && onNotification) {
          try {
            onNotification({ method: m.method, params: m.params });
          } catch {
            /* swallow listener errors; protocol must continue */
          }
        }
      }
      // Other messages (responses to other requests, unknown shapes) ignored
    }
    throw new A2EError(
      "MCP_PROTOCOL_ERROR",
      `mcp '${spec.id}' SSE stream closed without response for id ${expectedId}`,
    );
  }

  // --- catalog-event dispatcher (RFC 004, v1.4) ---------------------------
  // Built before handshake because SSE responses during handshake may
  // carry catalog notifications. `subscribedUris` is a live reference —
  // the dispatcher reads it on each resources/updated notification to
  // decide whether to emit or drop.
  const subscribedUris = new Set<string>();
  const dispatcher = buildCatalogDispatcher(spec.id, subscribedUris);

  // --- handshake -----------------------------------------------------------

  const initResult = await rpc<McpInitializeResult>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    capabilities: {}, // we offer no client-side features in rc.1
  });

  // Send the initialized notification (fire-and-forget, no response expected).
  // Carries the session id if the server emitted one on initialize — stateful
  // servers expect the notification to be tagged with the same id.
  try {
    const notificationHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...authHeaders,
    };
    if (cachedSessionId !== null) notificationHeaders["Mcp-Session-Id"] = cachedSessionId;
    await fetch(spec.url, {
      method: "POST",
      headers: notificationHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  } catch {
    /* best-effort; servers that require the notification fail tools/list next */
  }

  // --- tools/list ---------------------------------------------------------
  const toolsResp = await rpc<{ tools?: readonly McpTool[] }>("tools/list");
  const tools = new Map<string, McpTool>();
  for (const tool of toolsResp.tools ?? []) {
    if (typeof tool.name === "string" && tool.inputSchema?.type === "object") {
      tools.set(tool.name, tool);
    }
  }

  // --- resources/list (rc.2) ---------------------------------------------
  // Servers that don't expose resources respond with -32601 Method Not Found.
  // We treat that as "empty resources" and continue, matching the MCP spec's
  // capability-negotiation posture.
  const resources = new Map<string, McpResource>();
  try {
    const resp = await rpc<{ resources?: readonly McpResource[] }>("resources/list");
    for (const r of resp.resources ?? []) {
      if (typeof r.uri === "string") resources.set(r.uri, r);
    }
  } catch (e) {
    if (!isMethodNotFound(e)) throw e;
  }

  // --- prompts/list (rc.2) -----------------------------------------------
  const prompts = new Map<string, McpPrompt>();
  try {
    const resp = await rpc<{ prompts?: readonly McpPrompt[] }>("prompts/list");
    for (const p of resp.prompts ?? []) {
      if (typeof p.name === "string") prompts.set(p.name, p);
    }
  } catch (e) {
    if (!isMethodNotFound(e)) throw e;
  }

  const state: McpServerState = {
    id: spec.id,
    url: spec.url,
    protocolVersion: initResult.protocolVersion,
    tools,
    resources,
    prompts,
  };

  logger.info({
    event: "mcp.server.connected",
    server_id: spec.id,
    protocol_version: state.protocolVersion,
    tools_count: tools.size,
    resources_count: resources.size,
    prompts_count: prompts.size,
  });

  return {
    state,
    async callTool(name, args, opts) {
      if (!tools.has(name)) {
        throw new A2EError(
          "MCP_TOOL_NOT_FOUND",
          `mcp '${spec.id}' has no tool '${name}'`,
        );
      }
      // If the caller supplied a notification listener, mint a progressToken
      // and inject it in the request's _meta. The MCP spec: any server that
      // supports progress reports uses this token on its notifications so
      // the client can correlate them to the in-flight request.
      const rpcOpts: { meta?: Record<string, unknown>; onNotification?: McpNotificationListener } = {};
      if (opts?.onNotification) {
        const progressToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        rpcOpts.meta = { progressToken };
        rpcOpts.onNotification = opts.onNotification;
      }
      const result = await rpc<McpCallToolResult>("tools/call", { name, arguments: args }, rpcOpts);
      if (!result.content || !Array.isArray(result.content)) {
        throw new A2EError(
          "MCP_PROTOCOL_ERROR",
          `mcp '${spec.id}' tool '${name}': result missing content array`,
        );
      }
      return result;
    },
    async readResource(uri) {
      const result = await rpc<{ contents?: readonly McpResourceContents[] }>(
        "resources/read",
        { uri },
      );
      if (!result.contents || !Array.isArray(result.contents)) {
        throw new A2EError(
          "MCP_PROTOCOL_ERROR",
          `mcp '${spec.id}' resources/read '${uri}': missing contents array`,
        );
      }
      return result.contents;
    },
    async getPrompt(name, args) {
      if (!prompts.has(name)) {
        throw new A2EError(
          "MCP_TOOL_NOT_FOUND",
          `mcp '${spec.id}' has no prompt '${name}'`,
        );
      }
      const result = await rpc<McpGetPromptResult>("prompts/get", {
        name,
        arguments: args,
      });
      if (!result.messages || !Array.isArray(result.messages)) {
        throw new A2EError(
          "MCP_PROTOCOL_ERROR",
          `mcp '${spec.id}' prompts/get '${name}': missing messages array`,
        );
      }
      return result;
    },
    async subscribeResource(uri) {
      if (subscribedUris.has(uri)) return true;
      try {
        await rpc("resources/subscribe", { uri });
        subscribedUris.add(uri);
        return true;
      } catch (e) {
        if (isMethodNotFound(e)) {
          logger.info({
            event: "mcp.subscribe.unsupported",
            server_id: spec.id,
          });
          return false;
        }
        throw e;
      }
    },
    async unsubscribeResource(uri) {
      if (!subscribedUris.has(uri)) return;
      subscribedUris.delete(uri);
      try {
        await rpc("resources/unsubscribe", { uri });
      } catch (e) {
        logger.debug({
          event: "mcp.unsubscribe.wire_error",
          server_id: spec.id,
          err: (e as Error).message,
        });
      }
    },
    onCatalogEvent(listener: CatalogEventListener) {
      return dispatcher.onCatalogEvent(listener);
    },
    close() {
      // HTTP transport has no persistent connection yet (Phase 3 adds the
      // long-lived GET). Tear down the catalog dispatcher so pending
      // debounce timers don't leak.
      dispatcher.shutdown();
    },
  };
}

/**
 * MCP spec: servers MAY return -32601 Method Not Found for capabilities they
 * don't implement. Our rpc() wraps JSON-RPC errors as MCP_PROTOCOL_ERROR
 * messages that include the numeric code — we sniff for "-32601" to drop the
 * optional capability silently while letting real protocol errors bubble.
 */
function isMethodNotFound(e: unknown): boolean {
  if (!(e instanceof A2EError)) return false;
  return e.code === "MCP_PROTOCOL_ERROR" && /error\s+-?32601/i.test(e.message);
}

// --- helpers ----------------------------------------------------------------

function resolveAuthHeaders(
  spec: McpServerSpecHttpT,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (!spec.auth) return {};
  if (spec.auth.type === "token") {
    const token = processEnv[spec.auth.env_var];
    if (!token) {
      throw new A2EError(
        "MCP_AUTH_FAILED",
        `mcp '${spec.id}': auth env var '${spec.auth.env_var}' is not set`,
        401,
      );
    }
    return { [spec.auth.header]: `${spec.auth.scheme} ${token}` };
  }
  return {};
}

function redactMessage(msg: string, redactor: Redactor): string {
  if (redactor.secrets.length === 0) return msg;
  const bytes = new TextEncoder().encode(msg);
  return new TextDecoder().decode(redactor.redact(bytes));
}

function isJsonRpcResponse(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const o = x as { jsonrpc?: unknown };
  return o.jsonrpc === "2.0";
}

// --- Mcp-Session-Id helpers -------------------------------------------------

/**
 * Internal sentinel thrown by rpcOnce() when a 400 response looks like a
 * session-id-invalidation error. rpc() catches this to drive the single
 * retry without the header.
 *
 * Private to this module — never leaks to callers. The retry loop either
 * succeeds (and returns the result) or re-throws as a regular A2EError.
 */
class SessionIdRejectedError extends Error {
  readonly rotatedSessionId: string | null;
  constructor(rotatedSessionId: string | null) {
    super("Mcp-Session-Id rejected");
    this.name = "SessionIdRejectedError";
    this.rotatedSessionId = rotatedSessionId;
  }
}

/**
 * Heuristic for "this 400 was about the session id, not our request shape".
 * MCP 2025-06-18 doesn't mandate a specific error body, so we look for
 * surface markers most servers emit: the string "session" (case-insensitive)
 * AND either a "-32xxx" JSON-RPC code or a "session_id" / "mcp-session-id"
 * token. False positives cost one extra round-trip; false negatives leave
 * the caller to recreate the session.
 */
function looksLikeSessionIdError(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  if (!lower.includes("session")) return false;
  return (
    lower.includes("mcp-session-id") ||
    lower.includes("session_id") ||
    lower.includes("session id") ||
    /code["\s:]+-32\d{3}/i.test(body)
  );
}

/**
 * First 8 hex chars of SHA-256 over the session id. Used for structured
 * logging — full ids carry auth-equivalent value on some servers, so we
 * never write them to logs. Stable across calls for the same id so
 * operators can correlate events.
 */
function sessionIdHash(id: string | null): string | null {
  if (id === null) return null;
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
}
