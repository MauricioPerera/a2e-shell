/**
 * Integration tests for the MCP stdio transport (RFC 002 / v1.3).
 *
 * Spawns the test fixture at tests/fixtures/mcp-stdio-server.mjs via the
 * connectStdioMcpServer client and asserts all four MCP primitives
 * (initialize + tools/list, tools/call, resources/read, prompts/get)
 * round-trip correctly over the line-framed JSON-RPC wire.
 *
 * Also covers the two lifecycle corner cases the RFC calls out:
 *   - subprocess crashes mid-session → next call surfaces MCP_SERVER_UNREACHABLE
 *   - garbage stdout line → dropped, not propagated into response correlation
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectStdioMcpServer } from "../../src/mcp/stdio-client.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import { A2EError } from "../../src/errors.js";
import type { McpClient } from "../../src/mcp/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "mcp-stdio-server.mjs");
const REDACTOR = buildRedactor([], process.env);

function baseSpec(mode: "normal" | "crash" | "garbage" = "normal") {
  return {
    id: "test",
    transport: "stdio" as const,
    command: process.execPath, // absolute path to `node`
    args: [FIXTURE, mode],
    env: {},
    timeout_ms: 5_000,
  };
}

describe("MCP stdio transport — happy path", () => {
  let client: McpClient | null = null;
  afterEach(() => { client?.close(); client = null; });

  it("connects, completes handshake, discovers tools/resources/prompts", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    expect(client.state.id).toBe("test");
    expect(client.state.protocolVersion).toBe("2025-06-18");
    expect([...client.state.tools.keys()]).toEqual(["echo"]);
    expect([...client.state.resources.keys()]).toEqual(["test://hello"]);
    expect([...client.state.prompts.keys()]).toEqual(["greet"]);
  });

  it("tools/call round-trips arguments and receives content block", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    const result = await client.callTool("echo", { message: "hi-stdio" });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "text", text: "echo: hi-stdio" });
  });

  it("resources/read returns the fixture payload", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    const contents = await client.readResource("test://hello");
    expect(contents[0]?.text).toBe("hello from stdio fixture");
  });

  it("prompts/get substitutes the argument and returns a user message", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    const prompt = await client.getPrompt("greet", { name: "mcp" });
    expect(prompt.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text", text: "Hello, mcp!" },
    });
  });

  it("tools/call for an unknown tool throws MCP_TOOL_NOT_FOUND (client-side check)", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    await expect(client.callTool("nope", {})).rejects.toMatchObject({
      code: "MCP_TOOL_NOT_FOUND",
    });
  });
});

describe("MCP stdio transport — resilience", () => {
  let client: McpClient | null = null;
  afterEach(() => { client?.close(); client = null; });

  it("garbage non-JSON lines on stdout are dropped, not propagated as responses", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec("garbage"),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    // The garbage line was emitted right after initialize. A follow-up
    // tools/call must still correlate correctly with its id.
    const result = await client.callTool("echo", { message: "after-garbage" });
    expect(result.content[0]).toMatchObject({ text: "echo: after-garbage" });
  });

  it("subprocess crash mid-call surfaces as MCP_SERVER_UNREACHABLE", async () => {
    client = await connectStdioMcpServer({
      spec: baseSpec("crash"),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    // The fixture dies on the first tools/call — pending RPC is rejected via
    // the subprocess exit handler's propagation to pending[].
    await expect(client.callTool("echo", { message: "kaboom" })).rejects.toMatchObject({
      code: "MCP_SERVER_UNREACHABLE",
    });
  });

  it("connect to a non-existent command throws MCP_SERVER_UNREACHABLE (spawn failure)", async () => {
    await expect(
      connectStdioMcpServer({
        spec: {
          ...baseSpec(),
          command: "/nonexistent/path/to/binary/that/does/not/exist",
          args: [],
        },
        processEnv: process.env,
        redactor: REDACTOR,
      }),
    ).rejects.toMatchObject({ code: "MCP_SERVER_UNREACHABLE" });
  });

  it("close() sends EOF and the subprocess exits cleanly", async () => {
    const c = await connectStdioMcpServer({
      spec: baseSpec(),
      processEnv: process.env,
      redactor: REDACTOR,
    });
    // Normal close; should not hang the test runner. If the subprocess
    // didn't exit within the grace window, Vitest's teardown would time out.
    c.close();
    // Subsequent calls should reject with either a subprocess-gone error or
    // a stdin-write error; both map to MCP_SERVER_UNREACHABLE. Accept either.
    await expect(c.callTool("echo", { message: "after-close" })).rejects.toMatchObject({
      code: expect.stringMatching(/^MCP_(SERVER_UNREACHABLE|TIMEOUT)$/),
    });
  });
});
