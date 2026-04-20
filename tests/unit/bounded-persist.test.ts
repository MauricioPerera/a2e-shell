/**
 * Unit tests for src/runtime/persist.ts — serialize/deserialize round-trip.
 *
 * Integration coverage (actual disk I/O during resume) lives in
 * tests/integration/http.test.ts; this file pins the encoding rules for
 * Buffer / nested structures / TTL semantics without spinning up a server.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BOUNDED_STATE_FILENAME,
  deserializeBoundedSession,
  readBoundedState,
  serializeBoundedSession,
  writeBoundedState,
} from "../../src/runtime/persist.js";
import {
  RESTRICTIVE_CAPS,
  createSession,
  makeBinding,
  recordTurn,
  updateLast,
  type Binding,
  type RuntimeValue,
  type Session,
} from "../../src/runtime/session.js";

function seed(): Session {
  const s = createSession("sess-abc", RESTRICTIVE_CAPS);
  s.bindings.set("n", makeBinding(42));
  s.bindings.set("s", makeBinding("hello"));
  s.bindings.set("obj", makeBinding({ a: 1, b: [true, null, "x"] }));
  s.bindings.set("buf", makeBinding(Buffer.from("hi there", "utf8")));
  updateLast(s, makeBinding("last-value"));
  recordTurn(s, {
    command: "save 42 as n",
    stmt: null,
    statusLine: "OK | save → scalar[2B] in 1ms",
    binding: "n",
    error: null,
    durationMs: 1,
  });
  recordTurn(s, {
    command: "show $missing",
    stmt: null,
    statusLine: "ERR | SCOPE_MISS",
    binding: null,
    error: { code: "SCOPE_MISS", message: "variable '$missing' not bound" },
    durationMs: 0,
  });
  return s;
}

describe("bounded persist — serialize/deserialize", () => {
  it("round-trips primitive bindings", () => {
    const s = seed();
    const blob = serializeBoundedSession(s);
    const restored = deserializeBoundedSession(blob, RESTRICTIVE_CAPS);
    expect(restored.bindings.get("n")?.value).toBe(42);
    expect(restored.bindings.get("s")?.value).toBe("hello");
  });

  it("round-trips nested objects + arrays with mixed types", () => {
    const s = seed();
    const blob = serializeBoundedSession(s);
    const restored = deserializeBoundedSession(blob, RESTRICTIVE_CAPS);
    const obj = restored.bindings.get("obj")?.value as Record<string, RuntimeValue>;
    expect(obj).toEqual({ a: 1, b: [true, null, "x"] });
  });

  it("encodes Buffer as { __buffer__: base64 } and restores to Buffer", () => {
    const s = seed();
    const blob = serializeBoundedSession(s);
    // JSON-shape sanity: the encoded value for `buf` must have the sentinel.
    expect(blob.bindings.buf?.value).toEqual({
      __buffer__: Buffer.from("hi there", "utf8").toString("base64"),
    });
    const restored = deserializeBoundedSession(blob, RESTRICTIVE_CAPS);
    const buf = restored.bindings.get("buf")?.value;
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect((buf as Buffer).toString("utf8")).toBe("hi there");
  });

  it("preserves the last-result binding ($_)", () => {
    const s = seed();
    const blob = serializeBoundedSession(s);
    const restored = deserializeBoundedSession(blob, RESTRICTIVE_CAPS);
    expect(restored.last?.value).toBe("last-value");
  });

  it("preserves transcript (sans stmt) and turn counter", () => {
    const s = seed();
    const blob = serializeBoundedSession(s);
    const restored = deserializeBoundedSession(blob, RESTRICTIVE_CAPS);
    expect(restored.turnCounter).toBe(2);
    expect(restored.transcript).toHaveLength(2);
    expect(restored.transcript[0]!.command).toBe("save 42 as n");
    expect(restored.transcript[0]!.stmt).toBeNull();
    expect(restored.transcript[1]!.error?.code).toBe("SCOPE_MISS");
  });

  it("preserves TTL fields literally (wall-clock deadlines)", () => {
    const s = createSession("ttl", RESTRICTIVE_CAPS);
    const deadline = Date.now() + 60_000;
    const b: Binding = { value: "keep", createdAtMs: deadline - 60_000, ttlDeadlineMs: deadline };
    s.bindings.set("k", b);
    const restored = deserializeBoundedSession(serializeBoundedSession(s), RESTRICTIVE_CAPS);
    const r = restored.bindings.get("k");
    expect(r?.ttlDeadlineMs).toBe(deadline);
    expect(r?.createdAtMs).toBe(b.createdAtMs);
  });

  it("throws on schema-version mismatch", () => {
    const s = seed();
    const blob = { ...serializeBoundedSession(s), schema_version: 99 };
    expect(() => deserializeBoundedSession(blob, RESTRICTIVE_CAPS)).toThrow(
      /schema mismatch/,
    );
  });
});

describe("bounded persist — disk I/O", () => {
  it("write + read round-trip via disk", async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "bounded-persist-"));
    try {
      const original = seed();
      await writeBoundedState(dir, original);
      const filePath = path.join(dir, BOUNDED_STATE_FILENAME);
      expect(fsSync.existsSync(filePath)).toBe(true);

      const restored = await readBoundedState(dir, RESTRICTIVE_CAPS);
      expect(restored).not.toBeNull();
      expect(restored!.bindings.size).toBe(original.bindings.size);
      expect(restored!.bindings.get("n")?.value).toBe(42);
      expect((restored!.bindings.get("buf")?.value as Buffer).toString("utf8"))
        .toBe("hi there");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readBoundedState returns null when file does not exist", async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "bounded-persist-empty-"));
    try {
      const restored = await readBoundedState(dir, RESTRICTIVE_CAPS);
      expect(restored).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readBoundedState throws on malformed JSON", async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "bounded-persist-bad-"));
    try {
      await fs.writeFile(path.join(dir, BOUNDED_STATE_FILENAME), "{not json", "utf8");
      await expect(readBoundedState(dir, RESTRICTIVE_CAPS)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
