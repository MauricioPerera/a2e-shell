/**
 * MCP JSON-RPC 2.0 type definitions. Minimal subset used by the gateway.
 *
 * Follows MCP specification 2025-06-18.
 * https://modelcontextprotocol.io/specification/2025-06-18
 *
 * No runtime validation here — we shape-check at the boundary in client.ts.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: T;
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// --- MCP primitives (server features) ----------------------------------------

export interface McpToolInputSchema {
  readonly type: "object";
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  // Additional JSON schema fields are passed through verbatim to the agent.
  readonly [key: string]: unknown;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: McpToolInputSchema;
}

export interface McpToolContentText {
  readonly type: "text";
  readonly text: string;
}

export interface McpToolContentImage {
  readonly type: "image";
  readonly data: string; // base64
  readonly mimeType: string;
}

export interface McpToolContentResource {
  readonly type: "resource";
  readonly resource: { readonly uri: string; readonly text?: string; readonly mimeType?: string };
}

export type McpToolContent = McpToolContentText | McpToolContentImage | McpToolContentResource;

export interface McpCallToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
}

// --- MCP handshake -----------------------------------------------------------

export interface McpInitializeParams {
  readonly protocolVersion: string;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly capabilities: Record<string, unknown>;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo?: { readonly name: string; readonly version?: string };
  readonly capabilities?: Record<string, unknown>;
}

// Client-side representation of a connected server.
export interface McpServerState {
  readonly id: string;
  readonly url: string;
  readonly sessionId?: string;
  readonly protocolVersion: string;
  readonly tools: ReadonlyMap<string, McpTool>;
}
