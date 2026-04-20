/**
 * Integration tests for RFC 002 §5 (multi-server hardening).
 *
 * Two concerns:
 *   1. Per-server rate limit (`rate_limit_rpm` on McpServerSpec). Enforced
 *      client-side before the wire call. Throws RATE_LIMITED once the
 *      sliding 60s window fills.
 *   2. Multi-server concurrent load. Four mock HTTP servers mounted on one
 *      session, 100 tools/call round-robin. Asserts latency stays near the
 *      single-server baseline — no global locks, no O(N²) behavior.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { connectMcpServer } from "../../src/mcp/client.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import { buildRateLimiter } from "../../src/mcp/rate-limit.js";
import { A2EError } from "../../src/errors.js";

const REDACTOR = buildRedactor([], process.env);

interface MockServer {
  url: string;
  callCount: () => number;
  close(): Promise<void>;
}

async function startTrivialMock(latencyMs = 0): Promise<MockServer> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { method: string; id?: number };
      if (parsed.id === undefined) {
        res.statusCode = 202;
        res.end();
        return;
      }
      count++;
      const reply = () => {
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: methodResult(parsed.method),
        }));
      };
      if (latencyMs > 0) setTimeout(reply, latencyMs);
      else reply();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        callCount: () => count,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function methodResult(method: string): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0" },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      };
    case "tools/list":
      return { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] };
    case "resources/list": return { resources: [] };
    case "prompts/list": return { prompts: [] };
    case "tools/call":
      return { content: [{ type: "text", text: "ok" }], isError: false };
    default: return {};
  }
}

// =============================================================================
// Rate limiter unit — direct, no HTTP
// =============================================================================

describe("RateLimiter — sliding window", () => {
  it("allows up to rpm calls in a 60s window", () => {
    const lim = buildRateLimiter("s1", 3);
    lim.acquire();
    lim.acquire();
    lim.acquire();
    expect(lim.size).toBe(3);
    expect(() => lim.acquire()).toThrowError(A2EError);
  });

  it("rpm=0 means disabled (always allows)", () => {
    const lim = buildRateLimiter("s1", 0);
    for (let i = 0; i < 10_000; i++) lim.acquire();
    expect(lim.size).toBe(0); // disabled limiter doesn't even track
  });

  it("throws A2EError with code RATE_LIMITED and includes the server id", () => {
    const lim = buildRateLimiter("server-xyz", 1);
    lim.acquire();
    try {
      lim.acquire();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(A2EError);
      const err = e as A2EError;
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.message).toContain("server-xyz");
      expect(err.message).toContain("1/min");
      expect(err.httpStatus).toBe(429);
    }
  });
});

// =============================================================================
// Integration: per-server rate limit on the HTTP client
// =============================================================================

describe("MCP per-server rate limit — HTTP transport", () => {
  let mock: MockServer | null = null;
  afterEach(async () => { await mock?.close(); mock = null; });

  it("enforces rate_limit_rpm client-side before the wire call", async () => {
    mock = await startTrivialMock();
    // rpm: 4 = 3 allowed after initialize + tools/list + resources/list +
    // prompts/list consume the budget during connect(). Actually — connect
    // always does 4 RPCs (initialize + 3 list calls). We need rpm large
    // enough to cover connect, then set up tight remaining budget.
    // Use rpm:5 so after connect (4 calls), we have 1 slot left; a single
    // tools/call should succeed; a second must reject.
    const client = await connectMcpServer({
      spec: {
        id: "lim",
        transport: "http",
        url: mock.url,
        timeout_ms: 5_000,
        rate_limit_rpm: 5,
      },
      processEnv: process.env,
      redactor: REDACTOR,
    });

    // 5th RPC (the tool call) still fits.
    await expect(client.callTool("echo", { message: "a" })).resolves.toBeDefined();
    // 6th is over budget.
    await expect(client.callTool("echo", { message: "b" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    client.close();
  });

  it("rpm=0 disables the client-side limit (unbounded)", async () => {
    mock = await startTrivialMock();
    const client = await connectMcpServer({
      spec: {
        id: "nolim",
        transport: "http",
        url: mock.url,
        timeout_ms: 5_000,
        rate_limit_rpm: 0,
      },
      processEnv: process.env,
      redactor: REDACTOR,
    });
    // Hit the server hard; should all succeed.
    for (let i = 0; i < 20; i++) {
      await client.callTool("echo", { message: `i${i}` });
    }
    expect(mock.callCount()).toBeGreaterThan(20);
    client.close();
  });
});

// =============================================================================
// Integration: multi-server concurrent load
// =============================================================================

describe("MCP multi-server concurrent load", () => {
  const mocks: MockServer[] = [];
  afterEach(async () => {
    await Promise.all(mocks.splice(0).map((m) => m.close()));
  });

  async function spinN(n: number, latencyMs = 0): Promise<MockServer[]> {
    const out = await Promise.all(
      Array.from({ length: n }, () => startTrivialMock(latencyMs)),
    );
    mocks.push(...out);
    return out;
  }

  it("4 HTTP servers × 50 round-robin tools/call stays within parity band vs single-server", async () => {
    // Baseline: single server, 50 calls sequential with simulated 5ms latency.
    const baseMock = (await spinN(1, 5))[0]!;
    const baseClient = await connectMcpServer({
      spec: { id: "base", transport: "http", url: baseMock.url, timeout_ms: 10_000, rate_limit_rpm: 0 },
      processEnv: process.env,
      redactor: REDACTOR,
    });
    const baseStart = Date.now();
    for (let i = 0; i < 50; i++) {
      await baseClient.callTool("echo", { message: `b${i}` });
    }
    const baseMs = Date.now() - baseStart;
    baseClient.close();

    // 4-server round-robin: same latency, same call count. Expected: same or
    // slightly slower due to 4× connection setup overhead; parity band =
    // 2× baseline (generous because CI / network jitter can drift a lot).
    const servers = await spinN(4, 5);
    const clients = await Promise.all(servers.map((s, i) =>
      connectMcpServer({
        spec: { id: `s${i}`, transport: "http", url: s.url, timeout_ms: 10_000, rate_limit_rpm: 0 },
        processEnv: process.env,
        redactor: REDACTOR,
      })));
    const multiStart = Date.now();
    for (let i = 0; i < 50; i++) {
      const c = clients[i % clients.length]!;
      await c.callTool("echo", { message: `m${i}` });
    }
    const multiMs = Date.now() - multiStart;
    for (const c of clients) c.close();

    // The important property: per-call overhead doesn't blow up with N
    // servers. 2× baseline is the ceiling; in practice it should land near
    // or below baseline since each server's queue is smaller.
    expect(multiMs, `4-server multiMs=${multiMs}, baseMs=${baseMs}`)
      .toBeLessThan(baseMs * 2 + 500); // 500ms floor for setup churn

    // Every server got called at least once (round-robin honored).
    for (const s of servers) {
      expect(s.callCount()).toBeGreaterThan(0);
    }
  });

  it("concurrent tools/call across 4 servers (Promise.all) — no global bottleneck", async () => {
    const servers = await spinN(4, 20); // 20ms simulated latency
    const clients = await Promise.all(servers.map((s, i) =>
      connectMcpServer({
        spec: { id: `c${i}`, transport: "http", url: s.url, timeout_ms: 10_000, rate_limit_rpm: 0 },
        processEnv: process.env,
        redactor: REDACTOR,
      })));

    // If calls were globally serialized, 40 × 20ms = 800ms.
    // If isolated per-server and parallel across servers, ≈ (40/4) × 20ms = 200ms.
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        clients[i % clients.length]!.callTool("echo", { message: `x${i}` }),
      ),
    );
    const elapsed = Date.now() - start;

    // Tight gate: parallelism across servers must halve the wall time at
    // minimum. Give generous slack for scheduling jitter.
    expect(elapsed, `40 concurrent calls across 4 servers: ${elapsed}ms`)
      .toBeLessThan(500);
    for (const c of clients) c.close();
  });
});
