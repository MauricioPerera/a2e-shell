/**
 * `/bin/mcp-invoke` intercept — routes exec commands to MCP tool calls.
 *
 * Protocol (agent-facing):
 *   /bin/mcp-invoke <server_id> <tool_name> <args_json>
 *
 * Where `<args_json>` is a JSON object, double-quoted internally so the
 * top-level tokenization can be done by a simple split. The command string
 * as emitted by the agent looks like:
 *
 *   /bin/mcp-invoke github create_issue {"owner":"me","repo":"x","title":"..."}
 *
 * The intercept happens BEFORE state-intercept and BEFORE binary-allowlist
 * enforcement in the pipeline, because:
 *   - /bin/mcp-invoke is not a real binary. Enforcement would reject it.
 *   - state-intercept (cd/export/unset) doesn't match the prefix anyway.
 *
 * Returns either:
 *   - `{ kind: "handled", response }` — MCP call complete, canonical response ready
 *   - `{ kind: "pass" }` — command wasn't an MCP invocation; fall through to bash
 */

import { A2EError, type ErrorCode } from "../errors.js";
import { format } from "../io/format.js";
import type { ExecRequest, ExecResponse } from "../io/protocol.js";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import type { Binding } from "../exec/interpolate.js";
import type { Redactor } from "../credentials/redactor.js";
import type { McpClient } from "./client.js";
import type { McpCallToolResult } from "./types.js";

export const INVOKE_PREFIX = "/bin/mcp-invoke";

export interface InvokeContext {
  mcpClients: ReadonlyMap<string, McpClient>;
  policy: ResolvedPolicy;
  redactor: Redactor;
  req: ExecRequest;
}

export type InvokeOutcome =
  | { kind: "pass" }
  | { kind: "handled"; response: ExecResponse; binding?: Binding };

export function isMcpInvoke(command: string): boolean {
  const trimmed = command.trimStart();
  return (
    trimmed === INVOKE_PREFIX ||
    trimmed.startsWith(`${INVOKE_PREFIX} `) ||
    trimmed.startsWith(`${INVOKE_PREFIX}\t`)
  );
}

export async function handleMcpInvoke(ctx: InvokeContext): Promise<InvokeOutcome> {
  const { mcpClients, policy, redactor, req } = ctx;
  if (!isMcpInvoke(req.command)) return { kind: "pass" };

  let parsed: { server: string; tool: string; args: Record<string, unknown> };
  try {
    parsed = parseInvoke(req.command);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "handled",
      response: mcpErrorResponse("MCP_PROTOCOL_ERROR", msg),
    };
  }

  const client = mcpClients.get(parsed.server);
  if (!client) {
    return {
      kind: "handled",
      response: mcpErrorResponse(
        "MCP_TOOL_NOT_FOUND",
        `mcp server '${parsed.server}' is not connected to this session`,
      ),
    };
  }

  let result: McpCallToolResult;
  try {
    result = await client.callTool(parsed.tool, parsed.args);
  } catch (e) {
    if (e instanceof A2EError) {
      return {
        kind: "handled",
        response: mcpErrorResponse(e.code, redactMessage(e.message, redactor)),
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "handled",
      response: mcpErrorResponse("MCP_PROTOCOL_ERROR", redactMessage(msg, redactor)),
    };
  }

  return buildCanonicalResponse(result, policy, redactor, req);
}

// --- parser -----------------------------------------------------------------

/**
 * Splits `/bin/mcp-invoke <server> <tool> <json>` into its three parts.
 * The JSON part is everything after the second space, verbatim — allows
 * spaces inside the JSON body. The JSON is then parsed.
 */
