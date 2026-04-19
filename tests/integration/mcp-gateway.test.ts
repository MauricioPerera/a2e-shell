import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildApp, API_VERSION } from "../../src/http/server.js";
import { createManager } from "../../src/session/manager.js";
import { createLifecycle } from "../../src/http/lifecycle.js";
import { createCatalogCache } from "../../src/catalog/cache.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// --- minimal mock MCP server (HTTP transport, JSON-RPC over POST) -----------

type RpcHandler = (method: string, params: unknown) => unknown;

function startMockMcp(handler: RpcHandler, opts: { requireToken?: string } = {}): Promise<{
  url: string;
  close(): Promise<void>;
  calls: Array<{ method: string; params: unknown; headers: Record<string, string | undefined> }>;
}> {
  const calls: Array<{ method: string; params: unknown; headers: Record<string, string | undefined> }> = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const authHeader = req.headers["authorization"];
        if (opts.requireToken && authHeader !== `Bearer ${opts.requireToken}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "bad token" }));
          return;
        }
        let parsed: { method: string; id?: number; params?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        calls.push({
          method: parsed.method,
          params: parsed.params,
          headers: {
            authorization: Array.isArray(authHeader) ? authHeader[0] : authHeader,
          },
        });
        // Notification: no response
        if (parsed.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        try {
          const result = handler(parsed.method, parsed.params);
          res.setHeader("content-type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
        } catch (e) {
          res.setHeader("content-type", "application/json");
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
            }),
          );
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close() {
          return new Promise<void>((res) => server.close(() => res()));
        },
        calls,
      });
    });
  });
}

function makeApp() {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gw-test-"));
  const catalogCache = createCatalogCache({
    enabled: false,
    cacheDir: path.join(sessionsDir, ".cache"),
    refreshSeconds: 0,
    filterBlobs: false,
    maxBytes: 0,
    sweepIntervalSeconds: 0,
  });
  const manager = createManager({
    sessionsDir,
    redactEnvKeys: [],
    catalogBootstrapTimeoutMs: 60_000,
    catalogCache,
    allowedCwdPrefixes: [],
    persistenceEnabled: false,
  });
  const lifecycle = createLifecycle();
  const app = buildApp({
    manager,
    config: {
      authTokens: [],
      port: 0,
      maxRequestBytes: 1_048_576,
      redactEnvKeys: [],
      rateLimitPerMinute: 0,
      rateLimitCreatePerMinute: 0,
      workerId: "test-worker",
    },
    lifecycle,
  });
  return { app, sessionsDir };
}

// --- tests ------------------------------------------------------------------

describe("MCP gateway (RFC 001 v1.1)", () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>;

  const toolList = {
    tools: [
      {
        name: "echo",
        description: "echoes input",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  };

  beforeAll(async () => {
    mock = await startMockMcp((method, params) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "mock-mcp", version: "0.1" },
          capabilities: { tools: { listChanged: false } },
        };
      }
      if (method === "tools/list") return toolList;
      if (method === "tools/call") {
        const p = params as { name: string; arguments: { text: string } };
        return {
          content: [{ type: "text", text: `echo: ${p.arguments.text}` }],
          isError: false,
        };
      }
      throw new Error(`unhandled method: ${method}`);
    });
  });

  afterAll(async () => {
    if (mock) await mock.close();
  });

  it("session create with mcp_servers connects + handshakes + caches tools", async () => {
    const { app } = makeApp();
    const r = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcp_servers: [{ id: "mock", url: mock.url }],
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      mcp_servers: Array<{ id: string; tools_count: number; protocol_version: string }>;
    };
    expect(body.mcp_servers).toHaveLength(1);
    expect(body.mcp_servers[0]!.id).toBe("mock");
    expect(body.mcp_servers[0]!.tools_count).toBe(1);
    expect(body.mcp_servers[0]!.protocol_version).toBe("2025-06-18");

    const methods = mock.calls.map((c) => c.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("tools/list");
  });

  it("exec /bin/mcp-invoke routes to the MCP server and wraps in canonical response", async () => {
    const { app } = makeApp();
    const create = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcp_servers: [{ id: "mock", url: mock.url }],
      }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const execR = await app.request(`/sessions/${session_id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: '/bin/mcp-invoke mock echo {"text":"hi"}',
        bind_as: "result",
      }),
    });
    expect(execR.status).toBe(200);
    const body = (await execR.json()) as {
      status_line: string;
      preview: unknown;
      binding: string | null;
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.status_line).toBe("[exit 0]");
    expect(body.binding).toBe("$result");
    expect(body.preview).toBe("echo: hi");
  });

  it("exec /bin/mcp-invoke with unknown server returns MCP_TOOL_NOT_FOUND", async () => {
    const { app } = makeApp();
    const create = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcp_servers: [{ id: "mock", url: mock.url }],
      }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const execR = await app.request(`/sessions/${session_id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: '/bin/mcp-invoke unknown tool {}' }),
    });
    expect(execR.status).toBe(200);
    const body = (await execR.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("MCP_TOOL_NOT_FOUND");
  });

  it("response always carries X-API-Version header", async () => {
    const { app } = makeApp();
    const r = await app.request("/healthz");
    expect(r.headers.get("X-API-Version")).toBe(API_VERSION);
  });

  it("missing auth env var fails session create with MCP_AUTH_FAILED", async () => {
    // Use a mock that requires a token, and request without setting the env var.
    const authMock = await startMockMcp(
      (method) => {
        if (method === "initialize") return { protocolVersion: "2025-06-18" };
        if (method === "tools/list") return { tools: [] };
        throw new Error(`unhandled: ${method}`);
      },
      { requireToken: "s3cret" },
    );
    try {
      const { app } = makeApp();
      const missing = await app.request("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mcp_servers: [
            {
              id: "auth-mock",
              url: authMock.url,
              auth: { type: "token", env_var: "NOT_SET_TOKEN_XYZ" },
            },
          ],
        }),
      });
      expect(missing.status).toBe(401);
      const body = (await missing.json()) as { error: string };
      expect(body.error).toBe("MCP_AUTH_FAILED");
    } finally {
      await authMock.close();
    }
  });
});
