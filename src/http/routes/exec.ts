import type { Hono } from "hono";
import { A2EError } from "../../errors.js";
import { ExecRequest } from "../../io/protocol.js";
import { executeTurn } from "../../exec/pipeline.js";
import type { SessionManager } from "../../session/manager.js";
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

    // Idempotency check: same key within TTL returns the cached response
    // without re-executing the command. Transcript still records the hit so
    // audit trails stay honest.
    if (req.idempotency_key) {
      const cached = session.idempotencyGet(req.idempotency_key);
      if (cached) {
        const hitResponse = { ...cached, idempotent_hit: true };
        await session.appendTranscript({
          t: session.nextTurn(),
          at: new Date().toISOString(),
          req: redactReq(req),
          res: hitResponse,
        });
        return c.json(hitResponse, 200);
      }
    }

    const res = await executeTurn(session, req);

    if (req.idempotency_key) {
      session.idempotencyPut(req.idempotency_key, res);
    }

    await session.appendTranscript({
      t: session.nextTurn(),
      at: new Date().toISOString(),
      req: redactReq(req),
      res,
    });

    return c.json(res, 200);
  });
}

/** Never echo credentials in the transcript; stdin/command already interpolated by the pipeline. */
function redactReq(req: import("../../io/protocol.js").ExecRequest) {
  return {
    command: req.command,
    ...(req.bind_as ? { bind_as: req.bind_as } : {}),
    ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
    ...(req.timeout_ms !== undefined ? { timeout_ms: req.timeout_ms } : {}),
  };
}
