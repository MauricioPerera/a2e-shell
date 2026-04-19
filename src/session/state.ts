/**
 * Session state — in-memory, transcript-backed for durability.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import type { Binding } from "../exec/interpolate.js";
import type { Redactor } from "../credentials/redactor.js";
import type { CatalogInfo, ExecResponse } from "../io/protocol.js";
import { A2EError } from "../errors.js";
import { isReservedEnvKey } from "./validation.js";
import { logger } from "../logging/logger.js";
import { transcriptRotations } from "../metrics/metrics.js";
import { openTranscript, type Transcript, type TranscriptEntry } from "./transcript.js";

export interface SessionInit {
  readonly session_id: string;
  readonly policy: ResolvedPolicy;
  readonly initial_cwd: string;
  readonly initial_env_overlay: Readonly<Record<string, string>>;
  readonly redactor: Redactor;
  readonly expires_at: Date;
  readonly transcript_path: string;
  readonly catalog: CatalogInfo | null;
}

export interface SessionSnapshot {
  readonly session_id: string;
  readonly cwd: string;
  readonly env_overlay_keys: readonly string[];
  readonly bindings: Readonly<Record<string, { shape: string; size_bytes: number }>>;
  readonly history_size: number;
  readonly expires_at: string;
}

export interface Session {
  readonly id: string;
  readonly policy: ResolvedPolicy;
  readonly redactor: Redactor;
  readonly expiresAt: Date;
  /**
   * The CURRENT transcript segment. After rotation this points to the
   * newly-opened file; consumers that need full history must use
   * `readFullTranscript()`.
   */
  readonly transcript: Transcript;
  readonly catalog: CatalogInfo | null;

  getCwd(): string;
  setCwd(abs: string): void;

  getEnvOverlay(): Readonly<Record<string, string>>;
  setEnv(key: string, value: string): void;
  unsetEnv(keys: readonly string[]): void;

  getBindings(): ReadonlyMap<string, Binding>;
  /** Throws SIZE_LIMIT when binding count or size caps are exceeded. */
  bind(name: string, binding: Binding): void;

  appendTranscript(entry: TranscriptEntry): Promise<void>;
  /**
   * Iterate every transcript entry chronologically: rotated segments (by
   * timestamp-sorted filename) first, then the current segment. Use this
   * for `GET /sessions/:id/transcript` so rotation is transparent to clients.
   */
  readFullTranscript(): AsyncIterable<TranscriptEntry>;
  nextTurn(): number;
  snapshot(): SessionSnapshot;

  /** Returns a cached ExecResponse if the key was seen within TTL, else null. */
  idempotencyGet(key: string): ExecResponse | null;
  /** Stores an ExecResponse under the key. TTL-bounded, FIFO-evicting at cap. */
  idempotencyPut(key: string, response: ExecResponse): void;
  /** Returns an in-flight Promise for the key if one exists, else null. */
  idempotencyInflight(key: string): Promise<ExecResponse> | null;
  /** Registers a Promise as in-flight. Auto-released on settle. */
  idempotencyRegister(key: string, promise: Promise<ExecResponse>): void;
}

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 128;

/**
 * Rotate when the NEXT append would take the transcript past this fraction of
 * its cap. Leaves headroom so the rotating append itself doesn't hit the hard
 * cap and fail.
 */
const TRANSCRIPT_ROTATION_THRESHOLD = 0.8;

