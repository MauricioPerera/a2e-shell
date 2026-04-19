/**
 * Virtual command intercepts for MCP operations.
 *
 * Three reserved paths routed by a2e-shell before bash spawn:
 *
 *   /bin/mcp-invoke <server> <tool>     <args-json>   → tools/call
 *   /bin/mcp-read   <server> <uri>                     → resources/read
 *   /bin/mcp-prompt <server> <name>     <args-json>   → prompts/get
 *
 * All three wrap the upstream result in the canonical response format
 * (status_line + shape + preview + binding + stderr + truncated) so the
 * agent can consume MCP output with the same discipline as bash output.
 */

import { A2EError, type ErrorCode } from "../errors.js";
import { format } from "../io/format.js";
import type { ExecRequest, ExecResponse } from "../io/protocol.js";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import type { Binding } from "../exec/interpolate.js";
import type { Redactor } from "../credentials/redactor.js";
import type { McpClient, McpNotificationListener } from "./client.js";
import type {
  McpCallToolResult,
  McpGetPromptResult,
  McpResourceContents,
} from "./types.js";

export const INVOKE_PREFIX = "/bin/mcp-invoke";
export const READ_PREFIX = "/bin/mcp-read";
export const PROMPT_PREFIX = "/bin/mcp-prompt";

type Verb = "invoke" | "read" | "prompt";

export interface InvokeContext {
  mcpClients: ReadonlyMap<string, McpClient>;
  policy: ResolvedPolicy;
  redactor: Redactor;
  req: ExecRequest;
  /**
   * Optional sink for MCP notifications that arrive during an in-flight
   * tools/call. Only populated when the caller is streaming (SSE exec).
   * For JSON exec the callback is undefined and notifications are
   * silently dropped (no one is listening).
   */
  onNotification?: McpNotificationListener;
}

export type InvokeOutcome =
  | { kind: "pass" }
  | { kind: "handled"; response: ExecResponse; binding?: Binding };

// --- public detector -------------------------------------------------------

export function isMcpInvoke(command: string): boolean {
  return detectVerb(command) !== null;
}

function detectVerb(command: string): Verb | null {
  const t = command.trimStart();
  if (matchesPrefix(t, INVOKE_PREFIX)) return "invoke";
  if (matchesPrefix(t, READ_PREFIX)) return "read";
  if (matchesPrefix(t, PROMPT_PREFIX)) return "prompt";
  return null;
}

function matchesPrefix(s: string, prefix: string): boolean {
  if (!s.startsWith(prefix)) return false;
  if (s.length === prefix.length) return true;
  const ch = s.charCodeAt(prefix.length);
  return ch === 32 || ch === 9; // space or tab
}

// --- public handler --------------------------------------------------------

export async function handleMcpInvoke(ctx: InvokeContext): Promise<InvokeOutcome> {
  const { mcpClients, policy, redactor, req, onNotification } = ctx;
  const verb = detectVerb(req.command);
  if (!verb) return { kind: "pass" };

  try {
    if (verb === "invoke") {
      const parsed = parseInvoke(req.command);
      return await invokeTool(parsed, mcpClients, policy, redactor, req, onNotification);
    }
    if (verb === "read") {
      const parsed = parseRead(req.command);
      return await invokeRead(parsed, mcpClients, policy, redactor, req);
    }
    const parsed = parsePrompt(req.command);
    return await invokePrompt(parsed, mcpClients, policy, redactor, req);
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
      response: mcpErrorResponse("MCP_PROTOCOL_ERROR", msg),
    };
  }
}

// --- verb dispatchers ------------------------------------------------------

async function invokeTool(
  parsed: { server: string; tool: string; args: Record<string, unknown> },
  clients: ReadonlyMap<string, McpClient>,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
  onNotification?: McpNotificationListener,
): Promise<InvokeOutcome> {
  const client = clients.get(parsed.server);
  if (!client) {
    return {
      kind: "handled",
      response: mcpErrorResponse(
        "MCP_TOOL_NOT_FOUND",
        `mcp server '${parsed.server}' is not connected to this session`,
      ),
    };
  }
  const result = await client.callTool(
    parsed.tool,
    parsed.args,
    onNotification ? { onNotification } : undefined,
  );
  return buildToolResponse(result, policy, redactor, req);
}

