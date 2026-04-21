/**
 * Catalog-event dispatcher (RFC 004, v1.4).
 *
 * Shared logic between the HTTP and stdio MCP clients for handling
 * server-initiated notifications that affect the cached catalog:
 *
 *   - notifications/tools/list_changed
 *   - notifications/resources/list_changed
 *   - notifications/prompts/list_changed
 *   - notifications/resources/updated      (only for subscribed URIs)
 *
 * The dispatcher is purely reactive: it doesn't own the catalog or the
 * subscribe set — it fans events out to listeners and coalesces bursty
 * list_changed notifications. Each transport wires their own refresher
 * into `onCatalogEvent` to trigger an atomic tools/resources/prompts
 * re-fetch.
 *
 * Debouncing:
 *   Multiple list_changed for the same category within DEBOUNCE_MS coalesce
 *   into a single event. This bounds refresh load when a server adds tools
 *   in a loop.
 *
 * Thread model:
 *   JavaScript single-threaded event loop. `dispatch` and `onCatalogEvent`
 *   are synchronous; callbacks run inline. No locking.
 */

import { logger } from "../logging/logger.js";
import { mcpNotifications } from "../metrics/metrics.js";

const DEBOUNCE_MS = 500;

export type CatalogEvent =
  | { readonly kind: "tools/list_changed" }
  | { readonly kind: "resources/list_changed" }
  | { readonly kind: "prompts/list_changed" }
  | { readonly kind: "resources/updated"; readonly uri: string };

export type CatalogEventListener = (event: CatalogEvent) => void;

export interface CatalogDispatcher {
  /** Process a raw JSON-RPC notification. Returns true iff it was a catalog event. */
  dispatch(method: string, params: unknown): boolean;
  /** Register a listener. Returns an unsubscribe fn. */
  onCatalogEvent(listener: CatalogEventListener): () => void;
  /** Stop all debouncers; clear listeners. Called on client close(). */
  shutdown(): void;
}

/**
 * Build a dispatcher for one MCP server.
 *
 * `serverId` is used only for logging correlation.
 * `subscribedUris` is a LIVE reference from the client — the dispatcher reads
 * it at dispatch time to decide whether a `resources/updated` payload should
 * fire or be dropped.
 */
export function buildCatalogDispatcher(
  serverId: string,
  subscribedUris: ReadonlySet<string>,
): CatalogDispatcher {
  const listeners = new Set<CatalogEventListener>();
  const pendingTimers = new Map<CatalogEvent["kind"], NodeJS.Timeout>();
  let closed = false;

  function emit(event: CatalogEvent): void {
    if (closed) return;
    for (const l of listeners) {
      try {
        l(event);
      } catch (e) {
        logger.warn({
          event: "mcp.catalog.listener_error",
          server_id: serverId,
          kind: event.kind,
          err: (e as Error).message,
        });
      }
    }
  }

  function scheduleDebounced(kind: CatalogEvent["kind"]): void {
    const existing = pendingTimers.get(kind);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      pendingTimers.delete(kind);
      // For list_changed kinds we always emit a bare event; the updated
      // variant comes through dispatchOnce below.
      emit({ kind } as CatalogEvent);
    }, DEBOUNCE_MS);
    t.unref?.();
    pendingTimers.set(kind, t);
  }

  return {
    dispatch(method, params): boolean {
      if (closed) return false;
      switch (method) {
        case "notifications/tools/list_changed":
          mcpNotifications.inc({ server_id: serverId, event: "tools_list_changed" });
          scheduleDebounced("tools/list_changed");
          return true;
        case "notifications/resources/list_changed":
          mcpNotifications.inc({ server_id: serverId, event: "resources_list_changed" });
          scheduleDebounced("resources/list_changed");
          return true;
        case "notifications/prompts/list_changed":
          mcpNotifications.inc({ server_id: serverId, event: "prompts_list_changed" });
          scheduleDebounced("prompts/list_changed");
          return true;
        case "notifications/resources/updated": {
          mcpNotifications.inc({ server_id: serverId, event: "resources_updated" });
          const uri = (params as { uri?: unknown } | null)?.uri;
          if (typeof uri !== "string") {
            logger.debug({
              event: "mcp.catalog.bogus_updated",
              server_id: serverId,
              reason: "missing-uri",
            });
            return true;
          }
          if (!subscribedUris.has(uri)) {
            logger.debug({
              event: "mcp.catalog.updated_unsubscribed",
              server_id: serverId,
              uri_sha8: shortHash(uri),
            });
            return true;
          }
          emit({ kind: "resources/updated", uri });
          return true;
        }
        default:
          return false;
      }
    },

    onCatalogEvent(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    shutdown(): void {
      closed = true;
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
      listeners.clear();
    },
  };
}

/**
 * 8-char hex digest of the input (FNV-1a 32-bit). Not cryptographic; used
 * purely to shorten log identifiers when we don't want the raw URI in logs.
 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
