import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { A2EError } from "../../errors.js";
import { ExecRequest, type ExecResponse } from "../../io/protocol.js";
import { executeTurn, type ExecSink } from "../../exec/pipeline.js";
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

    // Streaming mode: Accept: text/event-stream. Emits SSE events during the
    // exec (`stdout`, `stderr` chunks, `done` with canonical response). The
    // non-streaming path handles idempotency; streaming skips it because the
    // cached response wouldn't reproduce the original chunk timing.
    const accept = c.req.header("accept") ?? "";
    if (accept.toLowerCase().includes("text/event-stream")) {
      return streamExecSSE(c, session, req);
    }

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
    // When persistence is on, block the response until state.json is durable.
    // Noop otherwise. Without this, a crash between the 200 and the async
    // write would silently drop the turn from POST /resume's view.
    await session.flush();
    return c.json(res, 200);
  });
}

/**
 * SSE-streaming variant of the exec endpoint. Emits:
 *   event: start   data: { session_id, command_bytes, at }
 *   event: stdout  data: { chunk: "<utf-8 text>" }
 *   event: stderr  data: { chunk: "<utf-8 text>" }
 *   event: done    data: <ExecResponse>
 *
 * Chunk events may arrive interleaved; the `done` payload is always the same
 * canonical response the non-streaming route would have returned (fully
 * redacted, aggregated). Clients that need deterministic full output should
 * rely on `done`, not on accumulating chunks.
 */
async function streamExecSSE(
  c: import("hono").Context<AppEnv>,
  session: Session,
  req: import("../../io/protocol.js").ExecRequest,
) {
  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({
        event: "start",
        data: JSON.stringify({
          session_id: session.id,
          command_bytes: req.command.length,
          at: new Date().toISOString(),
        }),
      });

      // Buffer events coming from synchronous chunk handlers; the SSE writer
      // awaits, but chunk handlers can fire faster than we flush. Draining is
      // serialized with `flushing` so events stay in order.
      const queue: Array<{ event: string; data: string }> = [];
      let flushing = false;
      async function drain(): Promise<void> {
        if (flushing) return;
        flushing = true;
        try {
          while (queue.length > 0) {
            const ev = queue.shift()!;
            await stream.writeSSE(ev);
          }
        } finally {
          flushing = false;
        }
      }

      const sink: ExecSink = {
        onStdout: (text) => {
          queue.push({ event: "stdout", data: JSON.stringify({ chunk: text }) });
          void drain();
        },
        onStderr: (text) => {
          queue.push({ event: "stderr", data: JSON.stringify({ chunk: text }) });
          void drain();
        },
      };

      const res = await executeTurn(session, req, sink);
      queue.push({ event: "done", data: JSON.stringify(res) });
      await drain();

      await session.appendTranscript({
        t: session.nextTurn(),
        at: new Date().toISOString(),
        req: pickTranscriptableReq(req),
        res,
      });
      await session.flush();
    } catch (e) {
      const code = e instanceof A2EError ? e.code : "INTERNAL";
      const message = e instanceof Error ? e.message : String(e);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ code, message }),
      });
    }
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
  await session.flush();
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
