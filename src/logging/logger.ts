/**
 * Structured logger. Every operational event flows through here.
 *
 * Output is line-delimited JSON on stdout (pino default). Level via env
 * `A2E_LOG_LEVEL` (trace|debug|info|warn|error|fatal). Always includes a
 * `service` field so multi-service log aggregators can demux.
 *
 * Child loggers bind request/session context. Prefer:
 *
 *   const log = logger.child({ session_id: sid, request_id: rid });
 *   log.info({ event: "exec.start", command_bytes: 42 });
 *
 * over ad-hoc concatenation so downstream tooling can filter by field.
 */

import pino from "pino";

const level = process.env.A2E_LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: { service: "a2e-shell" },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact common secret-shaped keys defensively. The per-session redactor
  // handles subprocess output; this one catches logger misuse (someone passing
  // a token into a log field).
  redact: {
    paths: [
      "authorization",
      "token",
      "password",
      "*.token",
      "*.password",
      "*.authorization",
    ],
    censor: "[REDACTED]",
  },
});

export type Logger = typeof logger;
