/**
 * Integration tests for RFC 004 phase 3 — long-lived GET notification
 * stream over the HTTP transport.
 *
 * Mock server: one endpoint that switches on HTTP method:
 *   - POST -> normal JSON-RPC handshake + RPC responses (handshake returns
 *     resources.subscribe capability so auto-subscribe runs)
 *   - GET  -> long-lived `text/event-stream`. The test schedules
 *     notifications to emit at specific offsets and asserts the client's
 *     catalog reflects them.
 *
 * Unsupported case: a separate mock responds to GET with 405, verifying
 * that the client degrades gracefully and POST-path RPCs still work.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { connectMcpServer } from "../../src/mcp/client.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import type { McpClient } from "../../src/mcp/client.js";
import type { CatalogEvent } from "../../src/mcp/catalog-dispatcher.js";

const REDACTOR = buildRedactor([], process.env);

interface StreamMock {
  url: string;
  close(): Promise<void>;
  /** Inject a notification into every active GET stream. */
  pushNotification(method: string, params?: unknown): void;
  /** Mutate server-side state (used by handlers below). */
  state: {
    toolsExpanded: boolean;
    resourcesExpanded: boolean;
  };
}

/**
 * Build a mock MCP server. The `getHandler` option controls GET behavior:
 *   - "stream"       — open a long-lived event stream; tests can push via
 *                      `pushNotification`.
 *   - "unsupported"  — respond 405 for GET (server rejects the concept).
 *   - "error500"     — respond 500 for GET (triggers reconnect path).
 */
function startMockMcp(opts: {
  getBehavior: "stream" | "unsupported" | "error500";
}): Promise<StreamMock> {
  const activeStreams = new Set<ServerResponse>();
  const state = { toolsExpanded: false, resourcesExpanded: false };
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method === "GET") {
        if (opts.getBehavior === "unsupported") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (opts.getBehavior === "error500") {
          res.statusCode = 500;
          res.end();
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.statusCode = 200;
        // Send an initial comment/keepalive so the parser ticks; optional.
        res.write(":ping\n\n");
        activeStreams.add(res);
        req.on("close", () => activeStreams.delete(res));
        return;
      }

      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }

      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: { method: string; id?: number; params?: unknown };
        try { parsed = JSON.parse(body); } catch { res.statusCode = 400; res.end(); return; }
        if (parsed.id === undefined) { res.statusCode = 202; res.end(); return; }

        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: computeResult(parsed.method, state),
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        state,
        pushNotification(method, params) {
          const body = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
          const frame = `data: ${JSON.stringify(body)}\n\n`;
          for (const r of activeStreams) {
            try { r.write(frame); } catch { /* stream died */ }
          }
        },
        close: () =>
          new Promise<void>((r) => {
            for (const s of activeStreams) s.end();
            server.close(() => r());
          }),
      });
    });
  });
}

function computeResult(method: string, s: StreamMock["state"]): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "stream-mock", version: "0" },
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
        },
      };
    case "tools/list": {
      const tools = [
        { name: "echo", description: "echo", inputSchema: { type: "object" } },
      ];
      if (s.toolsExpanded) {
        tools.push({ name: "shout", description: "upper", inputSchema: { type: "object" } });
      }
      return { tools };
    }
    case "resources/list": {
      const resources = [{ uri: "mock://r1", name: "r1", mimeType: "text/plain" }];
      if (s.resourcesExpanded) {
        resources.push({ uri: "mock://r2", name: "r2", mimeType: "text/plain" });
      }
      return { resources };
    }
    case "prompts/list":
      return { prompts: [] };
    case "resources/subscribe":
    case "resources/unsubscribe":
      return {};
    case "tools/call":
      return { content: [{ type: "text", text: "ok" }], isError: false };
    default:
      return {};
  }
}

function waitFor(pred: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("RFC 004 phase 3 — HTTP long-lived GET stream", () => {
  let mock: StreamMock | null = null;
  let client: McpClient | null = null;
  afterEach(async () => {
    client?.close();
    client = null;
    await mock?.close();
    mock = null;
  });

  it("delivers tools/list_changed notifications and refreshes state.tools", async () => {
    mock = await startMockMcp({ getBehavior: "stream" });
    client = await connectMcpServer({
      spec: { id: "s1", transport: "http", url: mock.url, timeout_ms: 5_000, rate_limit_rpm: 0, resources_subscribe: true },
      processEnv: process.env,
      redactor: REDACTOR,
    });

    // Wait for the GET stream to actually open on the server side.
    await new Promise((r) => setTimeout(r, 150));
    expect([...client.state.tools.keys()]).toEqual(["echo"]);

    // Flip the catalog on the server, then push a notification.
    mock.state.toolsExpanded = true;
    mock.pushNotification("notifications/tools/list_changed");

    await waitFor(() => client!.state.tools.has("shout"), 3000);
    expect([...client.state.tools.keys()].sort()).toEqual(["echo", "shout"]);
  });

  it("delivers resources/updated for subscribed URIs", async () => {
    mock = await startMockMcp({ getBehavior: "stream" });
    const events: CatalogEvent[] = [];
    client = await connectMcpServer({
      spec: { id: "s2", transport: "http", url: mock.url, timeout_ms: 5_000, rate_limit_rpm: 0, resources_subscribe: true },
      processEnv: process.env,
      redactor: REDACTOR,
    });
    client.onCatalogEvent((e) => events.push(e));

    // Give the GET stream + auto-subscribe a moment.
    await new Promise((r) => setTimeout(r, 200));
    mock.pushNotification("notifications/resources/updated", { uri: "mock://r1" });

    await waitFor(
      () => events.some((e) => e.kind === "resources/updated"),
      3000,
    );
    expect(events.some(
      (e) => e.kind === "resources/updated" && e.uri === "mock://r1",
    )).toBe(true);
  });

  it("degrades gracefully when server returns 405 for GET", async () => {
    mock = await startMockMcp({ getBehavior: "unsupported" });
    // Connect still succeeds; POST path works.
    client = await connectMcpServer({
      spec: { id: "s3", transport: "http", url: mock.url, timeout_ms: 5_000, rate_limit_rpm: 0, resources_subscribe: false },
      processEnv: process.env,
      redactor: REDACTOR,
    });
    expect([...client.state.tools.keys()]).toEqual(["echo"]);
    // RPC still works.
    const result = await client.callTool("echo", {});
    expect(result.isError).toBe(false);
  });
});
