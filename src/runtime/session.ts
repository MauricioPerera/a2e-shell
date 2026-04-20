/**
 * Per-session state for the bounded-verb shell.
 *
 * Shape:
 *   - bindings:  Map<name, Binding>    explicit variables + save results
 *   - last:      Binding | null        implicit $_ (last non-void result)
 *   - transcript: Entry[]              append-only audit log
 *
 * Binding names are stored WITHOUT the leading `$` (the parser strips it).
 * Reading `$x` resolves to bindings.get("x"); `$_` resolves to `last`.
 *
 * Everything is data-only; behaviour lives in runtime/execute.ts.
 */

import type { Stmt } from "../parser/ast.js";

/** Any JS value produced by a verb. `Buffer` kept distinct for shape="bytes". */
export type RuntimeValue =
  | null
  | boolean
  | number
  | string
  | Buffer
  | RuntimeValue[]
  | { [k: string]: RuntimeValue };

/**
 * Capability surface visible to `call`. The HTTP layer populates this from
 * the resolved policy when creating the session. Defaults are RESTRICTIVE:
 * no binaries, no HTTP domains — every `call` fails with CAPABILITY_DENIED
 * unless the session was created with explicit allowlists.
 *
 * This is NOT a general session-policy container — it is only the narrow
 * slice needed by call.ts. Other policy concerns (binding limits, response
 * caps for the outer HTTP layer) live in capabilities/policy.ts.
 */
export interface CallCapabilities {
  readonly binariesAllowlist: readonly string[];
  /** "*" in the list acts as wildcard for any domain. */
  readonly httpDomainsAllowlist: readonly string[];
  readonly maxExecTimeoutMs: number;
  readonly maxResponseBytes: number;
  /** Absolute paths of resolved binaries, keyed by bare name. */
  readonly binaryPaths: Readonly<Record<string, string>>;
  /** PATH string used when spawning (already filtered by allowlist). */
  readonly pathEnv: string;
}

export const RESTRICTIVE_CAPS: CallCapabilities = {
  binariesAllowlist: [],
  httpDomainsAllowlist: [],
  maxExecTimeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
  binaryPaths: {},
  pathEnv: "",
};

export interface Binding {
  readonly value: RuntimeValue;
  /** Monotonic time when this binding was created. Used by save ttl. */
  readonly createdAtMs: number;
  /** Absolute deadline; null = never expires. */
  readonly ttlDeadlineMs: number | null;
}

export interface TranscriptEntry {
  readonly t: number;
  readonly command: string;
  readonly stmt: Stmt | null; // null if parse failed
  readonly statusLine: string;
  readonly binding: string | null;
  readonly error: { code: string; message: string } | null;
  readonly durationMs: number;
}

export interface Session {
  readonly id: string;
  readonly caps: CallCapabilities;
  bindings: Map<string, Binding>;
  last: Binding | null;
  transcript: TranscriptEntry[];
  /** Monotonic turn counter; incremented on every exec. */
  turnCounter: number;
}

// --- constructors & accessors ----------------------------------------------

export function createSession(id: string, caps: CallCapabilities = RESTRICTIVE_CAPS): Session {
  return {
    id,
    caps,
    bindings: new Map(),
    last: null,
    transcript: [],
    turnCounter: 0,
  };
}

export function makeBinding(value: RuntimeValue, ttlMs: number | null = null): Binding {
  const now = Date.now();
  return {
    value,
    createdAtMs: now,
    ttlDeadlineMs: ttlMs === null ? null : now + ttlMs,
  };
}

/**
 * Look up a variable by name (without leading `$`). The special name "_"
 * resolves to the implicit last-result binding. Expired TTL bindings are
 * purged lazily on access.
 */
export function lookup(session: Session, name: string): Binding | null {
  if (name === "_") return session.last;
  const b = session.bindings.get(name);
  if (!b) return null;
  if (b.ttlDeadlineMs !== null && Date.now() >= b.ttlDeadlineMs) {
    session.bindings.delete(name);
    return null;
  }
  return b;
}

/**
 * Bind a variable. Rejects "_" (that slot is only writable via updateLast()).
 */
export function bind(session: Session, name: string, binding: Binding): void {
  if (name === "_") {
    throw new Error("cannot bind '$_' directly; use updateLast()");
  }
  session.bindings.set(name, binding);
}

export function updateLast(session: Session, binding: Binding | null): void {
  session.last = binding;
}

/**
 * Remove all entries whose ttl has passed. Called before `env` meta so the
 * surface the LLM sees doesn't include zombie bindings.
 */
export function sweepExpired(session: Session): void {
  const now = Date.now();
  for (const [name, b] of session.bindings) {
    if (b.ttlDeadlineMs !== null && now >= b.ttlDeadlineMs) {
      session.bindings.delete(name);
    }
  }
}

export function recordTurn(
  session: Session,
  entry: Omit<TranscriptEntry, "t">,
): TranscriptEntry {
  session.turnCounter += 1;
  const full: TranscriptEntry = { t: session.turnCounter, ...entry };
  session.transcript.push(full);
  return full;
}
