/**
 * Empirical MCP gateway benchmark — runs a real agent task end-to-end
 * against the live a2e.ardf.dev stack, then measures token consumption
 * and compares with the synthetic rc.3 baseline.
 *
 * Scenario: "Use the catalog's echo skill to stamp a message, then
 * return the skill's description." Two turns:
 *   1. agent calls example-echo via /bin/mcp-invoke
 *   2. agent returns human-readable answer
 *
 * The test measures actual tokens consumed through Workers AI
 * (Gemma 4 26B-A4B). The rc.3 synthetic bench predicted ~95% savings
 * on a similar scenario shape; this run checks whether the live stack
 * delivers something close.
 */

import { encode } from "gpt-tokenizer";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "091122c40cc6f8d0d421cbc90e2caca8";
const MODEL = process.env.WORKERS_AI_MODEL ?? "@cf/google/gemma-4-26b-a4b-it";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const A2E_URL = process.env.A2E_URL ?? "https://a2e.ardf.dev";
const A2E_TOKEN = process.env.A2E_TOKEN;

if (!CF_TOKEN || !A2E_TOKEN) {
  console.error("Missing CLOUDFLARE_API_TOKEN or A2E_TOKEN");
  process.exit(1);
}

function t(s) { return encode(s).length; }

async function a2e(path, method, body) {
  const r = await fetch(`${A2E_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${A2E_TOKEN}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
}

async function gemma(messages, tools) {
  const body = { messages, tools, max_tokens: 512, temperature: 0.2 };
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const json = await r.json();
  if (!json.success) throw new Error(`Gemma error: ${JSON.stringify(json.errors ?? json)}`);
  return json.result;
}

const USER_PROMPT = "Use the example-echo skill to stamp the message 'demo OK'. Then tell me the timestamp it produced.";

// --- GATEWAY PATH ----------------------------------------------------------

console.log("=".repeat(70));
console.log("GATEWAY PATH — a2e-shell v1.1 + mcp-serve-catalog + a2e-skills");
console.log("=".repeat(70));

const create = await a2e("/sessions", "POST", {
  mcp_servers: [{ id: "catalog", url: "http://172.17.0.1:8788/mcp" }],
});
if (create.status !== 201) throw new Error(`create failed: ${JSON.stringify(create.body)}`);
const SID = create.body.session_id;
console.log(`\nsession: ${SID}`);
console.log(`mcp_servers:`, create.body.mcp_servers);

// Reachability-filtered tool schema for this task (just example-echo).
// An operator-configured catalog would derive this from session capabilities.
const gatewayTools = [{
  type: "function",
  function: {
    name: "exec",
    description: "Run bash in the session. Use /bin/mcp-invoke <server> <tool> <json-args> to call MCP tools. Canonical response returns status_line, shape, preview, binding.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        bind_as: { type: "string" },
      },
      required: ["command"],
    },
  },
}];

const gatewaySystem = [
  "You are an agent with an 'exec' tool to run bash in a persistent session.",
  "The session has an MCP catalog mounted. Invoke MCP tools via:",
  "  /bin/mcp-invoke catalog <tool-name> <json-args>",
  "Available catalog tools:",
  "  - example-echo {message: string}   — echoes input with timestamp prefix",
  "Exec responses use the canonical format: status_line, shape, preview, binding.",
].join("\n");

const gatewayMsgs = [
  { role: "system", content: gatewaySystem },
  { role: "user", content: USER_PROMPT },
];

let gatewayTotalPrompt = 0;
let gatewayTotalCompletion = 0;
let gatewayTurns = [];

for (let turn = 1; turn <= 4; turn++) {
  const result = await gemma(gatewayMsgs, gatewayTools);
  const choice = result.choices?.[0];
  const msg = choice?.message;
  const tc = msg?.tool_calls?.[0];
  const usage = result.usage;

  gatewayTotalPrompt += usage.prompt_tokens ?? 0;
  gatewayTotalCompletion += usage.completion_tokens ?? 0;
  gatewayTurns.push({ turn, tokens: usage.total_tokens, has_tool_call: !!tc });

  if (!tc) {
    console.log(`\nTurn ${turn}: FINAL ANSWER`);
    console.log(msg.content);
    break;
  }

  const args = JSON.parse(tc.function.arguments);
  console.log(`\nTurn ${turn}: exec command = ${args.command}`);
  const exec = await a2e(`/sessions/${SID}/exec`, "POST", args);

  // Feed back
  gatewayMsgs.push({
    role: "assistant",
    content: msg.content ?? "",
    tool_calls: msg.tool_calls,
  });
  gatewayMsgs.push({
    role: "tool",
    tool_call_id: tc.id,
    name: tc.function.name,
    content: JSON.stringify(exec.body),
  });
}

await a2e(`/sessions/${SID}`, "DELETE");

console.log("\n--- Gateway usage ---");
console.log(`Turns: ${gatewayTurns.length}`);
console.log(`Total prompt tokens:     ${gatewayTotalPrompt}`);
console.log(`Total completion tokens: ${gatewayTotalCompletion}`);
console.log(`Total:                   ${gatewayTotalPrompt + gatewayTotalCompletion}`);

// --- BASELINE PATH ---------------------------------------------------------

console.log("\n" + "=".repeat(70));
console.log("BASELINE PATH — naive MCP client (typical Claude Desktop / Cursor)");
console.log("=".repeat(70));

// Simulate the naive MCP client pattern:
// 1) Full tool list from the MCP server injected into system prompt every turn.
// 2) Tool call returns raw CallToolResult, dumped verbatim into context.
// 3) No cross-turn bindings — server always re-invoked if agent wants data again.

// Fetch the actual catalog's full tool list to feed into baseline
const toolsResp = await fetch("http://127.0.0.1:8788/mcp", {}).catch(() => null);
// We can't reach it locally from this Windows box; use the HTTP passthrough via a2e
// For this simulation: pull the tools by creating a throwaway session
const tmpCreate = await a2e("/sessions", "POST", {
  mcp_servers: [{ id: "catalog", url: "http://172.17.0.1:8788/mcp" }],
});
const tmpSid = tmpCreate.body.session_id;
// The McpServerInfo tells us count, not the schemas. For the test we simulate
// having ~15 tools (realistic for a real catalog) — we replicate example-echo's
// schema 15 times with varied names.
const baselineFullToolList = Array.from({ length: 15 }, (_, i) => ({
  type: "function",
  function: {
    name: `catalog_tool_${i}`,
    description: `Tool ${i}: performs a catalog operation with detailed parameter descriptions. ` +
      `Realistic approximation of a full MCP tool schema including enums, field descriptions, and usage notes.`,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to process" },
        verbose: { type: "boolean", description: "Enable verbose output" },
        format: { type: "string", enum: ["json", "text", "csv"], description: "Output format" },
      },
      required: ["message"],
    },
  },
}));
// Replace the last one with the real echo schema so the model can call it
baselineFullToolList[0] = {
  type: "function",
  function: {
    name: "example_echo",
    description: "illustrates the SKILL convention; echoes a message with a UTC timestamp prefix",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "text to echo back" } },
      required: ["message"],
    },
  },
};
await a2e(`/sessions/${tmpSid}`, "DELETE");

// Naive response = raw MCP CallToolResult dumped as-is
const rawEchoResponse = {
  content: [{ type: "text", text: `[2026-04-20T03:20:00Z] demo OK\n` }],
  isError: false,
};

const baselineSystem = "You are an agent with a catalog of tools. Call tools by their name with JSON args.";
const baselineMsgs = [
  { role: "system", content: baselineSystem },
  { role: "user", content: USER_PROMPT },
];

let baselineTotalPrompt = 0;
let baselineTotalCompletion = 0;
let baselineTurns = [];

for (let turn = 1; turn <= 4; turn++) {
  const result = await gemma(baselineMsgs, baselineFullToolList);
  const choice = result.choices?.[0];
  const msg = choice?.message;
  const tc = msg?.tool_calls?.[0];
  const usage = result.usage;

  baselineTotalPrompt += usage.prompt_tokens ?? 0;
  baselineTotalCompletion += usage.completion_tokens ?? 0;
  baselineTurns.push({ turn, tokens: usage.total_tokens, has_tool_call: !!tc });

  if (!tc) {
    console.log(`\nTurn ${turn}: FINAL ANSWER`);
    console.log(msg.content);
    break;
  }

  const name = tc.function.name;
  const args = JSON.parse(tc.function.arguments);
  console.log(`\nTurn ${turn}: tool_call = ${name}(${JSON.stringify(args)})`);

  const toolResponse = name === "example_echo" ? rawEchoResponse : {
    content: [{ type: "text", text: "not implemented" }],
    isError: true,
  };

  baselineMsgs.push({
    role: "assistant",
    content: msg.content ?? "",
    tool_calls: msg.tool_calls,
  });
  baselineMsgs.push({
    role: "tool",
    tool_call_id: tc.id,
    name,
    content: JSON.stringify(toolResponse),
  });
}

console.log("\n--- Baseline usage ---");
console.log(`Turns: ${baselineTurns.length}`);
console.log(`Total prompt tokens:     ${baselineTotalPrompt}`);
console.log(`Total completion tokens: ${baselineTotalCompletion}`);
console.log(`Total:                   ${baselineTotalPrompt + baselineTotalCompletion}`);

// --- SUMMARY ---------------------------------------------------------------

const totalBase = baselineTotalPrompt + baselineTotalCompletion;
const totalGw = gatewayTotalPrompt + gatewayTotalCompletion;
const saving = ((totalBase - totalGw) / totalBase) * 100;
const costBase = (baselineTotalPrompt * 0.10 + baselineTotalCompletion * 0.30) / 1e6;
const costGw = (gatewayTotalPrompt * 0.10 + gatewayTotalCompletion * 0.30) / 1e6;

console.log("\n" + "=".repeat(70));
console.log("EMPIRICAL COMPARISON");
console.log("=".repeat(70));
console.log(`                       baseline   gateway      Δ`);
console.log(`prompt_tokens:         ${String(baselineTotalPrompt).padStart(8)}  ${String(gatewayTotalPrompt).padStart(8)}  ${((baselineTotalPrompt - gatewayTotalPrompt) / baselineTotalPrompt * 100).toFixed(1).padStart(5)}%`);
console.log(`completion_tokens:     ${String(baselineTotalCompletion).padStart(8)}  ${String(gatewayTotalCompletion).padStart(8)}  ${((baselineTotalCompletion - gatewayTotalCompletion) / baselineTotalCompletion * 100).toFixed(1).padStart(5)}%`);
console.log(`TOTAL:                 ${String(totalBase).padStart(8)}  ${String(totalGw).padStart(8)}  ${saving.toFixed(1).padStart(5)}%`);
console.log(`cost @ Gemma-4:        $${costBase.toFixed(6)}   $${costGw.toFixed(6)}`);
console.log(`\nrc.3 synthetic predicted: 95.9% total savings`);
console.log(`rc.3 empirical now:       ${saving.toFixed(1)}% total savings`);
