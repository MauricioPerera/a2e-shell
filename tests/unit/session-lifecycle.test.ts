import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSession } from "../../src/session/state.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import type { ResolvedPolicy } from "../../src/capabilities/policy.js";

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    mode: "unrestricted",
    binaries_allowlist: [],
    binary_paths: {},
    path_env: "",
    http_domains_allowlist: [],
    max_exec_timeout_ms: 30_000,
    max_response_bytes: 262_144,
    max_session_ttl_s: 3_600,
    preview_bytes: 2_048,
    stderr_preview_bytes: 2_048,
    max_bindings: 128,
    max_binding_bytes: 10_485_760,
    max_total_binding_bytes: 52_428_800,
    max_transcript_bytes: 1024,
    ...overrides,
  };
}

describe("Session transcript rotation", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx-rot-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotates when next append crosses 80% of the cap", async () => {
    // Cap sized so each entry (~160B) fits but rotation fires after a few.
    const session = createSession({
      session_id: "test-1",
      policy: makePolicy({ max_transcript_bytes: 1000 }),
      initial_cwd: dir,
      initial_env_overlay: {},
      redactor: buildRedactor([], {}),
      expires_at: new Date(Date.now() + 3_600_000),
      transcript_path: path.join(dir, "transcript.jsonl"),
      catalog: null,
    });

    for (let i = 0; i < 15; i++) {
      await session.appendTranscript({
        t: session.nextTurn(),
        at: new Date(Date.UTC(2026, 3, 19, 0, 0, i)).toISOString(),
        req: { command: `echo turn-${i}` },
        res: { status_line: "[exit 0]", shape: null, preview: null, binding: null, stderr: null, truncated: false },
      });
    }

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("transcript"));
    const rotated = files.filter((f) => f !== "transcript.jsonl");
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain("transcript.jsonl");
  });

  it("readFullTranscript yields ALL entries across rotations in order", async () => {
    const session = createSession({
      session_id: "test-2",
      policy: makePolicy({ max_transcript_bytes: 800 }),
      initial_cwd: dir,
      initial_env_overlay: {},
      redactor: buildRedactor([], {}),
      expires_at: new Date(Date.now() + 3_600_000),
      transcript_path: path.join(dir, "transcript.jsonl"),
      catalog: null,
    });

    const total = 15;
    for (let i = 0; i < total; i++) {
      await session.appendTranscript({
        t: session.nextTurn(),
        at: new Date(Date.UTC(2026, 3, 19, 0, 0, i)).toISOString(),
        req: { command: `echo ${i}` },
        res: { status_line: "[exit 0]", shape: null, preview: null, binding: null, stderr: null, truncated: false },
      });
      // Stagger rotation timestamps so lexicographic sort matches chronology.
      await new Promise((r) => setTimeout(r, 2));
    }

    const seen: number[] = [];
    for await (const entry of session.readFullTranscript()) {
      seen.push(entry.t);
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it("session.transcript is a getter that reflects the current segment", async () => {
    const session = createSession({
      session_id: "test-3",
      policy: makePolicy({ max_transcript_bytes: 800 }),
      initial_cwd: dir,
      initial_env_overlay: {},
      redactor: buildRedactor([], {}),
      expires_at: new Date(Date.now() + 3_600_000),
      transcript_path: path.join(dir, "transcript.jsonl"),
      catalog: null,
    });

    const firstRef = session.transcript;

    for (let i = 0; i < 10; i++) {
      await session.appendTranscript({
        t: session.nextTurn(),
        at: new Date(Date.UTC(2026, 3, 19, 0, 0, i)).toISOString(),
        req: { command: `echo ${i}` },
        res: { status_line: "[exit 0]", shape: null, preview: null, binding: null, stderr: null, truncated: false },
      });
    }

    const secondRef = session.transcript;
    // Rotation replaces the underlying Transcript instance.
    expect(secondRef).not.toBe(firstRef);
  });
});
