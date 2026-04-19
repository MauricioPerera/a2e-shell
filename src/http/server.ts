import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import * as crypto from "node:crypto";
import { A2EError, httpStatusForCode, type ErrorCode } from "../errors.js";
import { buildRedactor, type Redactor } from "../credentials/redactor.js";
import type { SessionManager } from "../session/manager.js";
import { mountSessions } from "./routes/sessions.js";
import { mountExec } from "./routes/exec.js";
import { mountState } from "./routes/state.js";
import { mountReplay } from "./routes/replay.js";

export interface ServerConfig {
  readonly authTokens: readonly string[];
  readonly port: number;
  readonly maxRequestBytes: number;
  readonly redactEnvKeys: readonly string[];
  readonly rateLimitPerMinute: number;
}

export interface ServerDeps {
  readonly manager: SessionManager;
  readonly config: ServerConfig;
}

export type AppVariables = { request_id: string };
export type AppEnv = { Variables: AppVariables };
export type AppContext = Context<AppEnv>;

export function buildApp(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Server-wide redactor: scrubs error messages before they leave the host,
  // covering any credential-bearing substrings that an A2EError might carry
  // (e.g. when message is built from git stderr during bootstrap).
  const serverRedactor = buildRedactor(deps.config.redactEnvKeys, process.env);

  app.use("*", requestId());
  app.use("*", bodyLimit(deps.config.maxRequestBytes));
  app.use("/sessions/*", auth(deps.config.authTokens));
  app.use("/sessions", auth(deps.config.authTokens));
  if (deps.config.rateLimitPerMinute > 0) {
    app.use("/sessions/:id/*", rateLimit(deps.config.rateLimitPerMinute));
  }

  app.onError((err, c) => {
    const rid = c.get("request_id") ?? "unknown";
    if (err instanceof A2EError) {
      return jsonError(c, err.code, redactMessage(err.message, serverRedactor), rid, err.httpStatus);
    }
    if (err instanceof HTTPException) {
      const code: ErrorCode = err.status === 404 ? "NOT_FOUND" : "INTERNAL";
      return jsonError(c, code, undefined, rid, err.status);
    }
    return jsonError(c, "INTERNAL", undefined, rid, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  mountSessions(app, deps.manager);
  mountExec(app, deps.manager);
  mountState(app, deps.manager);
  mountReplay(app, deps.manager);

  return app;
}

function redactMessage(msg: string, redactor: Redactor): string {
  if (redactor.secrets.length === 0) return msg;
  const bytes = new TextEncoder().encode(msg);
  const clean = redactor.redact(bytes);
  return new TextDecoder().decode(clean);
}

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------

function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rid = crypto.randomUUID();
    c.set("request_id", rid);
    c.header("X-Request-Id", rid);
    await next();
  };
}

function auth(tokens: readonly string[]): MiddlewareHandler<AppEnv> {
  const allow = new Set(tokens);
  return async (c, next) => {
    if (allow.size === 0) {
      // Auth disabled only when explicitly empty (dev / test).
      await next();
      return;
    }
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m || !allow.has(m[1]!)) {
      throw new A2EError("UNAUTHORIZED", "missing or invalid bearer token", 401);
    }
    await next();
  };
}

/**
 * Per-session fixed-window rate limiter. Counts all requests against
 * `/sessions/:id/*` for that session id. Windows expire after 60s + 10s slack
 * so memory usage stays bounded at ~active-sessions.
 */
function rateLimit(perMinute: number): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, { start: number; count: number }>();
  const WINDOW_MS = 60_000;
  const GC_EVERY = 1000;
  let hits = 0;
  return async (c, next) => {
    const id = c.req.param("id");
    if (!id) { await next(); return; }
    const now = Date.now();
    const existing = windows.get(id);
    if (!existing || now - existing.start >= WINDOW_MS) {
      windows.set(id, { start: now, count: 1 });
    } else {
      existing.count++;
      if (existing.count > perMinute) {
        throw new A2EError(
          "RATE_LIMITED",
          `rate limit exceeded for session '${id}' (${perMinute}/min)`,
          429,
        );
      }
    }
    hits++;
    if (hits % GC_EVERY === 0) {
      for (const [k, v] of windows) {
        if (now - v.start >= WINDOW_MS + 10_000) windows.delete(k);
      }
    }
    await next();
  };
}

function bodyLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cl = c.req.header("content-length");
    if (cl) {
      const n = Number.parseInt(cl, 10);
      if (Number.isFinite(n) && n > maxBytes) {
        throw new A2EError("PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes}B`, 413);
      }
    }
    await next();
  };
}

function jsonError(
  c: AppContext,
  code: ErrorCode,
  message: string | undefined,
  request_id: string,
  httpStatus?: number,
): Response {
  const status = (httpStatus ?? httpStatusForCode[code] ?? 500) as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  const body = message ? { error: code, request_id, message } : { error: code, request_id };
  return c.json(body, status);
}
