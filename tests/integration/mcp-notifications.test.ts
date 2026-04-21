/**
 * Integration tests for RFC 004 phase 2 — list_changed invalidation and
 * auto-subscribe over the stdio transport.
 *
 * Uses the stdio fixture in "notify" mode: capabilities advertise
 * resources.subscribe; a scheduled set of list_changed / resources/updated
 * notifications fires at known offsets from handshake completion. The
 * client should:
 *
 *   - auto-subscribe every resource returned by resources/list at connect
 *   - re-fetch tools/list on tools/list_changed and surface the new tool
 *     via state.tools
 *   - ditto resources/list and prompts/list
 *   - emit a resources/updated catalog event only for subscribed URIs
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectStdioMcpServer } from "../../src/mcp/stdio-client.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import type { McpClient } from "../../src/mcp/client.js";
import type { CatalogEvent } from "../../src/mcp/catalog-dispatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "mcp-stdio-server.mjs");
const REDACTOR = buildRedactor([], process.env);

function notifySpec(resourcesSubscribe = true) {
  return {
    id: "nfy",
    transport: "stdio" as const,
    command: process.execPath,
    args: [FIXTURE, "notify"],
    env: {},
    timeout_ms: 5_000,
    rate_limit_rpm: 600,
    resources_subscribe: resourcesSubscribe,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("waitFor timeout"));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("RFC 004 phase 2 — list_changed over stdio", () => {
  let client: McpClient | null = null;
  afterEach(() => { client?.close(); client = null; });

  it("refreshes tools on tools/list_changed", async () => {
    client = await connectStdioMcpServer({
      spec: notifySpec(false),
      processEnv: { ...process.env, A2E_TEST_NOTIFY_SCHEDULE: "200:list_changed tools" },
      redactor: REDACTOR,
    });
    expect([...client.state.tools.keys()]).toEqual(["echo"]);
    // Wait past the scheduled notify + debounce window.
    await waitFor(() => client!.state.tools.has("shout"), 3000);
    expect([...client.state.tools.keys()].sort()).toEqual(["echo", "shout"]);
  });

  it("refreshes resources on resources/list_changed", async () => {
    client = await connectStdioMcpServer({
      spec: notifySpec(false),
      processEnv: { ...process.env, A2E_TEST_NOTIFY_SCHEDULE: "200:list_changed resources" },
      redactor: REDACTOR,
    });
    expect([...client.state.resources.keys()]).toEqual(["test://hello"]);
    await waitFor(() => client!.state.resources.has("test://world"), 3000);
    expect([...client.state.resources.keys()].sort()).toEqual([
      "test://hello",
      "test://world",
    ]);
  });

  it("refreshes prompts on prompts/list_changed", async () => {
    client = await connectStdioMcpServer({
      spec: notifySpec(false),
      processEnv: { ...process.env, A2E_TEST_NOTIFY_SCHEDULE: "200:list_changed prompts" },
      redactor: REDACTOR,
    });
    expect([...client.state.prompts.keys()]).toEqual(["greet"]);
    await waitFor(() => client!.state.prompts.has("farewell"), 3000);
  });
});

describe("RFC 004 phase 2 — auto-subscribe over stdio", () => {
  let client: McpClient | null = null;
  afterEach(() => { client?.close(); client = null; });

  it("auto-subscribes every known resource when capability advertised", async () => {
    const events: CatalogEvent[] = [];
    client = await connectStdioMcpServer({
      spec: notifySpec(true),
      // Emit an updated for our subscribed resource after 300ms; if
      // auto-subscribe works, the dispatcher fires. Otherwise dropped.
      processEnv: { ...process.env, A2E_TEST_NOTIFY_SCHEDULE: "300:updated test://hello" },
      redactor: REDACTOR,
    });
    client.onCatalogEvent((e) => events.push(e));
    await waitFor(
      () => events.some((e) => e.kind === "resources/updated"),
      3000,
    );
    expect(events.some(
      (e) => e.kind === "resources/updated" && e.uri === "test://hello",
    )).toBe(true);
  });

  it("does not emit updated for un-subscribed URIs", async () => {
    const events: CatalogEvent[] = [];
    client = await connectStdioMcpServer({
      // resources_subscribe=false => skip auto-subscribe entirely.
      spec: notifySpec(false),
      processEnv: { ...process.env, A2E_TEST_NOTIFY_SCHEDULE: "200:updated test://hello" },
      redactor: REDACTOR,
    });
    client.onCatalogEvent((e) => events.push(e));
    // Give the fixture time to fire; then some extra to ensure no event.
    await new Promise((r) => setTimeout(r, 800));
    expect(events.filter((e) => e.kind === "resources/updated")).toHaveLength(0);
  });
});
