import * as path from "node:path";
import { serve } from "@hono/node-server";
import { buildApp } from "./http/server.js";
import { createManager } from "./session/manager.js";
import { createCatalogCache } from "./catalog/cache.js";

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
const config = {
  port: envInt("A2E_PORT", 8080),
  authTokens: envList("A2E_AUTH_TOKENS"),
  maxRequestBytes: envInt("A2E_MAX_REQUEST_BYTES", 1_048_576),
  redactEnvKeys,
  rateLimitPerMinute: envInt("A2E_RATE_LIMIT_PER_MINUTE", 120),
  rateLimitCreatePerMinute: envInt("A2E_RATE_LIMIT_CREATE_PER_MINUTE", 20),
};

const sessionsDir = process.env.A2E_SESSIONS_DIR ?? "./sessions";
const catalogCache = createCatalogCache({
  enabled: (process.env.A2E_CATALOG_CACHE_ENABLED ?? "true") !== "false",
  cacheDir: process.env.A2E_CATALOG_CACHE_DIR ?? path.join(sessionsDir, ".catalog-cache"),
  refreshSeconds: envInt("A2E_CATALOG_CACHE_REFRESH_S", 60),
  filterBlobs: (process.env.A2E_CATALOG_CACHE_FILTER_BLOBS ?? "true") !== "false",
});

const manager = createManager({
  sessionsDir,
  redactEnvKeys,
  catalogBootstrapTimeoutMs: envInt("A2E_CATALOG_BOOTSTRAP_TIMEOUT_MS", 60_000),
  catalogCache,
  allowedCwdPrefixes: envList("A2E_ALLOWED_CWD_PREFIXES"),
});

setInterval(() => manager.sweepExpired(), 60_000).unref();

const app = buildApp({ manager, config });

serve({ fetch: app.fetch, port: config.port });
