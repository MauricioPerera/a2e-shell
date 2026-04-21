/**
 * list_changed -> atomic map refresh + auto-subscribe (RFC 004 phase 2, v1.4).
 *
 * Shared between HTTP and stdio clients. Called once at connect time with
 * the per-client primitives (rpc fn, live Maps, dispatcher). Wires two
 * behaviors:
 *
 *   1. Subscribe the dispatcher's list_changed events to a re-fetcher that
 *      replaces the corresponding Map's contents in-place. Clear + batch-
 *      add is atomic from the single-threaded event loop's perspective; no
 *      reader sees a partial catalog.
 *
 *   2. (If enabled by spec.resources_subscribe and the server advertises
 *      capabilities.resources.subscribe) auto-subscribe every URI returned
 *      by the initial resources/list, capped at 512 per RFC 004 §Threat T6.
 *      Subscriptions are sequential to respect rate_limit_rpm; failures
 *      are logged at warn and don't abort the connect.
 *
 * Errors during refresh leave the old Map in place — next list_changed
 * retries. The re-fetcher swallows method-not-found (server lost the
 * capability mid-session) and logs at warn instead of throwing.
 */

import { logger } from "../logging/logger.js";
import { A2EError } from "../errors.js";
import type {
  McpInitializeResult,
  McpPrompt,
  McpResource,
  McpTool,
} from "./types.js";
import type { CatalogDispatcher } from "./catalog-dispatcher.js";

const AUTO_SUBSCRIBE_CAP = 512;

export interface RefreshInstallOptions {
  readonly serverId: string;
  readonly dispatcher: CatalogDispatcher;
  readonly tools: Map<string, McpTool>;
  readonly resources: Map<string, McpResource>;
  readonly prompts: Map<string, McpPrompt>;
  /**
   * Bound rpc function — same signature both transports expose internally.
   * The refresher calls `tools/list`, `resources/list`, `prompts/list`.
   */
  readonly rpc: <T>(method: string, params?: unknown) => Promise<T>;
  /** True iff server advertised resources.subscribe at initialize. */
  readonly canSubscribe: boolean;
}

/**
 * Install the list_changed -> refresh pipeline. Idempotent per dispatcher
 * (no guard; call once). Returns void; the listener lives as long as the
 * dispatcher does.
 */
export function installCatalogRefresher(opts: RefreshInstallOptions): void {
  opts.dispatcher.onCatalogEvent((event) => {
    switch (event.kind) {
      case "tools/list_changed":
        void refreshTools(opts).catch((e) => logRefreshError(opts.serverId, "tools", e));
        break;
      case "resources/list_changed":
        void refreshResources(opts).catch((e) => logRefreshError(opts.serverId, "resources", e));
        break;
      case "prompts/list_changed":
        void refreshPrompts(opts).catch((e) => logRefreshError(opts.serverId, "prompts", e));
        break;
      case "resources/updated":
        // No content cache to invalidate at a2e-shell layer. Event already
        // propagated to session listeners via the dispatcher; agent sees
        // fresh contents on next /bin/mcp-read.
        break;
    }
  });
}

/**
 * Capability detection: MCP 2025-06-18 encodes subscribe support as
 *   capabilities.resources.subscribe === true
 * on the initialize result. Returns false when the field is missing or
 * explicitly false.
 */
export function serverSupportsSubscribe(init: McpInitializeResult): boolean {
  const caps = init.capabilities as { resources?: { subscribe?: unknown } } | undefined;
  return caps?.resources?.subscribe === true;
}

/**
 * True iff the server advertises ANY notification-producing capability
 * (subscribe, tools.listChanged, resources.listChanged, prompts.listChanged).
 * Used by the HTTP client to decide whether to open the long-lived GET
 * stream. Servers that won't emit notifications get no stream — avoids
 * pointless GET traffic against POST-only JSON-RPC servers.
 */
export function serverMayEmitNotifications(init: McpInitializeResult): boolean {
  const caps = init.capabilities as
    | {
        resources?: { subscribe?: unknown; listChanged?: unknown };
        tools?: { listChanged?: unknown };
        prompts?: { listChanged?: unknown };
      }
    | undefined;
  if (!caps) return false;
  return (
    caps.resources?.subscribe === true
    || caps.resources?.listChanged === true
    || caps.tools?.listChanged === true
    || caps.prompts?.listChanged === true
  );
}

