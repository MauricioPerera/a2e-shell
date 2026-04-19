/**
 * Experimental session persistence.
 *
 * When `A2E_SESSION_PERSISTENCE=true`, sessions write a compact state.json
 * alongside their transcript on every mutation (cwd / env / binding / turn).
 * `POST /sessions/:id/resume` reads that file and reconstructs the in-memory
 * Session, so an orchestrator restart doesn't lose running agent state.
 *
 * What's persisted:
 *   - cwd, env overlay
 *   - bindings (inline, including full values)
 *   - resolved policy (immutable after create)
 *   - catalog info + original catalog spec (so resume can verify worktree paths
 *     or re-bootstrap if the disk state is gone)
 *   - expires_at, turn counter, transcript byte accumulator
 *
 * What's NOT persisted:
 *   - Idempotency cache (TTL-bounded, short-lived)
 *   - In-flight promises
 *   - Redactor (rebuilt from A2E_REDACT_ENV_KEYS at resume time)
 *
 * Known experimental limits:
 *   - Binding values are inline → state.json can grow large (up to total binding
 *     cap, default 50 MiB). v0.4 will move to per-binding files + lazy load.
 *   - No multi-worker ownership arbitration: if two workers try to resume the
 *     same session concurrently, the second blows away the first. Deploy with
 *     sticky session routing.
 */

import * as fsp from "node:fs/promises";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import type { Binding } from "../exec/interpolate.js";
import type { CatalogInfo, CatalogSpec } from "../io/protocol.js";

export const PERSISTENCE_SCHEMA_VERSION = 1;

export interface PersistedSession {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly cwd: string;
  readonly env_overlay: Record<string, string>;
  readonly bindings: Record<string, Binding>;
  readonly policy: ResolvedPolicy;
  readonly catalog: CatalogInfo | null;
  readonly catalog_spec: CatalogSpec | null;
  readonly expires_at: string;
  readonly turn: number;
  readonly history_size: number;
  readonly transcript_bytes: number;
}

/** Atomic write: stage to `<path>.tmp`, fsync, rename. No partial reads. */
export async function writeState(statePath: string, state: PersistedSession): Promise<void> {
  const tmp = `${statePath}.tmp`;
  const body = JSON.stringify(state);
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, statePath);
}

/** Throws on schema mismatch or malformed JSON. */
export async function readState(statePath: string): Promise<PersistedSession> {
  const raw = await fsp.readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as { schema_version?: number };
  if (parsed.schema_version !== PERSISTENCE_SCHEMA_VERSION) {
    throw new Error(
      `persistence schema mismatch: file=${parsed.schema_version} expected=${PERSISTENCE_SCHEMA_VERSION}`,
    );
  }
  return parsed as PersistedSession;
}