async function invokeRead(
  parsed: { server: string; uri: string },
  clients: ReadonlyMap<string, McpClient>,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): Promise<InvokeOutcome> {
  const client = clients.get(parsed.server);
  if (!client) {
    return {
      kind: "handled",
      response: mcpErrorResponse(
        "MCP_TOOL_NOT_FOUND",
        `mcp server '${parsed.server}' is not connected to this session`,
      ),
    };
  }
  const contents = await client.readResource(parsed.uri);
  return buildResourceResponse(contents, policy, redactor, req);
}

async function invokePrompt(
  parsed: { server: string; name: string; args: Record<string, unknown> },
  clients: ReadonlyMap<string, McpClient>,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): Promise<InvokeOutcome> {
  const client = clients.get(parsed.server);
  if (!client) {
    return {
      kind: "handled",
      response: mcpErrorResponse(
        "MCP_TOOL_NOT_FOUND",
        `mcp server '${parsed.server}' is not connected to this session`,
      ),
    };
  }
  const result = await client.getPrompt(parsed.name, parsed.args);
  return buildPromptResponse(result, policy, redactor, req);
}

// --- parsers ---------------------------------------------------------------

export function parseInvoke(command: string): {
  server: string;
  tool: string;
  args: Record<string, unknown>;
} {
  const rest = stripPrefix(command, INVOKE_PREFIX);
  if (rest.length === 0) throw new Error("mcp-invoke: missing server id");

  const firstSp = indexOfWhitespace(rest);
  const server = firstSp < 0 ? rest : rest.slice(0, firstSp);
  validateServerId("mcp-invoke", server);
  if (firstSp < 0) throw new Error("mcp-invoke: missing tool name");

  const afterServer = rest.slice(firstSp).trimStart();
  if (afterServer.length === 0) throw new Error("mcp-invoke: missing tool name");
  const secondSp = indexOfWhitespace(afterServer);
  const tool = secondSp < 0 ? afterServer : afterServer.slice(0, secondSp);
  validateToolName("mcp-invoke", tool);

  if (secondSp < 0) return { server, tool, args: {} };
  const jsonStr = afterServer.slice(secondSp).trim();
  return { server, tool, args: jsonStr ? parseJsonObject("mcp-invoke", jsonStr) : {} };
}

export function parseRead(command: string): { server: string; uri: string } {
  const rest = stripPrefix(command, READ_PREFIX);
  if (rest.length === 0) throw new Error("mcp-read: missing server id");

  const firstSp = indexOfWhitespace(rest);
  const server = firstSp < 0 ? rest : rest.slice(0, firstSp);
  validateServerId("mcp-read", server);
  if (firstSp < 0) throw new Error("mcp-read: missing resource uri");

  const uri = rest.slice(firstSp).trim();
  if (uri.length === 0) throw new Error("mcp-read: missing resource uri");
  // URIs can contain pretty much anything after the scheme. We only sanity
  // check that there's a `:` or a `/` somewhere to reject obvious typos.
  if (!/[:/]/.test(uri)) {
    throw new Error(`mcp-read: '${uri}' does not look like a URI`);
  }
  return { server, uri };
}

export function parsePrompt(command: string): {
  server: string;
  name: string;
  args: Record<string, unknown>;
} {
  const rest = stripPrefix(command, PROMPT_PREFIX);
  if (rest.length === 0) throw new Error("mcp-prompt: missing server id");

  const firstSp = indexOfWhitespace(rest);
  const server = firstSp < 0 ? rest : rest.slice(0, firstSp);
  validateServerId("mcp-prompt", server);
  if (firstSp < 0) throw new Error("mcp-prompt: missing prompt name");

  const afterServer = rest.slice(firstSp).trimStart();
  if (afterServer.length === 0) throw new Error("mcp-prompt: missing prompt name");
  const secondSp = indexOfWhitespace(afterServer);
  const name = secondSp < 0 ? afterServer : afterServer.slice(0, secondSp);
  validateToolName("mcp-prompt", name);

  if (secondSp < 0) return { server, name, args: {} };
  const jsonStr = afterServer.slice(secondSp).trim();
  return { server, name, args: jsonStr ? parseJsonObject("mcp-prompt", jsonStr) : {} };
}

