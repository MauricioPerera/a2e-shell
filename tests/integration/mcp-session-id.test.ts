/**
 * Integration tests for Mcp-Session-Id header threading (RFC 002 §4).
 *
 * Spins up a minimal HTTP MCP server with per-test control over:
 *   - which session id to emit on initialize
 *   - whether to rotate the id on a specific method
 *   - whether to return 400 with a session-id-shaped error body
 *
 * Asserts the client behavior the RFC mandates:
 *   1. Captures the id from the initialize response
 *   2. Echoes it on every subsequent request (stdio is out of scope — no headers)
 *   3. Adopts a rotated id from any subsequent response
 *   4. On 400 with a session-id error, retries once without the header
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { connectMcpServer } from "../../src/mcp/client.js";
import { buildRedactor } from "../../src/credentials/redactor.js";

const REDACTOR = buildRedactor([], process.env);

interface MockServerControls {
  /** Session id emitted on initialize. null = don't send header. */
  initialSessionId: string | null;
  /** If set, rotate to this id on the Nth post-init call (0-indexed). */
  rotateOnCall?: { callIndex: number; newId: string };
  /** If set, respond 400 with the given body for the given call index. */
  rejectOnCall?: { callIndex: number; body: string; newId?: string };
}

interface ObservedCall {
  method: string;
  sessionIdHeader: string | undefined;
}

interface MockServer {
  url: string;
  calls: ObservedCall[];
  close(): Promise<void>;
}

async function startMock(ctrl: MockServerControls): Promise<MockServer> {
  const calls: ObservedCall[] = [];
  let postInitCallIndex = 0; // counts calls AFTER initialize

  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { method: string; id?: number; params?: unknown };
      const sessionIdHeader = req.headers["mcp-session-id"];
      calls.push({
        method: parsed.method,
        sessionIdHeader: Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader,
      });

      if (parsed.id === undefined) {
        // Notification — 202 no body.
        res.statusCode = 202;
        res.end();
        return;
      }

      // initialize: emit initialSessionId in response header (if set).
      if (parsed.method === "initialize") {
        if (ctrl.initialSessionId !== null) {
          res.setHeader("Mcp-Session-Id", ctrl.initialSessionId);
        }
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "mock", version: "0" },
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
        }));
        return;
      }

      // Post-initialize branches (discovery + tool calls).
      const idx = postInitCallIndex++;

      if (ctrl.rejectOnCall && ctrl.rejectOnCall.callIndex === idx) {
        if (ctrl.rejectOnCall.newId) {
          res.setHeader("Mcp-Session-Id", ctrl.rejectOnCall.newId);
        }
        res.setHeader("content-type", "application/json");
        res.statusCode = 400;
        res.end(ctrl.rejectOnCall.body);
        return;
      }

      if (ctrl.rotateOnCall && ctrl.rotateOnCall.callIndex === idx) {
        res.setHeader("Mcp-Session-Id", ctrl.rotateOnCall.newId);
      }

      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      const result = methodResult(parsed.method);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function methodResult(method: string): unknown {
  switch (method) {
    case "tools/list": return { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] };
    case "resources/list": return { resources: [] };
    case "prompts/list": return { prompts: [] };
    case "tools/call": return { content: [{ type: "text", text: "ok" }], isError: false };
    default: return {};
  }
}

function baseSpec(url: string) {
  return { id: "sid-test", transport: "http" as const, url, timeout_ms: 5_000 };
}

describe("Mcp-Session-Id — capture + echo", () => {
  let mock: MockServer | null = null;
  afterEach(async () => { await mock?.close(); mock = null; });

  it("captures the id on initialize and echoes it on every subsequent request", async () => {
    mock = await startMock({ initialSessionId: "sess-abc-123" });
    const client = await connectMcpServer({
      spec: baseSpec(mock.url),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    await client.callTool("echo", { message: "hi" });

    // initialize sent WITHOUT the header (we didn't have it yet).
    expect(mock.calls[0]).toMatchObject({ method: "initialize", sessionIdHeader: undefined });

    // All post-init calls carry the header.
    const postInit = mock.calls.slice(1);
    for (const c of postInit) {
      expect(c.sessionIdHeader, `${c.method}: expected session id echoed`).toBe("sess-abc-123");
    }
    client.close();
  });

  it("omits the header when the server never sent one", async () => {
    mock = await startMock({ initialSessionId: null });
    const client = await connectMcpServer({
      spec: baseSpec(mock.url),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    await client.callTool("echo", {});
    for (const c of mock.calls) {
      expect(c.sessionIdHeader).toBeUndefined();
    }
    client.close();
  });
});

describe("Mcp-Session-Id — rotation", () => {
  let mock: MockServer | null = null;
  afterEach(async () => { await mock?.close(); mock = null; });

  it("adopts a new id when the server rotates mid-session", async () => {
    mock = await startMock({
      initialSessionId: "sess-v1",
      // Post-init call 0 is tools/list (first of the parallel discovery batch).
      // Rotate on call 1 so one of the discovery calls returns the new id.
      rotateOnCall: { callIndex: 1, newId: "sess-v2" },
    });
    const client = await connectMcpServer({
      spec: baseSpec(mock.url),
      processEnv: process.env,
      redactor: REDACTOR,
    });

    // The next call MUST carry the rotated id (sess-v2), not the original.
    await client.callTool("echo", { message: "post-rotate" });

    const toolCall = mock.calls.find((c) => c.method === "tools/call");
    expect(toolCall?.sessionIdHeader).toBe("sess-v2");
    client.close();
  });
});

describe("Mcp-Session-Id — 400 retry-once", () => {
  let mock: MockServer | null = null;
  afterEach(async () => { await mock?.close(); mock = null; });

  it("retries without the header when the server returns 400 citing the session id", async () => {
    // First post-init call (tools/list) gets a 400. Connect should survive.
    mock = await startMock({
      initialSessionId: "expired-sess",
      rejectOnCall: {
        callIndex: 0,
        body: JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Mcp-Session-Id expired" },
        }),
      },
    });
    // Because the reject only fires on call index 0 (tools/list — one of the
    // three parallel discovery calls), and we retry ONCE, the retry should
    // succeed (now at index 1+ which isn't rejected). Connect returns OK.
    const client = await connectMcpServer({
      spec: baseSpec(mock.url),
      processEnv: process.env,
      redactor: REDACTOR,
    });

    // Verify the retry happened: we should see the rejected call PLUS a retry.
    const toolsListCalls = mock.calls.filter((c) => c.method === "tools/list");
    expect(toolsListCalls.length).toBeGreaterThanOrEqual(2);
    // The first carried the header; the retry dropped it.
    expect(toolsListCalls[0]?.sessionIdHeader).toBe("expired-sess");
    expect(toolsListCalls[1]?.sessionIdHeader).toBeUndefined();
    client.close();
  });

  it("non-session-id 400s still surface as MCP_SERVER_UNREACHABLE (no retry)", async () => {
    mock = await startMock({
      initialSessionId: null,
      rejectOnCall: {
        callIndex: 0,
        body: JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32602, message: "Invalid params: missing foo" },
        }),
      },
    });
    await expect(
      connectMcpServer({
        spec: baseSpec(mock.url),
        processEnv: process.env,
        redactor: REDACTOR,
      }),
    ).rejects.toMatchObject({ code: "MCP_SERVER_UNREACHABLE" });
  });
});
