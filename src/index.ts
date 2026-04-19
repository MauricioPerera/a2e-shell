import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { buildApp } from "./http/server.js";
import { createLifecycle } from "./http/lifecycle.js";
import { createManager } from "./session/manager.js";
import { createCatalogCache } from "./catalog/cache.js";
import { logger } from "./logging/logger.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const redactEnvKeys = envList("A2E_REDACT_ENV_KEYS");
const workerId = process.env.A2E_WORKER_ID ?? crypto.randomUUID();
const gracePeriodMs = envInt("A2E_GRACE_PERIOD_MS", 30_000);
const config = {
  port: envInt("A2E_PORT", 8080),
  authTokens: envList("A2E_AUTH_TOKENS"),
  maxRequestBytes: envInt("A2E_MAX_REQUEST_BYTES", 1_048_576),
  redactEnvKeys,
  rateLimitPerMinute: envInt("A2E_RATE_LIMIT_PER_MINUTE", 120),
  rateLimitCreatePerMinute: envInt("A2E_RATE_LIMIT_CREATE_PER_MINUTE", 20),
  workerId,
};

const sessionsDir = process.env.A2E_SESSIONS_DIR ?? "./sessions";
const catalogCache = createCatalogCache({
  enabled: (process.env.A2E_CATALOG_CACHE_ENABLED ?? "true") !== "false",
  cacheDir: process.env.A2E_CATALOG_CACHE_DIR ?? path.join(sessionsDir, ".catalog-cache"),
  refreshSeconds: envInt("A2E_CATALOG_CACHE_REFRESH_S", 60),
  filterBlobs: (process.env.A2E_CATALOG_CACHE_FILTER_BLOBS ?? "true") !== "false",
  maxBytes: envInt("A2E_CATALOG_CACHE_MAX_BYTES", 2 * 1024 * 1024 * 1024), // 2 GiB
  sweepIntervalSeconds: envInt("A2E_CATALOG_CACHE_SWEEP_INTERVAL_S", 300), // 5 min
});

const manager = createManager({
  sessionsDir,
  redactEnvKeys,
  catalogBootstrapTimeoutMs: envInt("A2E_CATALOG_BOOTSTRAP_TIMEOUT_MS", 60_000),
  catalogCache,
  allowedCwdPrefixes: envList("A2E_ALLOWED_CWD_PREFIXES"),
  persistenceEnabled: (process.env.A2E_SESSION_PERSISTENCE ?? "false") === "true",
});

setInterval(() => manager.sweepExpired(), 60_000).unref();

const lifecycle = createLifecycle();
const app = buildApp({ manager, config, lifecycle });

const server = serve({ fetch: app.fetch, port: config.port });
logger.info({
  event: "server.listening",
  port: config.port,
  worker_id: config.workerId,
  auth_enabled: config.authTokens.length > 0,
  rate_limit_per_minute: config.rateLimitPerMinute,
  rate_limit_create_per_minute: config.rateLimitCreatePerMinute,
  redact_keys_count: config.redactEnvKeys.length,
  grace_period_ms: gracePeriodMs,
  sessions_dir: sessionsDir,
});

// Graceful shutdown. SIGTERM (container stop) and SIGINT (ctrl-c) both route
// through the drain → wait → close sequence. Kubernetes sends SIGTERM and
// then SIGKILL after terminationGracePeriodSeconds; keep A2E_GRACE_PERIOD_MS
// strictly below that.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "server.shutdown.begin", signal, in_flight: lifecycle.inFlight() });
  lifecycle.beginDrain();
  const clean = await lifecycle.waitForDrain(gracePeriodMs);
  try {
    server.close(() => {
      logger.info({ event: "server.shutdown.http_closed" });
    });
  } catch { /* ignore */ }
  catalogCache.shutdown();
  logger.info({ event: "server.shutdown.done", drained_cleanly: clean });
  // Flush pino's async buffer (line-buffered stdout usually writes synchronously
  // but there's a small in-memory queue) before exiting.
  try { logger.flush(); } catch { /* ignore */ }
  // 200ms gives the event loop enough cycles to drain the HTTP server and
  // flush any remaining log chunks to stdout.
  setTimeout(() => process.exit(clean ? 0 : 1), 200);
}

process.on("SIGTERM", () => {
  logger.info({ event: "server.signal.received", signal: "SIGTERM" });
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  logger.info({ event: "server.signal.received", signal: "SIGINT" });
  void shutdown("SIGINT");
});

// If A2E_PID_FILE is set, write our real PID there so init systems / deploy
// scripts can target the actual node process (shell $! often lands on an
// intermediate subshell when env vars precede the command).
const pidFile = process.env.A2E_PID_FILE;
if (pidFile) {
  try {
    fs.writeFileSync(pidFile, String(process.pid));
    logger.info({ event: "server.pid_file.written", path: pidFile, pid: process.pid });
  } catch (e) {
    logger.warn({ event: "server.pid_file.failed", path: pidFile, err: String(e) });
  }
}
