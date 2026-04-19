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

/**
 * Optional streaming handler: called instead of the sync handler when the
 * request matches a specific method. Emits one or more messages as SSE
 * events. Useful for testing progress notifications.
 */
type StreamHandler = (
  method: string,
  params: unknown,
  emit: (msg: unknown) => void,
) => Promise<unknown>;

function startMockMcp(
  handler: RpcHandler,
  opts: {
    requireToken?: string;
    streamFor?: { method: string; handler: StreamHandler };
  } = {},
): Promise<{
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

        // SSE streaming path for specific methods.
        if (opts.streamFor && opts.streamFor.method === parsed.method) {
          res.setHeader("content-type", "text/event-stream");
          res.setHeader("cache-control", "no-cache");
          res.statusCode = 200;
          const write = (msg: unknown) => {
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
          };
          opts.streamFor
            .handler(parsed.method, parsed.params, write)
            .then((result) => {
              write({ jsonrpc: "2.0", id: parsed.id, result });
              res.end();
            })
            .catch((e) => {
              write({
                jsonrpc: "2.0",
                id: parsed.id,
                error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
              });
              res.end();
            });
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

  const resourceList = {
    resources: [
      {
        uri: "catalog://docs/example",
        name: "example",
        description: "an example doc",
        mimeType: "text/markdown",
      },
    ],
  };

  const promptList = {
    prompts: [
      {
        name: "greet",
        description: "greet the user",
        arguments: [{ name: "name", description: "who to greet", required: true }],
      },
    ],
  };

  beforeAll(async () => {
    mock = await startMockMcp((method, params) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "mock-mcp", version: "0.1" },
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            prompts: { listChanged: false },
          },
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
      if (method === "resources/list") return resourceList;
      if (method === "resources/read") {
        const p = params as { uri: string };
        return {
          contents: [
            {
              uri: p.uri,
              mimeType: "text/markdown",
              text: `# Example doc\n\nRequested: ${p.uri}`,
            },
          ],
        };
      }
      if (method === "prompts/list") return promptList;
      if (method === "prompts/get") {
        const p = params as { name: string; arguments: { name: string } };
        return {
          description: "greet the user",
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Hola ${p.arguments.name}` },
            },
          ],
        };
      }
      throw new Error(`unhandled method: ${method}`);
    });
  });

  afterAll(async () => {
    if (mock) await mock.close();
  });

  it("session create with mcp_servers connects + handshakes + caches all primitives", async () => {
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
      mcp_servers: Array<{
        id: string;
        tools_count: number;
        resources_count: number;
        prompts_count: number;
        protocol_version: string;
      }>;
    };
    expect(body.mcp_servers).toHaveLength(1);
    expect(body.mcp_servers[0]!.id).toBe("mock");
    expect(body.mcp_servers[0]!.tools_count).toBe(1);
    expect(body.mcp_servers[0]!.resources_count).toBe(1);
    expect(body.mcp_servers[0]!.prompts_count).toBe(1);
    expect(body.mcp_servers[0]!.protocol_version).toBe("2025-06-18");

    const methods = mock.calls.map((c) => c.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("tools/list");
    expect(methods).toContain("resources/list");
    expect(methods).toContain("prompts/list");
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

  it("exec /bin/mcp-read fetches a resource and wraps in canonical response", async () => {
    const { app } = makeApp();
    const create = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_servers: [{ id: "mock", url: mock.url }] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const execR = await app.request(`/sessions/${session_id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "/bin/mcp-read mock catalog://docs/example",
        bind_as: "doc",
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
    expect(body.binding).toBe("$doc");
    expect(String(body.preview)).toContain("Example doc");
    expect(String(body.preview)).toContain("catalog://docs/example");
  });

  it("exec /bin/mcp-prompt renders the prompt and wraps as JSON", async () => {
    const { app } = makeApp();
    const create = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_servers: [{ id: "mock", url: mock.url }] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const execR = await app.request(`/sessions/${session_id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: '/bin/mcp-prompt mock greet {"name":"Mauricio"}',
      }),
    });
    expect(execR.status).toBe(200);
    const body = (await execR.json()) as {
      status_line: string;
      shape: string | null;
      preview: unknown;
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.status_line).toBe("[exit 0]");
    // prompts/get response serializes to JSON -> shape detects as Object
    expect(body.shape).toMatch(/^json<Object>/);
    expect(JSON.stringify(body.preview)).toContain("Hola Mauricio");
  });

  it("exec /bin/mcp-prompt with unknown prompt returns MCP_TOOL_NOT_FOUND", async () => {
    const { app } = makeApp();
    const create = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mcp_servers: [{ id: "mock", url: mock.url }] }),
    });
    const { session_id } = (await create.json()) as { session_id: string };

    const execR = await app.request(`/sessions/${session_id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/bin/mcp-prompt mock does_not_exist {}" }),
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

  it("tools/call over SSE response with progress notifications reaches the client", async () => {
    // Spin a second mock server configured to stream SSE for tools/call
    // and emit two progress notifications before the final response.
    const streamMock = await startMockMcp(
      (method) => {
        if (method === "initialize") {
          return {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
          };
        }
        if (method === "tools/list") {
          return {
            tools: [
              {
                name: "long_task",
                description: "emits progress",
                inputSchema: { type: "object", properties: {}, required: [] },
              },
            ],
          };
        }
        if (method === "resources/list") return { resources: [] };
        if (method === "prompts/list") return { prompts: [] };
        throw new Error(`unhandled sync method: ${method}`);
      },
      {
        streamFor: {
          method: "tools/call",
          handler: async (_method, params, emit) => {
            const meta = (params as { _meta?: { progressToken?: string } })._meta;
            const token = meta?.progressToken ?? null;
            emit({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: token, progress: 1, total: 3, message: "step 1" },
            });
            emit({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: token, progress: 2, total: 3, message: "step 2" },
            });
            return {
              content: [{ type: "text", text: "task complete" }],
              isError: false,
            };
          },
        },
      },
    );
    try {
      const { app } = makeApp();
      const create = await app.request("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mcp_servers: [{ id: "stream", url: streamMock.url, transport: "sse" }],
        }),
      });
      expect(create.status).toBe(201);
      const { session_id } = (await create.json()) as { session_id: string };

      // Invoke via SSE exec to receive progress events.
      const execR = await app.request(`/sessions/${session_id}/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          command: "/bin/mcp-invoke stream long_task {}",
        }),
      });
      expect(execR.status).toBe(200);
      expect(execR.headers.get("content-type") ?? "").toMatch(/event-stream/);

      const text = await execR.text();
      // Events we expect in order: start, progress, progress, done.
      const events = text
        .split("\n\n")
        .filter((block) => block.trim().length > 0)
        .map((block) => {
          const evLine = block.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          return {
            event: evLine?.slice(6).trim() ?? "",
            data: dataLine?.slice(5).trim() ?? "",
          };
        });
      const types = events.map((e) => e.event);
      expect(types).toContain("start");
      expect(types).toContain("progress");
      expect(types.filter((t) => t === "progress").length).toBeGreaterThanOrEqual(2);
      expect(types).toContain("done");

      // Progress payload should carry the MCP notification method + params.
      const firstProgress = events.find((e) => e.event === "progress");
      const parsed = JSON.parse(firstProgress!.data) as {
        method: string;
        params: { progress: number; message: string };
      };
      expect(parsed.method).toBe("notifications/progress");
      expect(parsed.params.progress).toBe(1);
      expect(parsed.params.message).toBe("step 1");
    } finally {
      await streamMock.close();
    }
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
