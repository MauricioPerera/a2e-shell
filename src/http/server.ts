import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import * as crypto from "node:crypto";
import { A2EError, httpStatusForCode, type ErrorCode } from "../errors.js";
import { buildRedactor, type Redactor } from "../credentials/redactor.js";
import { logger } from "../logging/logger.js";
import {
  registry as metricsRegistry,
  httpRequests,
  httpDurationMs,
  errorsTotal,
  rateLimitHits,
  redactorSecrets,
} from "../metrics/metrics.js";
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
  /** Per-session rate limit on /sessions/:id/* routes. 0 = disabled. */
  readonly rateLimitPerMinute: number;
  /** Rate limit for POST /sessions (keyed by bearer token, else 'anon'). 0 = disabled. */
  readonly rateLimitCreatePerMinute: number;
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
  redactorSecrets.set(serverRedactor.secrets.length);

  app.use("*", requestId());
  app.use("*", observability());
  app.use("*", bodyLimit(deps.config.maxRequestBytes));
  app.use("/sessions/*", auth(deps.config.authTokens));
  app.use("/sessions", auth(deps.config.authTokens));
  if (deps.config.rateLimitPerMinute > 0) {
    const sessionRateLimit = rateLimit(deps.config.rateLimitPerMinute, (c) => {
      const id = c.req.param("id");
      return id ? `session:${id}` : null;
    });
    app.use("/sessions/:id", sessionRateLimit);
    app.use("/sessions/:id/*", sessionRateLimit);
  }
  if (deps.config.rateLimitCreatePerMinute > 0) {
    app.use("/sessions", rateLimit(deps.config.rateLimitCreatePerMinute, (c) => {
      // No session id yet at creation time. Key by bearer token (one bucket per
      // client), falling back to 'anon' (one shared bucket in dev). This caps
      // catalog-clone storms even when auth is disabled.
      const h = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/.exec(h);
      return m ? `create:token:${m[1]}` : "create:anon";
    }));
  }

  app.onError((err, c) => {
    const rid = c.get("request_id") ?? "unknown";
    if (err instanceof A2EError) {
      errorsTotal.inc({ code: err.code });
      logger.warn({
        event: "http.error",
        request_id: rid,
        code: err.code,
        http_status: err.httpStatus,
      });
      return jsonError(c, err.code, redactMessage(err.message, serverRedactor), rid, err.httpStatus);
    }
    if (err instanceof HTTPException) {
      const code: ErrorCode = err.status === 404 ? "NOT_FOUND" : "INTERNAL";
      errorsTotal.inc({ code });
      logger.warn({ event: "http.error", request_id: rid, code, http_status: err.status });
      return jsonError(c, code, undefined, rid, err.status);
    }
    errorsTotal.inc({ code: "INTERNAL" });
    logger.error({
      event: "http.error.unhandled",
      request_id: rid,
      err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
    return jsonError(c, "INTERNAL", undefined, rid, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/metrics", async (c) => {
    const body = await metricsRegistry.metrics();
    return c.text(body, 200, { "Content-Type": metricsRegistry.contentType });
  });

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

/** Paths whose per-request log would be pure noise (scraped or probed often). */
const SILENT_LOG_PATHS: ReadonlySet<string> = new Set(["/metrics", "/healthz"]);

/**
 * Observability middleware: logs request start/end with timing and status,
 * records HTTP metrics. Route label uses the Hono match pattern (e.g.
 * "/sessions/:id/exec") so cardinality stays bounded. `/metrics` and
 * `/healthz` are excluded from per-request logs (they're scraped/probed at
 * high frequency and generate pure noise); metrics are still recorded.
 */
function observability(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    const route = (c.req.routePath || path).replace(/^\//, "").split("/").slice(0, 4).join("/");
    const routeLabel = `${method} /${route}`;
    httpRequests.inc({ route: routeLabel, status: String(status) });
    httpDurationMs.observe({ route: routeLabel }, duration);
    if (!SILENT_LOG_PATHS.has(path)) {
      logger.info({
        event: "http.request",
        request_id: c.get("request_id"),
        method,
        path,
        status,
        duration_ms: duration,
      });
    }
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

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_GC_INTERVAL_MS = 30_000;

/**
 * Fixed-window rate limiter with pluggable key extractor. Unreferenced windows
 * are GC'd periodically (timer-based, not hit-based) so memory stays bounded
 * even under low traffic.
 */
function rateLimit(
  perMinute: number,
  getKey: (c: import("hono").Context<AppEnv>) => string | null,
): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, { start: number; count: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of windows) {
      if (now - v.start >= RATE_LIMIT_WINDOW_MS + 10_000) windows.delete(k);
    }
  }, RATE_LIMIT_GC_INTERVAL_MS);
  timer.unref();

  return async (c, next) => {
    const key = getKey(c);
    if (!key) { await next(); return; }
    const now = Date.now();
    const existing = windows.get(key);
    if (!existing || now - existing.start >= RATE_LIMIT_WINDOW_MS) {
      windows.set(key, { start: now, count: 1 });
    } else {
      existing.count++;
      if (existing.count > perMinute) {
        const bucket = key.startsWith("create:") ? "create" : "session";
        rateLimitHits.inc({ bucket });
        throw new A2EError(
          "RATE_LIMITED",
          `rate limit exceeded for '${key}' (${perMinute}/min)`,
          429,
        );
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
