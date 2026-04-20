/**
 * MCP stdio transport client (v1.3).
 *
 * Spawns the MCP server as a subprocess and speaks line-framed JSON-RPC on
 * stdin/stdout. Same McpClient interface as the HTTP/SSE client so the rest
 * of the system (session manager, reachability, exec pipeline) is transport-
 * agnostic.
 *
 * Lifecycle (RFC 002 §4.2):
 *   - connect: spawn + initialize + notifications/initialized + tools/list +
 *     resources/list + prompts/list. Same handshake as HTTP client.
 *   - live: id-correlated RPC; notifications forwarded to per-call listeners.
 *   - close: close stdin (EOF) → SIGTERM after 2s → SIGKILL after 5s.
 *
 * Wire format:
 *   - outgoing: JSON.stringify(msg) + "\n" on stdin
 *   - incoming: split stdout chunks on "\n"; parse each line; drop non-JSON
 *     lines with a debug log (stderr cross-contamination / server debug).
 *   - stderr of the subprocess: logged at debug level, dropped from response path.
 *
 * Crash handling:
 *   - Child exits unexpectedly → all pending requests reject with
 *     MCP_SERVER_UNREACHABLE. Subsequent calls also reject until the session
 *     is recreated (no auto-restart in v1.3).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { A2EError } from "../errors.js";
import { logger } from "../logging/logger.js";
import type { Redactor } from "../credentials/redactor.js";
import { buildRateLimiter, type RateLimiter } from "./rate-limit.js";
import type { McpServerSpecStdioT } from "./schema.js";
import type {
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
import type {
  McpClient,
  McpCallToolOptions,
  McpNotificationListener,
} from "./client.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "a2e-shell";
const CLIENT_VERSION = "1.2.0";
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 5_000;
const MAX_LINE_BYTES = 1_048_576; // 1 MiB per line; longer → SIZE_LIMIT

export interface ConnectStdioOptions {
  spec: McpServerSpecStdioT;
  /** Process env; passed explicitly so tests can mock. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** Session redactor to scrub tokens from error messages. */
  redactor: Redactor;
  /**
   * Absolute path to invoke if `spec.command` is a bare name that resolves
   * via the binary allowlist. Callers (session manager) do the resolution;
   * null means spawn `spec.command` directly (absolute path case).
   */
  resolvedCommand?: string;
}

/**
 * Spawn an MCP subprocess and complete the standard MCP handshake
 * (initialize → notifications/initialized → tools/list + resources/list +
 * prompts/list). Returns an McpClient that shares its interface with the
 * HTTP client so downstream code doesn't branch on transport.
 */
