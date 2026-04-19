import * as crypto from "node:crypto";
import type { Hono } from "hono";
import { A2EError } from "../../errors.js";
import type { SessionManager } from "../../session/manager.js";
import type { AppEnv } from "../server.js";

/**
 * v1 scope: replay is a READ-ONLY confirmation that the transcript is structurally
 * intact — it does NOT re-execute commands (side effects on external APIs are
 * non-deterministic). Returns a deterministic hash of the transcript's responses
 * so callers can compare two sessions that claim equivalence.
 *
 * Hash covers ALL segments (rotated + current) so rotation is transparent.
 */
export function mountReplay(app: Hono<AppEnv>, manager: SessionManager): void {
  app.post("/sessions/:id/replay", async (c) => {
    const session = manager.get(c.req.param("id"));
    const h = crypto.createHash("sha256");
    let count = 0;
    for await (const entry of session.readFullTranscript()) {
      h.update(JSON.stringify(entry.res));
      count++;
    }
    if (count === 0) {
      throw new A2EError("CONFLICT", "transcript is empty; nothing to replay", 409);
    }
    return c.json(
      {
        replayed: count,
        diverged_at: null,
        final_state_hash: h.digest("hex"),
      },
      200,
    );
  });
}