export function createSession(init: SessionInit): Session {
  const env: Record<string, string> = { ...init.initial_env_overlay };
  const bindings = new Map<string, Binding>();
  let transcript = openTranscript(init.transcript_path);
  const idempotencyCache = new Map<string, { response: ExecResponse; expires: number }>();
  const idempotencyInflight = new Map<string, Promise<ExecResponse>>();
  let cwd = init.initial_cwd;
  let historySize = 0;
  let turn = 0;
  let transcriptBytes = 0;

  async function rotateTranscript(): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = `${init.transcript_path}.${ts}.jsonl`;
    try {
      await fsp.rename(init.transcript_path, rotatedPath);
    } catch {
      // If the current file doesn't exist yet (rare), skip rename.
    }
    transcript = openTranscript(init.transcript_path);
    transcriptBytes = 0;
    transcriptRotations.inc();
    logger.info({
      event: "transcript.rotated",
      session_id: init.session_id,
      rotated_to: rotatedPath,
    });
  }

  /**
   * Scan the transcript directory for rotated segments matching
   * `<basename>.<iso-ts>.jsonl`. Sort by timestamp (ISO-8601 sorts
   * lexicographically) so older segments yield first.
   */
  async function listRotatedSegments(): Promise<string[]> {
    const dir = path.dirname(init.transcript_path);
    const base = path.basename(init.transcript_path);
    const prefix = `${base}.`;
    const suffix = ".jsonl";
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch { return []; }
    return entries
      .filter((e) => e.startsWith(prefix) && e.endsWith(suffix) && e !== base)
      .sort()
      .map((e) => path.join(dir, e));
  }

  function totalBindingBytes(): number {
    let s = 0;
    for (const b of bindings.values()) s += b.size_bytes;
    return s;
  }

  return {
    id: init.session_id,
    policy: init.policy,
    redactor: init.redactor,
    expiresAt: init.expires_at,
    // Getter so callers always see the CURRENT segment after rotation,
    // not the captured-at-create-time reference.
    get transcript() { return transcript; },
    catalog: init.catalog,

    getCwd: () => cwd,
    setCwd(abs: string) {
      cwd = abs;
    },

    getEnvOverlay: () => ({ ...env }),
    setEnv(k, v) {
      // Hard block on reserved keys. This is the single point of truth: both
      // intercepted `export` and PATCH /env pass through here, so no path can
      // bypass the reserved-key check (e.g. LD_PRELOAD via intercept).
      if (isReservedEnvKey(k)) {
        throw new A2EError(
          "CAPABILITY_DENIED",
          `env: '${k}' is reserved and cannot be set`,
        );
      }
      env[k] = v;
    },
    unsetEnv(keys) {
      for (const k of keys) {
        if (isReservedEnvKey(k)) {
          throw new A2EError(
            "CAPABILITY_DENIED",
            `env: '${k}' is reserved and cannot be unset`,
          );
        }
      }
      for (const k of keys) delete env[k];
    },

    getBindings: () => bindings,
    bind(name, b) {
      if (b.size_bytes > init.policy.max_binding_bytes) {
        throw new A2EError(
          "SIZE_LIMIT",
          `binding '${name}' is ${b.size_bytes}B; cap is ${init.policy.max_binding_bytes}B`,
        );
      }
      const existing = bindings.get(name);
      const futureTotal = totalBindingBytes() - (existing?.size_bytes ?? 0) + b.size_bytes;
      if (futureTotal > init.policy.max_total_binding_bytes) {
        throw new A2EError(
          "SIZE_LIMIT",
          `bindings would total ${futureTotal}B; cap is ${init.policy.max_total_binding_bytes}B`,
        );
      }
      if (!existing && bindings.size >= init.policy.max_bindings) {
        throw new A2EError(
          "SIZE_LIMIT",
          `binding count cap reached (${init.policy.max_bindings})`,
        );
      }
      bindings.set(name, b);
    },

    async appendTranscript(entry) {
      // Redact the serialized entry before persisting. Catches secrets that
      // might appear in request payloads (command/stdin) as well as responses.
      const line = JSON.stringify(entry);
      const bytes = new TextEncoder().encode(line);
      const clean = init.redactor.redact(bytes);
      const cleanLine = new TextDecoder().decode(clean);
      const byteLen = Buffer.byteLength(cleanLine, "utf8") + 1; // +1 for newline
      const softCap = Math.floor(init.policy.max_transcript_bytes * TRANSCRIPT_ROTATION_THRESHOLD);
      // Rotate proactively when 80% full AND there's at least one entry so we
      // don't rotate empty files when a single huge entry lands.
      if (transcriptBytes > 0 && transcriptBytes + byteLen > softCap) {
        await rotateTranscript();
      }
      if (byteLen > init.policy.max_transcript_bytes) {
        throw new A2EError(
          "SIZE_LIMIT",
          `transcript entry is ${byteLen}B, larger than cap ${init.policy.max_transcript_bytes}B`,
        );
      }
      await transcript.appendRaw(cleanLine);
      transcriptBytes += byteLen;
      historySize++;
    },
    readFullTranscript(): AsyncIterable<TranscriptEntry> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const segPath of await listRotatedSegments()) {
            const seg = openTranscript(segPath);
            for await (const entry of seg.read()) yield entry;
          }
          for await (const entry of transcript.read()) yield entry;
        },
      };
    },

    nextTurn() {
      turn++;
      return turn;
    },

    snapshot(): SessionSnapshot {
      const bOut: Record<string, { shape: string; size_bytes: number }> = {};
      for (const [k, v] of bindings) {
        bOut[k] = { shape: v.shape, size_bytes: v.size_bytes };
      }
      return {
        session_id: init.session_id,
        cwd,
        env_overlay_keys: Object.keys(env),
        bindings: bOut,
        history_size: historySize,
        expires_at: init.expires_at.toISOString(),
      };
    },

    idempotencyGet(key) {
      const entry = idempotencyCache.get(key);
      if (!entry) return null;
      if (entry.expires < Date.now()) {
        idempotencyCache.delete(key);
        return null;
      }
      return entry.response;
    },
    idempotencyPut(key, response) {
      if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES && !idempotencyCache.has(key)) {
        const oldest = idempotencyCache.keys().next().value;
        if (oldest !== undefined) idempotencyCache.delete(oldest);
      }
      idempotencyCache.set(key, { response, expires: Date.now() + IDEMPOTENCY_TTL_MS });
    },
    idempotencyInflight(key) {
      return idempotencyInflight.get(key) ?? null;
    },
    idempotencyRegister(key, promise) {
      idempotencyInflight.set(key, promise);
      // Auto-release on settle so memory bounded by concurrent-key-count.
      promise.finally(() => {
        // Only delete if this is still the registered one (paranoid guard in
        // case of reregistration — shouldn't happen under single-threaded loop).
        if (idempotencyInflight.get(key) === promise) {
          idempotencyInflight.delete(key);
        }
      }).catch(() => { /* swallow — real rejection is surfaced by the awaiting caller */ });
    },
  };
}

