/**
 * Persistence for the bounded-verb runtime.
 *
 * Writes a side-file `bounded-state.json` next to the outer session's
 * `state.json`. Zero coupling with the existing PersistedSession schema
 * (which is untouched from v1.1) — this layer is additive and optional.
 *
 * Encoding:
 *   - primitives (string/number/bool/null) → JSON native
 *   - Buffer → { "__buffer__": "<base64>" } (sentinel-tagged)
 *   - arrays / records → recursive, same rules
 *
 * Transcript entries drop their `stmt` (parsed AST) on serialize: the
 * raw `command` source is preserved, and `verbNameOf(null)` falls back
 * to "?" which is acceptable for restored history. Re-parsing every
 * stmt on boot would bloat state.json without proportional value.
 *
 * Atomic write via stage-to-tmp + fsync + rename — same pattern as
 * src/session/persistence.ts::writeState.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  Binding,
  CallCapabilities,
  RuntimeValue,
  Session as BoundedSession,
  TranscriptEntry,
} from "./session.js";
import { createSession } from "./session.js";

export const BOUNDED_STATE_SCHEMA_VERSION = 1;
export const BOUNDED_STATE_FILENAME = "bounded-state.json";

type JsonEncoded =
  | null
  | boolean
  | number
  | string
  | { __buffer__: string }
  | JsonEncoded[]
  | { [k: string]: JsonEncoded };

interface SerializedBinding {
  readonly value: JsonEncoded;
  readonly createdAtMs: number;
  readonly ttlDeadlineMs: number | null;
}

interface SerializedTranscriptEntry {
  readonly t: number;
  readonly command: string;
  readonly status_line: string;
  readonly binding: string | null;
  readonly error: { code: string; message: string } | null;
  readonly duration_ms: number;
}

export interface SerializedBoundedState {
  readonly schema_version: number;
  readonly session_id: string;
  readonly bindings: Record<string, SerializedBinding>;
  readonly last: SerializedBinding | null;
  readonly transcript: SerializedTranscriptEntry[];
  readonly turn_counter: number;
}

// --- encode / decode runtime values ----------------------------------------

function encodeValue(v: RuntimeValue): JsonEncoded {
  if (v === null) return null;
  if (Buffer.isBuffer(v)) return { __buffer__: v.toString("base64") };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(encodeValue);
  const out: Record<string, JsonEncoded> = {};
  for (const [k, val] of Object.entries(v)) out[k] = encodeValue(val);
  return out;
}

function decodeValue(v: JsonEncoded): RuntimeValue {
  if (v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(decodeValue) as RuntimeValue[];
  if (typeof v === "object" && "__buffer__" in v && typeof v.__buffer__ === "string") {
    return Buffer.from(v.__buffer__, "base64");
  }
  const out: Record<string, RuntimeValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonEncoded>)) {
    out[k] = decodeValue(val);
  }
  return out;
}

function encodeBinding(b: Binding): SerializedBinding {
  return {
    value: encodeValue(b.value),
    createdAtMs: b.createdAtMs,
    ttlDeadlineMs: b.ttlDeadlineMs,
  };
}

function decodeBinding(b: SerializedBinding): Binding {
  return {
    value: decodeValue(b.value),
    createdAtMs: b.createdAtMs,
    ttlDeadlineMs: b.ttlDeadlineMs,
  };
}

// --- session-level serialize / deserialize ---------------------------------

export function serializeBoundedSession(rt: BoundedSession): SerializedBoundedState {
  const bindings: Record<string, SerializedBinding> = {};
  for (const [name, binding] of rt.bindings) {
    bindings[name] = encodeBinding(binding);
  }
  return {
    schema_version: BOUNDED_STATE_SCHEMA_VERSION,
    session_id: rt.id,
    bindings,
    last: rt.last ? encodeBinding(rt.last) : null,
    transcript: rt.transcript.map(serializeTranscriptEntry),
    turn_counter: rt.turnCounter,
  };
}

export function deserializeBoundedSession(
  blob: SerializedBoundedState,
  caps: CallCapabilities,
): BoundedSession {
  if (blob.schema_version !== BOUNDED_STATE_SCHEMA_VERSION) {
    throw new Error(
      `bounded state schema mismatch: file=${blob.schema_version} expected=${BOUNDED_STATE_SCHEMA_VERSION}`,
    );
  }
  const rt = createSession(blob.session_id, caps);
  for (const [name, serialized] of Object.entries(blob.bindings)) {
    rt.bindings.set(name, decodeBinding(serialized));
  }
  rt.last = blob.last ? decodeBinding(blob.last) : null;
  rt.turnCounter = blob.turn_counter;
  // Transcript entries have stmt=null post-restore; that's by design
  // (see file header). History meta will show "?" for pre-restore turns.
  for (const e of blob.transcript) {
    rt.transcript.push(deserializeTranscriptEntry(e));
  }
  return rt;
}

function serializeTranscriptEntry(e: TranscriptEntry): SerializedTranscriptEntry {
  return {
    t: e.t,
    command: e.command,
    status_line: e.statusLine,
    binding: e.binding,
    error: e.error,
    duration_ms: e.durationMs,
  };
}

function deserializeTranscriptEntry(e: SerializedTranscriptEntry): TranscriptEntry {
  return {
    t: e.t,
    command: e.command,
    stmt: null,
    statusLine: e.status_line,
    binding: e.binding,
    error: e.error,
    durationMs: e.duration_ms,
  };
}

// --- disk I/O --------------------------------------------------------------

export async function writeBoundedState(
  sessionDir: string,
  rt: BoundedSession,
): Promise<void> {
  const target = path.join(sessionDir, BOUNDED_STATE_FILENAME);
  const tmp = `${target}.tmp`;
  const body = JSON.stringify(serializeBoundedSession(rt));
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

/**
 * Read and deserialize bounded state. Returns null if the file doesn't exist
 * (fresh session). Throws on schema mismatch or unparseable JSON — callers
 * decide whether to abort or proceed with an empty state.
 */
export async function readBoundedState(
  sessionDir: string,
  caps: CallCapabilities,
): Promise<BoundedSession | null> {
  const target = path.join(sessionDir, BOUNDED_STATE_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const blob = JSON.parse(raw) as SerializedBoundedState;
  return deserializeBoundedSession(blob, caps);
}
