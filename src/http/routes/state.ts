import type { Hono } from "hono";
import { A2EError } from "../../errors.js";
import { PatchCwdRequest, PatchEnvRequest, type StateResponse } from "../../io/protocol.js";
import { validateCwd, validateEnvMap, validateUnsetList } from "../../session/validation.js";
import type { SessionManager } from "../../session/manager.js";
import type { AppEnv } from "../server.js";

export function mountState(app: Hono<AppEnv>, manager: SessionManager): void {
  app.get("/sessions/:id/state", (c) => {
    const session = manager.get(c.req.param("id"));
    return c.json(buildStateResponse(session), 200);
  });

  app.patch("/sessions/:id/cwd", async (c) => {
    const session = manager.get(c.req.param("id"));
    const raw = await c.req.json().catch(() => {
      throw new A2EError("PARSE_ERROR", "invalid JSON", 400);
    });
    const parsed = PatchCwdRequest.safeParse(raw);
    if (!parsed.success) {
      throw new A2EError("PARSE_ERROR", parsed.error.message, 400);
    }
    const resolved = await validateCwd(parsed.data.cwd, manager.allowedCwdPrefixes());
    session.setCwd(resolved);
    return c.json(buildStateResponse(session), 200);
  });

  app.patch("/sessions/:id/env", async (c) => {
    const session = manager.get(c.req.param("id"));
    const raw = await c.req.json().catch(() => {
      throw new A2EError("PARSE_ERROR", "invalid JSON", 400);
    });
    const parsed = PatchEnvRequest.safeParse(raw);
    if (!parsed.success) {
      throw new A2EError("PARSE_ERROR", parsed.error.message, 400);
    }
    validateEnvMap(parsed.data.set);
    validateUnsetList(parsed.data.unset);
    // session.setEnv / unsetEnv are the authoritative gate (they enforce
    // RESERVED_ENV_KEYS). The schema-level validators above give earlier,
    // more specific errors for UX; the session-level check catches anything
    // that slipped through (e.g. future schema drift).
    if (parsed.data.set) {
      for (const [k, v] of Object.entries(parsed.data.set)) session.setEnv(k, v);
    }
    if (parsed.data.unset) session.unsetEnv(parsed.data.unset);
    return c.json(buildStateResponse(session), 200);
  });

  app.get("/sessions/:id/transcript", async (c) => {
    const session = manager.get(c.req.param("id"));
    // Use readFullTranscript so rotated segments are transparently included.
    const lines: string[] = [];
    for await (const e of session.readFullTranscript()) {
      lines.push(JSON.stringify(e));
    }
    return c.text(lines.join("\n") + (lines.length ? "\n" : ""), 200, {
      "Content-Type": "application/jsonl",
    });
  });
}

function buildStateResponse(session: import("../../session/state.js").Session): StateResponse {
  const snap = session.snapshot();
  return {
    session_id: snap.session_id,
    cwd: snap.cwd,
    env_overlay_keys: [...snap.env_overlay_keys],
    bindings: snap.bindings,
    history_size: snap.history_size,
    expires_at: snap.expires_at,
  };
}
