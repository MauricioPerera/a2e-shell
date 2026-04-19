# Workers AI model benchmark — agentic + catalog

Snapshot evaluation of six Cloudflare Workers AI models as the "brain" behind an a2e-shell agent that consumes a skills catalog. Dated 2026-04-19.

## What was tested

- **a2e-shell** deployment: `https://a2e.ardf.dev` running `v1.0.0-rc.3`
- **Catalog** repo: `MauricioPerera/a2e-skills` (orphan `index` branch, `main` for content)
- **Task**: "Give me the last 3 releases of TypeScript (microsoft/TypeScript). Just tag, date, name. In Spanish."
- **Protocol enforced via system prompt** (4 mandatory steps):
  1. `cat $A2E_CATALOG_INDEX/skills.json`
  2. If a matching skill exists, `cat $A2E_CATALOG_CONTENT/skills/<name>/SKILL.md`
  3. Execute the skill via `bash $A2E_CATALOG_CONTENT/skills/<name>/<entry> <args>`
  4. Answer the user in Spanish using real data

A matching skill was intentionally seeded in the catalog: `skills/github-releases` with `requires: [curl, jq]`, `entry: run.sh`, taking `repo` (string) and `count` (number) args. Models that followed the protocol would discover it; those that ignored the protocol would fall back to their training knowledge.

## Capability matrix (verified against each model's doc page)

| | Hermes 2 Pro 7B | Granite 4.0-h-micro | Qwen3 30B-A3B | **Gemma 4 26B-A4B** | Llama 4 Scout 17B | Kimi K2.5 |
|---|---|---|---|---|---|---|
| Model ID | `@hf/nousresearch/hermes-2-pro-mistral-7b` | `@cf/ibm-granite/granite-4.0-h-micro` | `@cf/qwen/qwen3-30b-a3b-fp8` | `@cf/google/gemma-4-26b-a4b-it` | `@cf/meta/llama-4-scout-17b-16e-instruct` | `@cf/moonshotai/kimi-k2.5` |
| Context | 24K | 131K | 32K | 256K | 131K | 256K |
| Function calling | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reasoning | ❌ | ❌ | ✅ default | ✅ opt-in | ❌ | ✅ default |
| Vision | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Batch | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Beta (free) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| $/M input | free | $0.017 | $0.051 | $0.10 | $0.27 | $0.60 |
| $/M cached input | n/a | n/a | n/a | n/a | n/a | $0.10 |
| $/M output | free | $0.11 | $0.34 | $0.30 | $0.85 | $3.00 |

## Tool-call format quirks (measured empirically)

Each model has a different shape for tool-call input/output that a client must handle:

| Model | Input `tools` shape | Output `tool_calls` location + shape | `arguments` type |
|---|---|---|---|
| Hermes | `[{name, description, parameters}]` (flat) | `result.tool_calls[]` with flat `{name, arguments:object}` | object |
| Granite | `[{type:"function", function:{...}}]` (OpenAI wrapped) | `result.choices[0].message.tool_calls[]` OpenAI nested | string, sometimes double-encoded |
| Qwen3 | OpenAI wrapped | `result.choices[0].message.tool_calls[]` OR fallback as `<tool_call>...</tool_call>` in content | string |
| Gemma 4 | OpenAI wrapped | `result.choices[0].message.tool_calls[]` | string |
| Llama 4 Scout | OpenAI wrapped | `result.tool_calls[]` at **root** with OpenAI-nested inner | string |
| Kimi K2.5 | OpenAI wrapped | `result.choices[0].message.tool_calls[]` | string |

A client calling multiple models via CF Workers AI must normalize across at least four patterns. The reference extractor in [`tests/benchmarks/workers-ai-catalog-agent.mjs`](../../tests/benchmarks/workers-ai-catalog-agent.mjs) handles all of them.

## Behavioral results

### Compliance trajectory per model

| | Step 1: discover catalog | Step 2: read SKILL.md | Step 3: execute skill | Step 4: answer in Spanish | Datos reales? |
|---|---|---|---|---|---|
| Hermes | ❌ bypass | ❌ | ❌ (CAPABILITY_DENIED on git) | ✅ but hallucinated | ❌ (2021 fake dates) |
| Granite | ❌ bypass | ❌ | ❌ (CAPABILITY_DENIED on git) | ✅ but said "no puedo" | ❌ |
| Qwen3 | ✅ | ⚠️ skipped | ✅ | ✅ | ✅ |
| Gemma 4 (no thinking) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Gemma 4 (thinking on) | ✅ (razonó el plan) | ✅ | ✅ | ✅ | ✅ |
| Llama 4 Scout | ❌→✅ self-corrected after jq error | ✅ | ❌ wrote command as text | ❌ hallucinated output | ❌ (5.4.5 fake) |
| Kimi K2.5 | ✅ | ✅ | ✅ | ✅ | ✅ |

### Tokens used per model (same task, same prompt)

