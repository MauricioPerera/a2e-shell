/**
 * Metrics registry. Exposes Prometheus-format counters, gauges, and
 * histograms. Mounted at `GET /metrics` by the HTTP layer.
 *
 * Name convention: `a2e_<domain>_<unit>` with lowercase labels. No high-
 * cardinality labels (never session_id, request_id, command content).
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Default Node.js process metrics (heap, event loop lag, FDs). Low cost,
// extremely useful for alerting.
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: "a2e_http_requests_total",
  help: "HTTP requests received, labeled by route template and status code.",
  labelNames: ["route", "status"] as const,
  registers: [registry],
});

export const httpDurationMs = new Histogram({
  name: "a2e_http_request_duration_ms",
  help: "End-to-end HTTP request duration in milliseconds.",
  labelNames: ["route"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000],
  registers: [registry],
});

export const sessionsActive = new Gauge({
  name: "a2e_sessions_active",
  help: "Number of sessions currently registered in the manager.",
  registers: [registry],
});

export const sessionLifecycle = new Counter({
  name: "a2e_sessions_total",
  help: "Session lifecycle events.",
  labelNames: ["event"] as const, // created | deleted | expired | bootstrap_failed
  registers: [registry],
});

export const execDurationMs = new Histogram({
  name: "a2e_exec_duration_ms",
  help: "Exec turn duration in milliseconds (includes pipeline overhead).",
  buckets: [1, 10, 50, 100, 500, 1000, 5000, 30000, 60000],
  registers: [registry],
});

export const execTotal = new Counter({
  name: "a2e_exec_total",
  help: "Exec turns completed, labeled by outcome.",
  labelNames: ["outcome"] as const, // ok | error | intercept
  registers: [registry],
});

export const errorsTotal = new Counter({
  name: "a2e_errors_total",
  help: "Error responses emitted, labeled by error code.",
  labelNames: ["code"] as const,
  registers: [registry],
});

export const catalogMirrorsActive = new Gauge({
  name: "a2e_catalog_mirrors_active",
  help: "Active catalog mirrors in the shared cache.",
  registers: [registry],
});

export const catalogMirrorEvents = new Counter({
  name: "a2e_catalog_mirror_events_total",
  help: "Catalog mirror lifecycle events.",
  labelNames: ["event"] as const, // created | refreshed | pruned
  registers: [registry],
});

export const rateLimitHits = new Counter({
  name: "a2e_rate_limit_hits_total",
  help: "Requests rejected by the rate limiter, labeled by bucket kind.",
  labelNames: ["bucket"] as const, // session | create
  registers: [registry],
});

export const redactorSecrets = new Gauge({
  name: "a2e_redactor_secrets_count",
  help: "Number of secrets loaded into the server-level redactor.",
  registers: [registry],
});

export const transcriptRotations = new Counter({
  name: "a2e_transcript_rotations_total",
  help: "Transcript segment rotations (sessions reaching the soft cap).",
  registers: [registry],
});

// --- MCP notifications (RFC 004, v1.4) --------------------------------------

export const mcpNotifications = new Counter({
  name: "a2e_mcp_notifications_total",
  help: "Server-initiated MCP notifications received by the catalog dispatcher.",
  labelNames: ["server_id", "event"] as const,
  registers: [registry],
});

export const mcpStreamReconnects = new Counter({
  name: "a2e_mcp_stream_reconnects_total",
  help: "Long-lived GET notification stream reconnect attempts by server.",
  labelNames: ["server_id"] as const,
  registers: [registry],
});

export const mcpStreamConnected = new Gauge({
  name: "a2e_mcp_stream_connected",
  help: "1 while the long-lived GET notification stream is open for this server, 0 otherwise.",
  labelNames: ["server_id"] as const,
  registers: [registry],
});