export async function connectStdioMcpServer(
  opts: ConnectStdioOptions,
): Promise<McpClient> {
  const { spec, redactor } = opts;
  const cmd = opts.resolvedCommand ?? spec.command;

  // --- per-connection mutable state ----------------------------------------

  let nextRequestId = 1;
  const rateLimiter: RateLimiter = buildRateLimiter(spec.id, spec.rate_limit_rpm);
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse<unknown>) => void;
      reject: (err: unknown) => void;
      onNotification?: McpNotificationListener;
    }
  >();
  let child: ChildProcessWithoutNullStreams | null = null;
  let childExited = false;
  let childExitError: A2EError | null = null;
  let stdoutBuffer = "";

  // --- spawn ---------------------------------------------------------------

  try {
    // Env overlay: start from process env, layer in spec.env. stdio has no
    // auth layer — env is the only channel for secrets/tokens, and operators
    // route them through the spec.env field explicitly.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.processEnv)) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(spec.env)) childEnv[k] = v;

    const spawnOpts: { shell: false; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"]; cwd?: string } = {
      shell: false,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (spec.cwd) spawnOpts.cwd = spec.cwd;

    child = spawn(cmd, spec.args, spawnOpts) as ChildProcessWithoutNullStreams;
  } catch (e) {
    throw new A2EError(
      "MCP_SERVER_UNREACHABLE",
      `mcp '${spec.id}' spawn failed: ${redactMessage((e as Error).message, redactor)}`,
      503,
    );
  }

  const proc = child;

  // --- stdout framing ------------------------------------------------------

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_LINE_BYTES * 2) {
      // Defensive: if a single unterminated message exceeds 2× the cap, we
      // almost certainly won't find a \n. Drop the buffer and reject everything.
      const err = new A2EError(
        "SIZE_LIMIT",
        `mcp '${spec.id}' stdout exceeded ${MAX_LINE_BYTES} bytes without newline`,
      );
      stdoutBuffer = "";
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      return;
    }
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      if (line.length > MAX_LINE_BYTES) {
        const err = new A2EError(
          "SIZE_LIMIT",
          `mcp '${spec.id}' single stdout line ${line.length}B > ${MAX_LINE_BYTES}B`,
        );
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        continue;
      }
      handleIncomingLine(line);
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    // stderr is informational. Log at debug, scrub secrets, never propagate
    // into response correlation.
    logger.debug({
      event: "mcp.stdio.stderr",
      server_id: spec.id,
      text: redactMessage(chunk, redactor),
    });
  });

  proc.on("error", (e) => {
    childExited = true;
    childExitError = new A2EError(
      "MCP_SERVER_UNREACHABLE",
      `mcp '${spec.id}' subprocess error: ${redactMessage(e.message, redactor)}`,
      503,
    );
    for (const p of pending.values()) p.reject(childExitError);
    pending.clear();
  });

  // stdin is its own stream — ERR_STREAM_WRITE_AFTER_END fires here, not on
  // `proc`. Swallow them: subsequent rpc() calls already guard against a
  // closed stream, and by the time this fires the pending request is either
  // already rejected (close() → childExited) or about to time out.
  proc.stdin.on("error", (e) => {
    logger.debug({
      event: "mcp.stdio.stdin_error",
      server_id: spec.id,
      err: e.message,
    });
  });

  proc.on("exit", (code, signal) => {
    childExited = true;
    // If the exit was orderly (signal from our close()), don't upgrade to an
    // error. Otherwise surface it so in-flight requests fail cleanly.
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
      childExitError = new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' subprocess exited with code=${code} signal=${signal}`,
        503,
      );
      for (const p of pending.values()) p.reject(childExitError);
      pending.clear();
    }
    logger.info({
      event: "mcp.stdio.exit",
      server_id: spec.id,
      exit_code: code,
      signal,
      pending_count: pending.size,
    });
  });

  function handleIncomingLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Garbage line (server debug, stray stderr that leaked into stdout, ...).
      // Drop silently at debug level.
      logger.debug({
        event: "mcp.stdio.non_json_line",
        server_id: spec.id,
        preview: line.slice(0, 80),
      });
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { id?: number | string; method?: string; params?: unknown };

    // Notification (no id) → forward to any in-flight listener.
    if (m.id === undefined && typeof m.method === "string") {
      // Notifications aren't per-request in JSON-RPC, but in MCP the server
      // typically emits progress notifications during an in-flight call.
      // Forward to all pending listeners; the wrong-listener case is benign.
      for (const p of pending.values()) {
        p.onNotification?.({ method: m.method, params: m.params });
      }
      return;
    }

    // Response: match by id.
    if (typeof m.id === "number") {
      const entry = pending.get(m.id);
      if (!entry) {
        logger.debug({
          event: "mcp.stdio.unexpected_response_id",
          server_id: spec.id,
          id: m.id,
        });
        return;
      }
      pending.delete(m.id);
      entry.resolve(msg as JsonRpcResponse<unknown>);
    }
  }

  // --- RPC -----------------------------------------------------------------

  interface RpcOptions {
    meta?: Record<string, unknown>;
    onNotification?: McpNotificationListener;
  }

  async function rpc<T>(method: string, params?: unknown, rpcOpts?: RpcOptions): Promise<T> {
    // Guard against write-after-end: close() calls stdin.end() which marks
    // the stream as no longer writable. Bail before we pay the 'error' event.
    if (childExited || !proc.stdin.writable) {
      throw childExitError ?? new A2EError(
        "MCP_SERVER_UNREACHABLE",
        `mcp '${spec.id}' subprocess has exited or stdin is closed`,
        503,
      );
    }

    rateLimiter.acquire();
    const id = nextRequestId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined || rpcOpts?.meta) {
      const p: Record<string, unknown> = (params as Record<string, unknown>) ?? {};
      if (rpcOpts?.meta) {
        p["_meta"] = { ...((p["_meta"] as Record<string, unknown>) ?? {}), ...rpcOpts.meta };
      }
      (body as { params: unknown }).params = p;
    }

    const started = Date.now();
    const encoded = JSON.stringify(body) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new A2EError(
            "MCP_TIMEOUT",
            `mcp '${spec.id}' ${method} exceeded ${spec.timeout_ms}ms`,
          ));
        }
      }, spec.timeout_ms);

      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          logger.debug({
            event: "mcp.rpc",
            server_id: spec.id,
            method,
            duration_ms: Date.now() - started,
            has_error: "error" in response,
            transport: "stdio",
          });
          if ("error" in response) {
            const err = response.error as { code: number; message: string };
            reject(new A2EError(
              "MCP_PROTOCOL_ERROR",
              `mcp '${spec.id}' ${method} error ${err.code}: ${redactMessage(err.message, redactor)}`,
            ));
            return;
          }
          resolve((response as { result: T }).result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        ...(rpcOpts?.onNotification ? { onNotification: rpcOpts.onNotification } : {}),
      });

      try {
        proc.stdin.write(encoded);
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new A2EError(
          "MCP_SERVER_UNREACHABLE",
          `mcp '${spec.id}' stdin write failed: ${redactMessage((e as Error).message, redactor)}`,
          503,
        ));
      }
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    if (childExited) return;
    const body = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    try {
      proc.stdin.write(JSON.stringify(body) + "\n");
    } catch (e) {
      logger.warn({
        event: "mcp.stdio.notification_failed",
        server_id: spec.id,
        method,
        err: (e as Error).message,
      });
    }
  }

  // --- handshake -----------------------------------------------------------

  const initResult = await rpc<McpInitializeResult>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    capabilities: {},
  });

  sendNotification("notifications/initialized");

  // --- discovery (parallel) ------------------------------------------------

  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    rpc<{ tools: McpTool[] }>("tools/list").catch((e) => {
      if (isMethodNotFound(e)) return { tools: [] as McpTool[] };
      throw e;
    }),
    rpc<{ resources: McpResource[] }>("resources/list").catch((e) => {
      if (isMethodNotFound(e)) return { resources: [] as McpResource[] };
      throw e;
    }),
    rpc<{ prompts: McpPrompt[] }>("prompts/list").catch((e) => {
      if (isMethodNotFound(e)) return { prompts: [] as McpPrompt[] };
      throw e;
    }),
  ]);

  const tools = new Map<string, McpTool>();
  for (const t of toolsResult.tools) tools.set(t.name, t);
  const resources = new Map<string, McpResource>();
  for (const r of resourcesResult.resources) resources.set(r.uri, r);
  const prompts = new Map<string, McpPrompt>();
  for (const p of promptsResult.prompts) prompts.set(p.name, p);

  const state: McpServerState = {
    id: spec.id,
    url: `stdio://${spec.command}`,
    protocolVersion: initResult.protocolVersion,
    tools,
    resources,
    prompts,
  };

  logger.info({
    event: "mcp.stdio.connected",
    server_id: spec.id,
    command: spec.command,
    tools_count: tools.size,
    resources_count: resources.size,
    prompts_count: prompts.size,
    protocol_version: initResult.protocolVersion,
  });

  // --- close ---------------------------------------------------------------

  function close(): void {
    if (childExited) return;
    // EOF stdin; most servers exit cleanly on EOF.
    try { proc.stdin.end(); } catch { /* already closed */ }
    // SIGTERM if still alive after the grace period.
    const termTimer = setTimeout(() => {
      if (!childExited) {
        try { proc.kill("SIGTERM"); } catch { /* best effort */ }
        // SIGKILL if still alive after the kill grace.
        const killTimer = setTimeout(() => {
          if (!childExited) {
            try { proc.kill("SIGKILL"); } catch { /* best effort */ }
          }
        }, KILL_GRACE_MS - TERM_GRACE_MS);
        killTimer.unref();
      }
    }, TERM_GRACE_MS);
    termTimer.unref();
    // Don't hold the event loop open waiting for the child to exit.
    proc.unref();
  }

  // --- McpClient ------------------------------------------------------------

  return {
    state,
    async callTool(name, args, callOpts?: McpCallToolOptions): Promise<McpCallToolResult> {
      if (!tools.has(name)) {
        throw new A2EError(
          "MCP_TOOL_NOT_FOUND",
          `mcp '${spec.id}' has no tool '${name}'`,
        );
      }
      const meta = callOpts?.onNotification ? { progressToken: String(nextRequestId) } : undefined;
      const result = await rpc<McpCallToolResult>(
        "tools/call",
        { name, arguments: args },
        {
          ...(meta ? { meta } : {}),
          ...(callOpts?.onNotification ? { onNotification: callOpts.onNotification } : {}),
        },
      );
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
    close,
  };
}

// --- helpers ----------------------------------------------------------------

function isMethodNotFound(e: unknown): boolean {
  if (!(e instanceof A2EError)) return false;
  return e.code === "MCP_PROTOCOL_ERROR" && /error\s+-?32601/i.test(e.message);
}

function redactMessage(raw: string, redactor: Redactor): string {
  if (redactor.secrets.length === 0) return raw.slice(0, 512);
  const bytes = new TextEncoder().encode(raw);
  return new TextDecoder().decode(redactor.redact(bytes)).slice(0, 512);
}
