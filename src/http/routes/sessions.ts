import type { Hono } from "hono";
import { A2EError } from "../../errors.js";
import { CreateSessionRequest, type CreateSessionResponse } from "../../io/protocol.js";
import type { SessionManager } from "../../session/manager.js";
import type { AppEnv } from "../server.js";

export function mountSessions(app: Hono<AppEnv>, manager: SessionManager): void {
  app.post("/sessions", async (c) => {
    const raw = await readJsonBody(c);
    const parsed = CreateSessionRequest.safeParse(raw);
    if (!parsed.success) {
      throw new A2EError("PARSE_ERROR", parsed.error.message, 400);
    }
    const session = await manager.create(parsed.data);
    const body: CreateSessionResponse = {
      session_id: session.id,
      mode: session.policy.mode,
      cwd: session.getCwd(),
      expires_at: session.expiresAt.toISOString(),
      catalog: session.catalog,
    };
    return c.json(body, 201);
  });

  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await manager.delete(id);
    if (!ok) throw new A2EError("NOT_FOUND", `session '${id}' not found`, 404);
    return c.body(null, 204);
  });

  // Experimental. Reconstructs an in-memory session from disk state.json.
  // Returns the same shape as POST /sessions so clients can treat either
  // endpoint identically after the fact.
  app.post("/sessions/:id/resume", async (c) => {
    const id = c.req.param("id");
    const session = await manager.resume(id);
    const body: CreateSessionResponse = {
      session_id: session.id,
      mode: session.policy.mode,
      cwd: session.getCwd(),
      expires_at: session.expiresAt.toISOString(),
      catalog: session.catalog,
    };
    return c.json(body, 200);
  });
}

async function readJsonBody(c: import("hono").Context): Promise<unknown> {
  const txt = await c.req.text();
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new A2EError(
      "PARSE_ERROR",
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      400,
    );
  }
}
