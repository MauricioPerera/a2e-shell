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
import type { McpServerSpec } from "./schema.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpCallToolResult,
  McpInitializeResult,
  McpServerState,
  McpTool,
} from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "a2e-shell";
const CLIENT_VERSION = "1.1.0-rc.1";

export interface McpClient {
  readonly state: McpServerState;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): void;
}

export interface ConnectOptions {
  spec: McpServerSpec;
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

  async function rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = nextRequestId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) (body as { params: unknown }).params = params;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeout_ms);
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(spec.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
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
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new A2EError(
        "MCP_AUTH_FAILED",
        `mcp '${spec.id}' auth rejected (http ${res.status})`,
        401,
      );
    }
    if (!res.ok) {
      throw new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' http ${res.status}`,
        503,
      );
    }

    // Some MCP servers speak chunked event-stream even on request/response
    // flows. For rc.1 we require JSON response; event-stream is rc.2 scope.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new A2EError(
        "MCP_PROTOCOL_ERROR",
        `mcp '${spec.id}' ${method}: non-JSON response`,
      );
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
    });

    if ("error" in response) {
      throw new A2EError(
        "MCP_PROTOCOL_ERROR",
        `mcp '${spec.id}' ${method} error ${response.error.code}: ${redactMessage(response.error.message, redactor)}`,
      );
    }
    return response.result;
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

  const state: McpServerState = {
    id: spec.id,
    url: spec.url,
    protocolVersion: initResult.protocolVersion,
    tools,
  };

  logger.info({
    event: "mcp.server.connected",
    server_id: spec.id,
    protocol_version: state.protocolVersion,
    tools_count: tools.size,
  });

  return {
    state,
    async callTool(name, args) {
      if (!tools.has(name)) {
        throw new A2EError(
          "MCP_TOOL_NOT_FOUND",
          `mcp '${spec.id}' has no tool '${name}'`,
        );
      }
      const result = await rpc<McpCallToolResult>("tools/call", {
        name,
        arguments: args,
      });
      if (!result.content || !Array.isArray(result.content)) {
        throw new A2EError(
          "MCP_PROTOCOL_ERROR",
          `mcp '${spec.id}' tool '${name}': result missing content array`,
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

// --- helpers ----------------------------------------------------------------

function resolveAuthHeaders(
  spec: McpServerSpec,
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
