#!/usr/bin/env node
/**
 * Minimal MCP server for the stdio transport integration test.
 *
 * Speaks line-framed JSON-RPC on stdin/stdout. Implements just enough of
 * MCP 2025-06-18 to exercise the connectStdioMcpServer client:
 *   - initialize    → returns protocol version + empty capabilities
 *   - tools/list    → returns one fixture tool
 *   - tools/call    → echoes the arguments back as a text content block
 *   - resources/list → returns one fixture resource
 *   - resources/read → returns a static text/plain payload
 *   - prompts/list  → returns one fixture prompt
 *   - prompts/get   → returns a user message with the arg interpolated
 *
 * Meant to run as a Node subprocess via child_process.spawn. Debug output
 * goes to stderr (the client drops it from the response path).
 *
 * Special test hooks:
 *   - argv[2] === "crash" → exit with code 42 AFTER the handshake is fully
 *     complete (initialize + three list calls), on the first tools/call. This
 *     simulates a mid-session subprocess death — the client connects fine,
 *     then the next RPC hits the void.
 *   - argv[2] === "garbage" → emit a non-JSON line right after initialize
 */

import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

process.stderr.write(`[test-stdio-server] up mode=${mode}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stderr.write(`[test-stdio-server] bad line: ${line}\n`);
    return;
  }
  handle(req);
});

function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize": {
      respond(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "test-stdio-server", version: "0.0.0" },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
      if (mode === "garbage") {
        process.stdout.write("this is not valid json\n");
      }
      return;
    }
    case "notifications/initialized":
      // No response required for notifications.
      return;
    case "tools/list": {
      respond(id, {
        tools: [
          {
            name: "echo",
            description: "Echo back the input message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      });
      return;
    }
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== "echo") {
        respondError(id, -32601, `unknown tool: ${name}`);
        return;
      }
      if (mode === "crash") {
        // Die mid-call: the client has a pending rpc that will surface as
        // MCP_SERVER_UNREACHABLE via the subprocess exit handler. No response
        // is sent on stdout.
        process.exit(42);
      }
      respond(id, {
        content: [{ type: "text", text: `echo: ${args.message ?? ""}` }],
        isError: false,
      });
      return;
    }
    case "resources/list": {
      respond(id, {
        resources: [{ uri: "test://hello", name: "hello", mimeType: "text/plain" }],
      });
      return;
    }
    case "resources/read": {
      const uri = params?.uri;
      if (uri !== "test://hello") {
        respondError(id, -32602, `unknown resource: ${uri}`);
        return;
      }
      respond(id, {
        contents: [{ uri, mimeType: "text/plain", text: "hello from stdio fixture" }],
      });
      return;
    }
    case "prompts/list": {
      respond(id, {
        prompts: [
          {
            name: "greet",
            description: "Greeting template",
            arguments: [{ name: "name", description: "Who to greet", required: true }],
          },
        ],
      });
      return;
    }
    case "prompts/get": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== "greet") {
        respondError(id, -32602, `unknown prompt: ${name}`);
        return;
      }
      respond(id, {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Hello, ${args.name ?? "world"}!` },
          },
        ],
      });
      return;
    }
    default:
      respondError(id, -32601, `method not supported: ${method}`);
  }
}

// Keep the process alive until stdin EOF. When the client closes our stdin,
// readline emits `close` and we exit cleanly.
rl.on("close", () => {
  process.stderr.write(`[test-stdio-server] stdin closed, exiting\n`);
  process.exit(0);
});
