/**
 * Workers AI model benchmark against a2e-shell + skills catalog.
 *
 * Mounts the a2e-skills catalog (github-releases skill) on a new session and
 * asks each model the same task. Measures: compliance with the discovery
 * protocol, tokens consumed, reasoning usage, hallucination vs real data.
 *
 * Script report: docs/benchmarks/workers-ai-models-2026-04-19.md
 *
 * Env required:
 *   A2E_TOKEN             — bearer for the a2e-shell endpoint
 *   CLOUDFLARE_API_TOKEN  — Workers AI:Read over the account below
 *
 * Usage:
 *   node tests/benchmarks/workers-ai-catalog-agent.mjs <model>
 * where <model> is one of: hermes | granite | qwen | gemma | gemma-think | llama4 | kimi
 *
 * The model id and tool-call shape for each are declared in the MODELS map.
 * The extractor normalizes across four different tool_call shapes observed
 * on Workers AI (see docs/benchmarks/workers-ai-models-2026-04-19.md § Tool-call format quirks).
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "091122c40cc6f8d0d421cbc90e2caca8";
const A2E_URL = process.env.A2E_URL ?? "https://a2e.ardf.dev";
const A2E_TOKEN = process.env.A2E_TOKEN;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const MODELS = {
  hermes: {
    id: "@hf/nousresearch/hermes-2-pro-mistral-7b",
    toolShape: "flat", // tools: [{name, description, parameters}]
  },
  granite: {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    toolShape: "openai", // tools: [{type:"function", function:{name,...}}]
  },
  qwen: {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    toolShape: "openai",
  },
  gemma: {
    id: "@cf/google/gemma-4-26b-a4b-it",
    toolShape: "openai",
  },
  "gemma-think": {
    id: "@cf/google/gemma-4-26b-a4b-it",
    toolShape: "openai",
    extra: {
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: true },
    },
  },
  llama4: {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    toolShape: "openai",
  },
  kimi: {
    id: "@cf/moonshotai/kimi-k2.5",
    toolShape: "openai",
  },
};

const TARGET_MODEL = process.argv[2] ?? "hermes";
const cfg = MODELS[TARGET_MODEL];
if (!cfg) {
  console.error(`Unknown model: ${TARGET_MODEL}. Use: hermes | granite`);
  process.exit(1);
}

const log = (label, obj) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
};

async function a2e(path, method = "POST", body) {
  const r = await fetch(`${A2E_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${A2E_TOKEN}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const TOOLS_FLAT = [
  {
    name: "exec",
    description:
      "Run a bash command in a persistent session. Returns status_line, shape, preview (first 2KB), and optional $binding. The session has environment variables: $A2E_CATALOG_INDEX (path to catalog index worktree), $A2E_CATALOG_CONTENT (path to catalog content worktree), $A2E_CATALOG_REACHABILITY (path to reachability.json).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        bind_as: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
    },
  },
];
const TOOLS_OPENAI = TOOLS_FLAT.map((t) => ({
  type: "function",
  function: t,
}));

async function callModel(messages) {
  const tools = cfg.toolShape === "flat" ? TOOLS_FLAT : TOOLS_OPENAI;
  const body = {
    messages,
    tools,
    max_tokens: 1024,
    temperature: 0.2,
    ...(cfg.extra ?? {}),
  };
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${cfg.id}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${CF_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const json = await r.json();
  if (!json.success) {
    throw new Error(`Model error: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

// Extract tool_calls regardless of model's return shape.
// Four patterns observed on Workers AI:
//   A. Hermes:  result.tool_calls[] = [{name, arguments:object}]           (flat, root)
//   B. Granite/Qwen/Gemma: result.choices[0].message.tool_calls[]          (OpenAI, nested)
//                = [{id, type, function:{name, arguments:string}}]
//   C. Qwen3 fallback: embedded in content as <tool_call>...</tool_call> blocks
//   D. Llama 4: result.tool_calls[] = [{id, type, function:{name, arguments:string}}]  (OpenAI inner, root)
function normalizeArgs(a) {
  if (typeof a === "object" && a !== null) return a;
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return a;
    }
  }
  return a;
}

function extractCalls(result) {
  if (result.tool_calls?.length) {
    // Detect A vs D by looking at the first element's shape
    const first = result.tool_calls[0];
    if (first.function?.name) {
      // Pattern D — Llama 4 style
      return result.tool_calls.map((c) => ({
        name: c.function.name,
        arguments: normalizeArgs(c.function.arguments),
      }));
    }
    // Pattern A — Hermes
    return result.tool_calls.map((c) => ({
      name: c.name,
      arguments: normalizeArgs(c.arguments),
    }));
  }
  const choice = result.choices?.[0];
  if (choice?.message?.tool_calls?.length) {
    return choice.message.tool_calls.map((c) => ({
      name: c.function?.name,
      arguments: normalizeArgs(c.function?.arguments),
    }));
  }
  // Fallback C: parse <tool_call>...</tool_call> embedded in content.
  const content = extractResponse(result);
  if (content?.includes("<tool_call>")) {
    const calls = [];
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let m;
    while ((m = re.exec(content))) {
      try {
        const obj = JSON.parse(m[1]);
        // Qwen emits { "name":..., "arguments": {...} } (args may be object OR string)
        let args = obj.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { /* keep */ }
        }
        calls.push({ name: obj.name, arguments: args });
      } catch {
        /* skip unparseable */
      }
    }
    return calls;
  }
  return [];
}