export function parseInvoke(command: string): {
  server: string;
  tool: string;
  args: Record<string, unknown>;
} {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(INVOKE_PREFIX)) {
    throw new Error("not an mcp-invoke command");
  }
  const rest = trimmed.slice(INVOKE_PREFIX.length).trimStart();
  if (rest.length === 0) {
    throw new Error("mcp-invoke: missing server id");
  }

  // Server id = first whitespace-bounded token
  const firstSp = indexOfWhitespace(rest);
  const server = firstSp < 0 ? rest : rest.slice(0, firstSp);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(server)) {
    throw new Error(`mcp-invoke: invalid server id '${server}'`);
  }
  if (firstSp < 0) {
    throw new Error("mcp-invoke: missing tool name");
  }

  // Tool name = next whitespace-bounded token
  const afterServer = rest.slice(firstSp).trimStart();
  if (afterServer.length === 0) {
    throw new Error("mcp-invoke: missing tool name");
  }
  const secondSp = indexOfWhitespace(afterServer);
  const tool = secondSp < 0 ? afterServer : afterServer.slice(0, secondSp);
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(tool)) {
    throw new Error(`mcp-invoke: invalid tool name '${tool}'`);
  }

  // Remaining = JSON args (optional — defaults to {} when missing)
  if (secondSp < 0) return { server, tool, args: {} };
  const jsonStr = afterServer.slice(secondSp).trim();
  if (jsonStr.length === 0) return { server, tool, args: {} };

  let args: unknown;
  try {
    args = JSON.parse(jsonStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`mcp-invoke: args must be valid JSON: ${msg}`);
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("mcp-invoke: args must be a JSON object");
  }
  return { server, tool, args: args as Record<string, unknown> };
}

// --- canonical response builder --------------------------------------------

function buildCanonicalResponse(
  result: McpCallToolResult,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): InvokeOutcome {
  // Flatten content into a string payload the formatter can shape.
  // Text content → concatenate. Image/resource content → JSON-serialize
  // so the LLM at least sees structure (full multi-modal plumbing is rc.2).
  const textParts: string[] = [];
  let hasNonText = false;
  for (const piece of result.content) {
    if (piece.type === "text") {
      textParts.push(piece.text);
    } else {
      hasNonText = true;
      textParts.push(JSON.stringify(piece));
    }
  }
  const joined = textParts.join("\n");
  const cleanBytes = redactor.redact(new TextEncoder().encode(joined));

  if (result.isError) {
    // Tool-level error (MCP tool ran and reported isError=true). Distinct
    // from PROTOCOL_ERROR (malformed response) — use UPSTREAM_ERROR which
    // is already documented as "the call reached the target but the target
    // reported failure".
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(cleanBytes);
    return {
      kind: "handled",
      response: {
        status_line: "[error: UPSTREAM_ERROR]",
        shape: null,
        preview: null,
        binding: null,
        stderr: decoded.slice(0, policy.stderr_preview_bytes),
        truncated: false,
        error: { code: "UPSTREAM_ERROR", message: "mcp tool reported isError=true" },
      },
    };
  }

  const response = format({
    exit_code: 0,
    stdout: cleanBytes,
    stderr: new Uint8Array(0),
    preview_bytes_limit: policy.preview_bytes,
    stderr_bytes_limit: policy.stderr_preview_bytes,
    ...(req.bind_as ? { bind_as: req.bind_as } : {}),
  });

  // Capture binding value so the caller can add it to session bindings.
  let binding: Binding | undefined;
  if (req.bind_as) {
    const full = new TextDecoder("utf-8", { fatal: false }).decode(cleanBytes);
    binding = {
      value: full,
      shape: response.shape ?? `text[${cleanBytes.length}b]`,
      size_bytes: cleanBytes.length,
    };
  }

  // Mark multi-modal output in status_line so the agent is aware.
  const statusAnnotation = hasNonText ? "+mcp-multimodal" : "";
  const finalResponse: ExecResponse = statusAnnotation
    ? { ...response, status_line: `${response.status_line} ${statusAnnotation}` }
    : response;

  return binding
    ? { kind: "handled", response: finalResponse, binding }
    : { kind: "handled", response: finalResponse };
}

// --- utilities --------------------------------------------------------------

function indexOfWhitespace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 32 || ch === 9) return i;
  }
  return -1;
}

function mcpErrorResponse(code: ErrorCode, message: string): ExecResponse {
  return {
    status_line: `[error: ${code}]`,
    shape: null,
    preview: null,
    binding: null,
    stderr: null,
    truncated: false,
    error: { code, message },
  };
}

function redactMessage(msg: string, redactor: Redactor): string {
  if (redactor.secrets.length === 0) return msg;
  const bytes = new TextEncoder().encode(msg);
  return new TextDecoder().decode(redactor.redact(bytes));
}