| | Total tokens | Reasoning chars | Completion cost dominated by | Task cost |
|---|---|---|---|---|
| Hermes | 0 reported (CF doesn't meter beta) | 0 | — | $0 |
| Granite | ~494 | 0 | short direct answers | ~$0.00003 |
| Qwen3 (thinking on) | ~4,700 | ~700 in turn 1 | reasoning overhead | ~$0.0007 |
| Gemma 4 (no thinking) | ~5,800 | 0 | protocol execution (4 turns) | ~$0.00064 |
| Gemma 4 (thinking on) | ~5,864 | 502 in turn 1 only | protocol + selective reasoning | ~$0.00064 |
| Llama 4 Scout | ~5,748 | 0 | protocol attempts (failed t4) | ~$0.00176 |
| Kimi K2.5 | ~5,436 | ~1,020 (balanced across turns) | reasoning + protocol | ~$0.0043 |

### Reasoning usage pattern

When reasoning is on:
- **Qwen3**: verbose (~700 chars/turn), reasons even on mechanical steps → high token overhead
- **Gemma 4 (thinking on)**: **selective** — 502 chars on turn 1 (planning), 0 on turns 2-4 (mechanical execution) → +1% cost vs baseline
- **Kimi**: balanced (~200 chars/turn) with transparent decision logs

Gemma is the only model observed that turns reasoning ON **only when useful**. Qwen3 reasons by default in every turn. Kimi reasons but briefly.

## Failure modes catalogued

1. **Hermes + Granite**: ignore catalog discovery entirely. Go straight to the task, hit `CAPABILITY_DENIED` (git not allowlisted), then refuse or hallucinate. Small models (3B-7B) do not comply with multi-step meta-instructions.

2. **Llama 4 Scout**: self-corrects from a bash error (jq malformed) BUT in the final synthesis step, writes the command as text content instead of emitting a tool_call. Then hallucinates the command's output in the same response. Worst failure mode observed — plausible text with fake data.

3. **Qwen3**: skipped step 2 (reading SKILL.md) and went directly to executing the skill. The happy path still worked because it guessed the args correctly from skills.json alone. But if the skill had an unusual invocation contract, it would fail.

4. **Kimi K2.5 + Gemma 4**: no failures observed in this scenario.

## Defense-in-depth observation

a2e-shell's security model caught all model errors without leaking:

- Hermes + Granite tried `git` commands → `CAPABILITY_DENIED` on the binary allowlist, not on network or filesystem
- Llama 4 emitted a malformed jq → normal subprocess exit 3 with stderr preview in canonical response (no stack trace, no arbitrary bytes)
- No model ever bypassed the session's cwd restriction, env reserved-key enforcement, or redactor

The shell treated "smart" and "dumb" models identically — the capability surface is the same regardless of LLM competence.

## Practical recommendations

### For a2e-shell + catalog deployments (the scenario tested here)

| Need | Model |
|---|---|
| Default interactive agent | **Gemma 4 26B-A4B** (best compliance:cost ratio, vision included) |
| + batch async workloads | Qwen3 30B-A3B (no vision) or Kimi K2.5 (all features, 7× price) |
| Frontier capability / complex reasoning | Kimi K2.5 |
| Prototype on zero budget | Hermes (but no catalog, no compliance) |

### What **not** to use for agentic catalog workflows

- **Granite 4.0-h-micro** for tool-calling with protocols. It has function calling but ignores meta-instructions. Use it only for single-shot queries without a skill catalog.
- **Llama 4 Scout** for complex workflows. Despite being a 17B-active MoE, the observed failure mode (writing tool calls as text + hallucinating output) makes it unreliable for multi-step tasks. May still be fine for batch processing with per-result validation.
- **Hermes 2 Pro** for anything requiring protocol compliance. Great as a free chat model, not suitable as an agent.

## Reproducing

Script: [`tests/benchmarks/workers-ai-catalog-agent.mjs`](../../tests/benchmarks/workers-ai-catalog-agent.mjs)

```bash
# One run per model
export A2E_TOKEN=<bearer to a2e-shell>
export CLOUDFLARE_API_TOKEN=<token with Workers AI:Read>

node tests/benchmarks/workers-ai-catalog-agent.mjs hermes
node tests/benchmarks/workers-ai-catalog-agent.mjs granite
node tests/benchmarks/workers-ai-catalog-agent.mjs qwen
node tests/benchmarks/workers-ai-catalog-agent.mjs gemma
node tests/benchmarks/workers-ai-catalog-agent.mjs gemma-think
node tests/benchmarks/workers-ai-catalog-agent.mjs llama4
node tests/benchmarks/workers-ai-catalog-agent.mjs kimi
```

The script:
1. Creates a session on the a2e-shell endpoint with the catalog mounted
2. Runs the conversation loop (up to 8 turns, one tool-call round trip each)
3. Collects per-turn tokens, reasoning chars, tool_calls emitted, and execution results
4. Cleans up the session

## Caveats

- **Snapshot in time**. Workers AI adds models, deprecates others, changes pricing. Re-run the benchmark before making commitments.
- **One task, one skill**. A single benchmark does not generalize. Models that fail here may succeed on simpler tasks; models that pass here may fail on larger catalogs with many ambiguous skills.
- **Pricing for batch is not documented in the pages fetched** — no conclusion was drawn about batch economics.
- **Errors during testing**. During this evaluation I got the capability matrix wrong twice (missed Qwen3's batch support, missed Gemma+Llama+Kimi's vision support). The verified matrix above was corrected after re-fetching each model's doc row-by-row.

## Surface area touched by this benchmark

- a2e-shell: `POST /sessions` (with catalog spec), `POST /sessions/:id/exec`, `DELETE /sessions/:id`
- Canonical response format: `status_line`, `shape`, `preview`, `binding`, `stderr`, `truncated`, `error.code`
- a2e-skills catalog: `manifest.json`, `skills.json` partition, per-skill `SKILL.md` + `run.sh`, reachability analysis
- Cloudflare Workers AI: `/ai/run/<model>` with OpenAI-compatible `messages + tools` input (heterogeneous shapes per model)

Everything the LLM sees on the wire comes through these primitives. The benchmark demonstrates that the primitives themselves are stable — the variability is entirely in the model's ability to follow a protocol and use the information the protocol makes available.