// --- canonical response builders ------------------------------------------

function buildToolResponse(
  result: McpCallToolResult,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): InvokeOutcome {
  const { text, hasNonText } = flattenContent(result.content);
  const cleanBytes = redactor.redact(new TextEncoder().encode(text));

  if (result.isError) {
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
  return wrapBytes(cleanBytes, policy, req, hasNonText ? "+mcp-multimodal" : "");
}

function buildResourceResponse(
  contents: readonly McpResourceContents[],
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): InvokeOutcome {
  // For text resources, concatenate. For blob resources (base64), serialize
  // metadata as JSON so the agent sees shape + mime but not the raw bytes in
  // preview. Large blobs are NOT decoded into preview — they belong in a
  // follow-up tools call if the agent actually wants them.
  const parts: string[] = [];
  let hasBlob = false;
  for (const c of contents) {
    if ("text" in c) {
      parts.push(c.text);
    } else {
      hasBlob = true;
      parts.push(JSON.stringify({ uri: c.uri, mimeType: c.mimeType, blob_bytes: c.blob.length }));
    }
  }
  const cleanBytes = redactor.redact(new TextEncoder().encode(parts.join("\n")));
  return wrapBytes(cleanBytes, policy, req, hasBlob ? "+mcp-blob" : "");
}

function buildPromptResponse(
  result: McpGetPromptResult,
  policy: ResolvedPolicy,
  redactor: Redactor,
  req: ExecRequest,
): InvokeOutcome {
  // Serialize the prompt result as a JSON document — the agent can inspect
  // shape (array of messages with role+content) and iterate with jq.
  const payload = JSON.stringify(
    {
      description: result.description,
      messages: result.messages,
    },
    null,
    2,
  );
  const cleanBytes = redactor.redact(new TextEncoder().encode(payload));
  return wrapBytes(cleanBytes, policy, req, "");
}

function wrapBytes(
  bytes: Uint8Array,
  policy: ResolvedPolicy,
  req: ExecRequest,
  statusAnnotation: string,
): InvokeOutcome {
  const response = format({
    exit_code: 0,
    stdout: bytes,
    stderr: new Uint8Array(0),
    preview_bytes_limit: policy.preview_bytes,
    stderr_bytes_limit: policy.stderr_preview_bytes,
    ...(req.bind_as ? { bind_as: req.bind_as } : {}),
  });

  const finalResponse = statusAnnotation
    ? { ...response, status_line: `${response.status_line} ${statusAnnotation}` }
    : response;

  let binding: Binding | undefined;
  if (req.bind_as) {
    const full = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    binding = {
      value: full,
      shape: response.shape ?? `text[${bytes.length}b]`,
      size_bytes: bytes.length,
    };
  }
  return binding
    ? { kind: "handled", response: finalResponse, binding }
    : { kind: "handled", response: finalResponse };
}

// --- utilities --------------------------------------------------------------

function stripPrefix(command: string, prefix: string): string {
  const t = command.trimStart();
  if (!t.startsWith(prefix)) throw new Error(`not a ${prefix} command`);
  return t.slice(prefix.length).trimStart();
}

function indexOfWhitespace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 32 || ch === 9) return i;
  }
  return -1;
}

function validateServerId(verb: string, id: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error(`${verb}: invalid server id '${id}'`);
  }
}

function validateToolName(verb: string, name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`${verb}: invalid tool name '${name}'`);
  }
}

function parseJsonObject(verb: string, jsonStr: string): Record<string, unknown> {
  let args: unknown;
  try {
    args = JSON.parse(jsonStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${verb}: args must be valid JSON: ${msg}`);
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${verb}: args must be a JSON object`);
  }
  return args as Record<string, unknown>;
}

function flattenContent(
  content: McpCallToolResult["content"],
): { text: string; hasNonText: boolean } {
  const parts: string[] = [];
  let hasNonText = false;
  for (const piece of content) {
    if (piece.type === "text") {
      parts.push(piece.text);
    } else {
      hasNonText = true;
      parts.push(JSON.stringify(piece));
    }
  }
  return { text: parts.join("\n"), hasNonText };
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
