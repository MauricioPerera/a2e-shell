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
 *   - argv[2] === "notify"  → initialize advertises resources.subscribe = true;
 *     handles resources/subscribe + resources/unsubscribe; the server emits
 *     notifications on a timed schedule defined via env var:
 *       A2E_TEST_NOTIFY_SCHEDULE="<ms>:<cmd>,<ms>:<cmd>,..."
 *     Supported <cmd>:
 *       list_changed tools      -> tools/list gains a 2nd tool
 *       list_changed resources  -> resources/list gains a 2nd resource
 *       list_changed prompts    -> prompts/list gains a 2nd prompt
 *       updated <uri>           -> resources/updated for uri
 *     Notifications are sent after the handshake completes (timers start
 *     from the first "initialize" request).
 */

import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

// Mutable catalog for "notify" mode so list_changed can be demonstrated.
let toolsExpanded = false;
let resourcesExpanded = false;
let promptsExpanded = false;
const subscribed = new Set();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  const body = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  send(body);
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

/**
 * Parse A2E_TEST_NOTIFY_SCHEDULE once at startup and arm setTimeout for each
 * entry. Cleared automatically if the process exits first.
 */
function armNotifySchedule() {
  if (mode !== "notify") return;
  const schedule = process.env.A2E_TEST_NOTIFY_SCHEDULE ?? "";
  if (!schedule.trim()) return;
  for (const entry of schedule.split(",")) {
    const [msStr, ...cmdParts] = entry.split(":");
    const ms = parseInt(msStr ?? "", 10);
    const cmd = cmdParts.join(":").trim();
    if (!Number.isFinite(ms) || ms < 0 || !cmd) continue;
    setTimeout(() => fireCommand(cmd), ms).unref();
  }
}

function fireCommand(cmd) {
  if (cmd === "list_changed tools") {
    toolsExpanded = true;
    notify("notifications/tools/list_changed");
  } else if (cmd === "list_changed resources") {
    resourcesExpanded = true;
    notify("notifications/resources/list_changed");
  } else if (cmd === "list_changed prompts") {
    promptsExpanded = true;
    notify("notifications/prompts/list_changed");
  } else if (cmd.startsWith("updated ")) {
    const uri = cmd.slice("updated ".length).trim();
    notify("notifications/resources/updated", { uri });
  } else {
    process.stderr.write(`[test-stdio-server] unknown schedule cmd: ${cmd}\n`);
  }
}

armNotifySchedule();

function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize": {
      const capabilities = { tools: {}, resources: {}, prompts: {} };
      if (mode === "notify") {
        capabilities.resources = { subscribe: true, listChanged: true };
        capabilities.tools = { listChanged: true };
        capabilities.prompts = { listChanged: true };
      }
      respond(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "test-stdio-server", version: "0.0.0" },
        capabilities,
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
      const tools = [
        {
          name: "echo",
          description: "Echo back the input message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ];
      if (toolsExpanded) {
        tools.push({
          name: "shout",
          description: "Uppercase variant",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
        });
      }
      respond(id, { tools });
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
      const resources = [{ uri: "test://hello", name: "hello", mimeType: "text/plain" }];
      if (resourcesExpanded) {
        resources.push({ uri: "test://world", name: "world", mimeType: "text/plain" });
      }
      respond(id, { resources });
      return;
    }
    case "resources/subscribe": {
      const uri = params?.uri;
      if (typeof uri !== "string") {
        respondError(id, -32602, "missing uri");
        return;
      }
      subscribed.add(uri);
      respond(id, {});
      return;
    }
    case "resources/unsubscribe": {
      const uri = params?.uri;
      if (typeof uri === "string") subscribed.delete(uri);
      respond(id, {});
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
      const prompts = [
        {
          name: "greet",
          description: "Greeting template",
          arguments: [{ name: "name", description: "Who to greet", required: true }],
        },
      ];
      if (promptsExpanded) {
        prompts.push({ name: "farewell", description: "Goodbye template", arguments: [] });
      }
      respond(id, { prompts });
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
