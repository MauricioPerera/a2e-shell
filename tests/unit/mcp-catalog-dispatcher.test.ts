/**
 * Unit tests for the catalog-event dispatcher (RFC 004, v1.4).
 *
 * Pure logic: no network, no subprocess. Exercises:
 *   - method-to-event routing for the four catalog notification types
 *   - debouncing: two list_changed within DEBOUNCE_MS coalesce to one
 *   - resources/updated drops unsubscribed URIs silently
 *   - onCatalogEvent unsubscribe handle works
 *   - shutdown() cancels pending debounce timers and clears listeners
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCatalogDispatcher } from "../../src/mcp/catalog-dispatcher.js";

describe("catalog-dispatcher — routing", () => {
  it("routes tools/list_changed after debounce window", async () => {
    vi.useFakeTimers();
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    expect(d.dispatch("notifications/tools/list_changed", null)).toBe(true);
    expect(seen).toEqual([]); // debounced, not yet fired
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([{ kind: "tools/list_changed" }]);

    d.shutdown();
    vi.useRealTimers();
  });

  it("routes resources/list_changed and prompts/list_changed independently", async () => {
    vi.useFakeTimers();
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/resources/list_changed", null);
    d.dispatch("notifications/prompts/list_changed", null);
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).toContainEqual({ kind: "resources/list_changed" });
    expect(seen).toContainEqual({ kind: "prompts/list_changed" });

    d.shutdown();
    vi.useRealTimers();
  });

  it("returns false for non-catalog notifications", () => {
    const d = buildCatalogDispatcher("s1", new Set());
    expect(d.dispatch("notifications/progress", { progress: 0.5 })).toBe(false);
    expect(d.dispatch("notifications/message", { text: "x" })).toBe(false);
    expect(d.dispatch("tools/call", {})).toBe(false);
    d.shutdown();
  });
});

describe("catalog-dispatcher — debouncing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces two list_changed for the same kind within the debounce window", async () => {
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/tools/list_changed", null);
    await vi.advanceTimersByTimeAsync(200);
    d.dispatch("notifications/tools/list_changed", null); // resets timer
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(1);

    d.shutdown();
  });

  it("fires twice when the two events are outside the debounce window", async () => {
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/tools/list_changed", null);
    await vi.advanceTimersByTimeAsync(500);
    d.dispatch("notifications/tools/list_changed", null);
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).toHaveLength(2);

    d.shutdown();
  });

  it("debounces each category independently", async () => {
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    // Two different kinds in the same window -> both fire after window.
    d.dispatch("notifications/tools/list_changed", null);
    d.dispatch("notifications/resources/list_changed", null);
    await vi.advanceTimersByTimeAsync(500);

    expect(seen).toHaveLength(2);
    const kinds = seen.map((e) => (e as { kind: string }).kind).sort();
    expect(kinds).toEqual(["resources/list_changed", "tools/list_changed"]);

    d.shutdown();
  });
});

describe("catalog-dispatcher — resources/updated gating", () => {
  it("emits for subscribed URIs only", () => {
    const subs = new Set<string>(["file:///watched"]);
    const d = buildCatalogDispatcher("s1", subs);
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/resources/updated", { uri: "file:///watched" });
    d.dispatch("notifications/resources/updated", { uri: "file:///other" });

    expect(seen).toEqual([
      { kind: "resources/updated", uri: "file:///watched" },
    ]);

    d.shutdown();
  });

  it("ignores missing uri field without throwing", () => {
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    expect(() => d.dispatch("notifications/resources/updated", {})).not.toThrow();
    expect(() => d.dispatch("notifications/resources/updated", null)).not.toThrow();
    expect(seen).toEqual([]);

    d.shutdown();
  });

  it("reads subscribedUris live (mutations visible to later dispatches)", () => {
    const subs = new Set<string>();
    const d = buildCatalogDispatcher("s1", subs);
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/resources/updated", { uri: "a://x" });
    expect(seen).toEqual([]);

    subs.add("a://x");
    d.dispatch("notifications/resources/updated", { uri: "a://x" });
    expect(seen).toEqual([{ kind: "resources/updated", uri: "a://x" }]);

    d.shutdown();
  });
});

describe("catalog-dispatcher — listener lifecycle", () => {
  it("returned unsubscribe fn removes the listener", async () => {
    vi.useFakeTimers();
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    const off = d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/tools/list_changed", null);
    off();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([]);

    d.shutdown();
    vi.useRealTimers();
  });

  it("shutdown() silences pending debounced fires and new dispatches", async () => {
    vi.useFakeTimers();
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/tools/list_changed", null);
    d.shutdown();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([]);

    // After shutdown, dispatch returns false (nothing claimed).
    expect(d.dispatch("notifications/tools/list_changed", null)).toBe(false);

    vi.useRealTimers();
  });

  it("listener exception doesn't prevent other listeners from firing", async () => {
    vi.useFakeTimers();
    const d = buildCatalogDispatcher("s1", new Set());
    const seen: unknown[] = [];
    d.onCatalogEvent(() => { throw new Error("boom"); });
    d.onCatalogEvent((e) => seen.push(e));

    d.dispatch("notifications/tools/list_changed", null);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toHaveLength(1);

    d.shutdown();
    vi.useRealTimers();
  });
});