function extractResponse(result) {
  return result.response ?? result.choices?.[0]?.message?.content ?? "";
}

// --- demo ---

console.log(`# Demo: ${cfg.id} + a2e-shell + CATALOG (a2e-skills)\n`);

const create = await a2e("/sessions", "POST", {
  capabilities: {
    binaries_allowlist: ["curl", "jq", "head", "echo", "cat", "bash"],
  },
  catalog: {
    repo_url: "https://github.com/MauricioPerera/a2e-skills",
    index_ref: "index",
    content_ref: "main",
  },
});
log("session created", create.body);
if (create.status !== 201) {
  console.error("FAILED TO CREATE SESSION");
  process.exit(2);
}
const SID = create.body.session_id;

const messages = [
  {
    role: "system",
    content: [
      "You have one tool: 'exec' (bash). The session has a catalog of skills mounted.",
      "",
      "MANDATORY PROTOCOL — follow in order, do not skip steps:",
      "",
      "STEP 1. Your FIRST exec call MUST be exactly:",
      "  cat $A2E_CATALOG_INDEX/skills.json",
      "Do not call exec with any other command on your first turn.",
      "",
      "STEP 2. After reading skills.json, decide if a listed skill matches the user's task.",
      "  - If yes: your SECOND exec call must be `cat $A2E_CATALOG_CONTENT/skills/<name>/SKILL.md` to read the full skill.",
      "  - If no matching skill: proceed with a direct command.",
      "",
      "STEP 3. If you read a skill, follow its `entry` + `args` spec exactly. Run the skill via:",
      "  bash $A2E_CATALOG_CONTENT/skills/<name>/<entry> <arg1> <arg2> ...",
      "",
      "STEP 4. Answer the user in Spanish using the real data from the tool output.",
      "",
      "Do NOT invoke `git` directly — it is not in the binary allowlist. Use the skill, or fall back to curl.",
    ].join("\n"),
  },
  {
    role: "user",
    content:
      "Dame los últimos 3 releases de TypeScript (microsoft/TypeScript). Solo tag, fecha y nombre. En español.",
  },
];

const turns = [];

try {
  for (let turn = 1; turn <= 8; turn++) {
    console.log(`\n--- turn ${turn}: calling ${TARGET_MODEL} ---`);
    const result = await callModel(messages);
    const calls = extractCalls(result);
    const content = extractResponse(result);

    // Capture reasoning fields (Qwen uses reasoning_content, Gemma uses reasoning)
    const reasoning =
      result.choices?.[0]?.message?.reasoning_content ??
      result.choices?.[0]?.message?.reasoning ??
      null;
    const reasoningLen = reasoning?.length ?? 0;
    const reasoningTokens =
      result.usage?.completion_tokens_details?.reasoning_tokens ?? null;

    turns.push({
      turn,
      usage: result.usage,
      reasoning_chars: reasoningLen,
      reasoning_tokens: reasoningTokens,
      calls_count: calls.length,
      calls: calls.map((c) => ({ name: c.name, command: c.arguments?.command })),
    });

    log(`turn ${turn}`, {
      reasoning_chars: reasoningLen,
      reasoning_tokens: reasoningTokens,
      reasoning_preview: reasoning ? reasoning.slice(0, 300) : null,
      content_preview: content?.slice(0, 400),
      calls: calls.map((c) => ({
        name: c.name,
        args: c.arguments,
      })),
      usage: result.usage,
    });

    if (calls.length === 0) {
      console.log("\n=== FINAL ANSWER ===");
      console.log(content || "(empty)");
      break;
    }

    // Only attach tool_calls when the model actually emitted them structurally.
    // Embedded-in-content calls (Qwen fallback) stay as plain assistant content.
    const structuredCalls =
      result.tool_calls?.length
        ? result.tool_calls
        : result.choices?.[0]?.message?.tool_calls?.length
          ? result.choices[0].message.tool_calls
          : null;
    messages.push({
      role: "assistant",
      content: content ?? "",
      ...(structuredCalls ? { tool_calls: structuredCalls } : {}),
    });

    for (const call of calls) {
      if (!call.arguments?.command) {
        messages.push({
          role: "tool",
          name: call.name,
          content: JSON.stringify({ error: "BAD_ARGS" }),
        });
        continue;
      }
      console.log(`\n--- exec: ${call.arguments.command.slice(0, 200)} ---`);
      const execR = await a2e(`/sessions/${SID}/exec`, "POST", call.arguments);
      log(`exec result (http ${execR.status})`, execR.body);
      messages.push({
        role: "tool",
        name: call.name,
        content: JSON.stringify(execR.body),
      });
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(turns, null, 2));
} finally {
  await a2e(`/sessions/${SID}`, "DELETE");
  console.log("\ncleanup done");
}