/**
 * Auto-subscribe every URI currently in `resources` (sequential). Caps at
 * AUTO_SUBSCRIBE_CAP to bound the subscribe-set size per RFC 004 §T6.
 * Returns the count actually subscribed. Failures per-URI are logged at
 * warn and don't abort the loop.
 */
export async function autoSubscribeKnownResources(opts: {
  serverId: string;
  resources: ReadonlyMap<string, McpResource>;
  subscribe: (uri: string) => Promise<boolean>;
}): Promise<{ subscribed: number; truncated: boolean }> {
  let subscribed = 0;
  let truncated = false;
  for (const uri of opts.resources.keys()) {
    if (subscribed >= AUTO_SUBSCRIBE_CAP) {
      truncated = true;
      break;
    }
    try {
      const ok = await opts.subscribe(uri);
      if (ok) subscribed++;
      else break; // capability unsupported — don't flog the remaining uris
    } catch (e) {
      logger.warn({
        event: "mcp.subscribe.failed",
        server_id: opts.serverId,
        uri_sha8: shortHash(uri),
        err: (e as Error).message,
      });
    }
  }
  if (truncated) {
    logger.info({
      event: "mcp.subscribe.truncated",
      server_id: opts.serverId,
      cap: AUTO_SUBSCRIBE_CAP,
      total: opts.resources.size,
    });
  }
  return { subscribed, truncated };
}

// --- internal refreshers ---------------------------------------------------

async function refreshTools(opts: RefreshInstallOptions): Promise<void> {
  const before = opts.tools.size;
  const started = Date.now();
  const resp = await opts.rpc<{ tools?: readonly McpTool[] }>("tools/list");
  const next = new Map<string, McpTool>();
  for (const t of resp.tools ?? []) {
    if (typeof t.name === "string" && t.inputSchema?.type === "object") {
      next.set(t.name, t);
    }
  }
  swapMap(opts.tools, next);
  logger.info({
    event: "mcp.catalog.refreshed",
    server_id: opts.serverId,
    category: "tools",
    before_count: before,
    after_count: opts.tools.size,
    duration_ms: Date.now() - started,
  });
}

async function refreshResources(opts: RefreshInstallOptions): Promise<void> {
  const before = opts.resources.size;
  const started = Date.now();
  const resp = await opts.rpc<{ resources?: readonly McpResource[] }>("resources/list");
  const next = new Map<string, McpResource>();
  for (const r of resp.resources ?? []) {
    if (typeof r.uri === "string") next.set(r.uri, r);
  }
  swapMap(opts.resources, next);
  logger.info({
    event: "mcp.catalog.refreshed",
    server_id: opts.serverId,
    category: "resources",
    before_count: before,
    after_count: opts.resources.size,
    duration_ms: Date.now() - started,
  });
}

async function refreshPrompts(opts: RefreshInstallOptions): Promise<void> {
  const before = opts.prompts.size;
  const started = Date.now();
  const resp = await opts.rpc<{ prompts?: readonly McpPrompt[] }>("prompts/list");
  const next = new Map<string, McpPrompt>();
  for (const p of resp.prompts ?? []) {
    if (typeof p.name === "string") next.set(p.name, p);
  }
  swapMap(opts.prompts, next);
  logger.info({
    event: "mcp.catalog.refreshed",
    server_id: opts.serverId,
    category: "prompts",
    before_count: before,
    after_count: opts.prompts.size,
    duration_ms: Date.now() - started,
  });
}

/**
 * Clear `target` and copy entries from `next` in-place. Atomic in the
 * single-threaded event loop: no reader on the same tick observes a
 * partial catalog. Retains Map identity so consumers holding a reference
 * to `state.tools` see the new contents on their next read.
 */
function swapMap<K, V>(target: Map<K, V>, next: Map<K, V>): void {
  target.clear();
  for (const [k, v] of next) target.set(k, v);
}

function logRefreshError(serverId: string, category: string, e: unknown): void {
  if (e instanceof A2EError && /error\s+-?32601/i.test(e.message)) {
    // Method not found — server dropped the capability. Stay silent at
    // info level; old map stays in place.
    logger.info({
      event: "mcp.catalog.refresh_unsupported",
      server_id: serverId,
      category,
    });
    return;
  }
  logger.warn({
    event: "mcp.catalog.refresh_failed",
    server_id: serverId,
    category,
    err: (e as Error).message,
  });
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
