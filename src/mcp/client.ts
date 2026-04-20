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

import { A2EError } from "../errors.js";
import { logger } from "../logging/logger.js";
import type { Redactor } from "../credentials/redactor.js";
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

  interface RpcOptions {
    /** Extra fields to merge into request.params._meta — used for progressToken. */
    meta?: Record<string, unknown>;
    /** Callback for notifications arriving before the matching response. */
    onNotification?: McpNotificationListener;
  }

  async function rpc<T>(method: string, params?: unknown, opts?: RpcOptions): Promise<T> {
    const id = nextRequestId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined || opts?.meta) {
      const p: Record<string, unknown> = (params as Record<string, unknown>) ?? {};
      if (opts?.meta) p["_meta"] = { ...((p["_meta"] as Record<string, unknown>) ?? {}), ...opts.meta };
      (body as { params: unknown }).params = p;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeout_ms);
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(spec.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Announce that we accept both response formats (MCP Streamable HTTP).
          accept: "application/json, text/event-stream",
          ...authHeaders,
        },
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

    if (res.status === 401 || res.status === 403) {
      clearTimeout(timer);
      throw new A2EError(
        "MCP_AUTH_FAILED",
        `mcp '${spec.id}' auth rejected (http ${res.status})`,
        401,
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
        parsed = await consumeSseForResponse(res.body, id, opts?.onNotification);
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
    });

    if ("error" in response) {
      throw new A2EError(
        "MCP_PROTOCOL_ERROR",
        `mcp '${spec.id}' ${method} error ${response.error.code}: ${redactMessage(response.error.message, redactor)}`,
      );
    }
    return response.result;
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
      // Notification (no id, has method) — forward
      if (m.id === undefined && typeof m.method === "string") {
        if (onNotification) {
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

  // --- handshake -----------------------------------------------------------

  const initResult = await rpc<McpInitializeResult>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    capabilities: {}, // we offer no client-side features in rc.1
  });

  // Send the initialized notification (fire-and-forget, no response expected).
  try {
    await fetch(spec.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
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
    close() {
      // No persistent connection in HTTP transport. Placeholder for
      // symmetry with future SSE/stdio clients.
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
