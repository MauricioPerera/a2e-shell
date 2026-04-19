import type { Hono } from "hono";
import { A2EError } from "../../errors.js";
import { ExecRequest, type ExecResponse } from "../../io/protocol.js";
import { executeTurn } from "../../exec/pipeline.js";
import type { SessionManager } from "../../session/manager.js";
import type { Session } from "../../session/state.js";
import type { AppEnv } from "../server.js";

export function mountExec(app: Hono<AppEnv>, manager: SessionManager): void {
  app.post("/sessions/:id/exec", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req.text();
    if (!raw) throw new A2EError("PARSE_ERROR", "empty body", 400);
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new A2EError(
        "PARSE_ERROR",
        `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        400,
      );
    }
    const parsed = ExecRequest.safeParse(obj);
    if (!parsed.success) {
      throw new A2EError("PARSE_ERROR", parsed.error.message, 400);
    }
    const session = manager.get(id); // may throw NOT_FOUND / CONFLICT
    const req = parsed.data;

    // Idempotency flow. Three outcomes:
    //   1. Cache hit (previous call completed within TTL) → return cached + hit flag.
    //   2. In-flight hit (concurrent call registered) → await its promise + hit flag.
    //   3. Cold path → register our exec as in-flight BEFORE awaiting, then cache
    //      the result. The get+inflight+register sequence is sync (no awaits) so
    //      no interleaving can sneak a second exec through for the same key.
    const key = req.idempotency_key;
    if (key) {
      const cached = session.idempotencyGet(key);
      if (cached) {
        return await respondHit(c, session, req, cached);
      }
      const inflight = session.idempotencyInflight(key);
      if (inflight) {
        const res = await inflight;
        return await respondHit(c, session, req, res);
      }
    }

    const execPromise = executeTurn(session, req);
    if (key) session.idempotencyRegister(key, execPromise);
    const res = await execPromise;
    if (key) session.idempotencyPut(key, res);

    await session.appendTranscript({
      t: session.nextTurn(),
      at: new Date().toISOString(),
      req: pickTranscriptableReq(req),
      res,
    });
    return c.json(res, 200);
  });
}

async function respondHit(
  c: import("hono").Context<AppEnv>,
  session: Session,
  req: import("../../io/protocol.js").ExecRequest,
  cached: ExecResponse,
) {
  const hit: ExecResponse = { ...cached, idempotent_hit: true };
  await session.appendTranscript({
    t: session.nextTurn(),
    at: new Date().toISOString(),
    req: pickTranscriptableReq(req),
    res: hit,
  });
  return c.json(hit, 200);
}

/**
 * Strip non-transcriptable fields (idempotency_key) from the request before
 * recording. The remaining content still passes through the session redactor
 * inside session.appendTranscript.
 */
function pickTranscriptableReq(req: import("../../io/protocol.js").ExecRequest) {
  return {
    command: req.command,
    ...(req.bind_as ? { bind_as: req.bind_as } : {}),
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    ...(req.timeout_ms !== undefined ? { timeout_ms: req.timeout_ms } : {}),
  };
}
