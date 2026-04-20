/**
 * Orchestrator for a single exec turn. Glue between interpolate,
 * state-intercept, policy, redactor, run, formatter, and session.
 */

import { A2EError, type ErrorCode } from "../errors.js";
import { interpolate } from "./interpolate.js";
import { classify as classifyIntercept } from "./state-intercept.js";
import { enforceBinaryAllowlist } from "../capabilities/policy.js";
import { run } from "./run.js";
import { format, detectShape } from "../io/format.js";
import type { Session } from "../session/state.js";
import type { ExecRequest, ExecResponse } from "../io/protocol.js";
import type { Binding } from "./interpolate.js";
import { logger } from "../logging/logger.js";
import { execDurationMs, execTotal, errorsTotal } from "../metrics/metrics.js";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { handleMcpInvoke, isMcpInvoke } from "../mcp/invoke.js";

type TurnOutcome = "ok" | "error" | "intercept";
interface TurnResult {
  readonly response: ExecResponse;
  readonly outcome: TurnOutcome;
}

/**
 * Optional streaming sink. Callbacks receive redacted UTF-8 text chunks
 * decoded incrementally (stream-mode TextDecoder) so multi-byte chars that
 * land across chunk boundaries stay intact.
 *
 * Known limitation: secrets that span a chunk boundary won't be caught by
 * the per-chunk redactor. Rare in practice (Node pipe chunks are typically
 * 16-64 KiB; tokens are <256 chars) but the non-streaming response still
 * runs the redactor over the aggregate, so the final `done` event carries
 * fully scrubbed content.
 */
export interface ExecSink {
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  /**
   * Called when the current exec is an MCP tools/call and the upstream
   * server emits `notifications/progress` or similar messages while the
   * call is in flight. Non-MCP execs never invoke this. Non-streaming
   * execs (JSON response) don't provide this callback.
   */
  onMcpNotification?(notification: { method: string; params?: unknown }): void;
}

export async function executeTurn(
  session: Session,
  req: ExecRequest,
  sink?: ExecSink,
): Promise<ExecResponse> {
  const start = Date.now();
  // Bounded mode has its own runtime that does not go through bash/spawn.
  // Fork early — we still emit the standard exec metrics + log below so
  // observability is uniform regardless of mode.
  if (session.policy.mode === "bounded") {
    const { executeBoundedTurn } = await import("./pipeline-bounded.js");
    const response = await executeBoundedTurn(session, req);
    const outcome: "ok" | "error" = response.error ? "error" : "ok";
    execTotal.inc({ outcome });
    if (outcome === "error" && response.error) errorsTotal.inc({ code: response.error.code });
    execDurationMs.observe(Date.now() - start);
    logger.info({
      event: "exec",
      session_id: session.id,
      mode: "bounded",
      outcome,
      duration_ms: Date.now() - start,
      command_bytes: req.command.length,
      ...(outcome === "error" && response.error ? { error_code: response.error.code } : {}),
      ...(response.truncated ? { truncated: true } : {}),
    });
    return response;
  }
  try {
    const { response, outcome } = await runTurn(session, req, sink);
    execTotal.inc({ outcome });
    if (outcome === "error" && response.error) errorsTotal.inc({ code: response.error.code });
    execDurationMs.observe(Date.now() - start);
    logger.info({
      event: "exec",
      session_id: session.id,
      outcome,
      duration_ms: Date.now() - start,
      command_bytes: req.command.length,
      has_bind: req.bind_as !== undefined,
      has_idempotency_key: req.idempotency_key !== undefined,
      ...(outcome === "error" && response.error ? { error_code: response.error.code } : {}),
      ...(response.truncated ? { truncated: true } : {}),
    });
    return response;
  } catch (e) {
    // Defense in depth: runTurn is wrapped such that every branch surfaces
    // via errorResponse. Landing here means an unexpected throw slipped past
    // that contract — log loudly so operators catch it quickly.
    execTotal.inc({ outcome: "error" });
    execDurationMs.observe(Date.now() - start);
    const res = errorResponse(e);
    if (res.error) errorsTotal.inc({ code: res.error.code });
    logger.error({
      event: "exec.unhandled",
      session_id: session.id,
      duration_ms: Date.now() - start,
      err: e instanceof Error ? { message: e.message, stack: e.stack } : String(e),
      ...(res.error ? { error_code: res.error.code } : {}),
    });
    return res;
  }
}

async function runTurn(
  session: Session,
  req: ExecRequest,
  sink?: ExecSink,
): Promise<TurnResult> {
  let interpolated: string;
  try {
    interpolated = interpolate(req.command, session.getBindings());
  } catch (e) {
    return { response: errorResponse(e), outcome: "error" };
  }

  // RFC 001 v1.1 — MCP gateway intercept. Runs BEFORE state-intercept and
  // BEFORE binary allowlist enforcement because /bin/mcp-invoke is a reserved
  // virtual path, not a real binary. If the command matches, this branch
  // handles it end-to-end and returns a canonical response.
  if (isMcpInvoke(interpolated)) {
    const result = await handleMcpInvoke({
      mcpClients: session.mcpClients,
      policy: session.policy,
      redactor: session.redactor,
      req: { ...req, command: interpolated },
      // Only forward notifications when the caller is streaming — otherwise
      // there's no one to receive them between the request and its response.
      ...(sink?.onMcpNotification
        ? { onNotification: (n) => sink.onMcpNotification!(n) }
        : {}),
    });
    if (result.kind === "handled") {
      // Capture binding if provided and the call succeeded.
      if (result.binding && req.bind_as && !result.response.error) {
        try {
          session.bind(req.bind_as, result.binding);
        } catch (e) {
          return { response: errorResponse(e), outcome: "error" };
        }
      }
      const outcome: TurnOutcome = result.response.error ? "error" : "ok";
      return { response: result.response, outcome };
    }
    // Fall through on "pass" (defensive — shouldn't happen since isMcpInvoke was true).
  }

  // Intercept branch (cd/export/unset) — no spawn.
  const cls = classifyIntercept(interpolated);
  if (cls.kind === "intercept") {
    return await applyIntercept(session, cls.mutation);
  }

  // Policy check (sync, static).
  try {
    enforceBinaryAllowlist(interpolated, session.policy);
  } catch (e) {
    return { response: errorResponse(e), outcome: "error" };
  }

  // Resolve stdin (may also interpolate).
  let stdin: string | undefined;
  if (req.stdin !== undefined) {
    try {
      stdin = interpolate(req.stdin, session.getBindings());
    } catch (e) {
      return { response: errorResponse(e), outcome: "error" };
    }
  }

  // Ensure cwd exists (auto-created on session bootstrap, but stale cwd after cd).
  await fsp.mkdir(session.getCwd(), { recursive: true }).catch(() => {});

  const policy = session.policy;
  const timeout_ms = Math.min(
    req.timeout_ms ?? policy.max_exec_timeout_ms,
    policy.max_exec_timeout_ms,
  );

  const env = buildSubprocessEnv(session);

  // Stream-mode TextDecoders keep multi-byte UTF-8 sequences whole across
  // chunk boundaries. Created per-call so state doesn't bleed between turns.
  const stdoutDec = new TextDecoder("utf-8", { fatal: false });
  const stderrDec = new TextDecoder("utf-8", { fatal: false });
  const onStdout = sink?.onStdout
    ? (bytes: Uint8Array) => {
        const clean = session.redactor.redact(bytes);
        const text = stdoutDec.decode(clean, { stream: true });
        if (text.length > 0) sink.onStdout!(text);
      }
    : undefined;
  const onStderr = sink?.onStderr
    ? (bytes: Uint8Array) => {
        const clean = session.redactor.redact(bytes);
        const text = stderrDec.decode(clean, { stream: true });
        if (text.length > 0) sink.onStderr!(text);
      }
    : undefined;

  const runResult = await run({
    command: interpolated,
    cwd: session.getCwd(),
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    timeout_ms,
    max_response_bytes: policy.max_response_bytes,
    ...(onStdout ? { onStdout } : {}),
    ...(onStderr ? { onStderr } : {}),
  });

  // Flush any trailing bytes from incomplete multi-byte sequences.
  if (sink?.onStdout) {
    const tail = stdoutDec.decode();
    if (tail.length > 0) sink.onStdout(tail);
  }
  if (sink?.onStderr) {
    const tail = stderrDec.decode();
    if (tail.length > 0) sink.onStderr(tail);
  }

  if (runResult.timed_out) {
    return {
      response: errorResponse(
        new A2EError("TIMEOUT", `command exceeded timeout ${timeout_ms}ms`),
      ),
      outcome: "error",
    };
  }

  const stdoutClean = session.redactor.redact(runResult.stdout);
  const stderrClean = session.redactor.redact(runResult.stderr);

  const response = format({
    exit_code: runResult.exit_code,
    stdout: stdoutClean,
    stderr: stderrClean,
    preview_bytes_limit: policy.preview_bytes,
    stderr_bytes_limit: policy.stderr_preview_bytes,
    ...(req.bind_as ? { bind_as: req.bind_as } : {}),
    ...(runResult.truncated ? { truncated: true } : {}),
  });

  // Capture binding on success. bind() enforces size/count caps → SIZE_LIMIT.
  if (req.bind_as && runResult.exit_code === 0) {
    const full = new TextDecoder("utf-8", { fatal: false }).decode(stdoutClean);
    const binding: Binding = {
      value: full,
      shape: detectShape(stdoutClean) ?? `text[${stdoutClean.length}b]`,
      size_bytes: stdoutClean.length,
    };
    try {
      session.bind(req.bind_as, binding);
    } catch (e) {
      // Binding failed AFTER exec completed. Surface as an error response so
      // the LLM knows the binding was NOT captured and can reduce scope.
      return { response: errorResponse(e), outcome: "error" };
    }
  }

  return { response, outcome: runResult.exit_code === 0 ? "ok" : "error" };
}

async function applyIntercept(
  session: Session,
  mutation:
    | { type: "cd"; path: string }
    | { type: "export"; key: string; value: string }
    | { type: "unset"; keys: readonly string[] },
): Promise<TurnResult> {
  try {
    if (mutation.type === "cd") {
      const expanded = expandHome(mutation.path, session);
      const target = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(session.getCwd(), expanded);
      try {
        const st = await fsp.stat(target);
        if (!st.isDirectory()) {
          return {
            response: errorResponse(
              new A2EError("UPSTREAM_ERROR", `cd: not a directory: ${target}`),
            ),
            outcome: "error",
          };
        }
      } catch {
        return {
          response: errorResponse(
            new A2EError("UPSTREAM_ERROR", `cd: no such directory: ${target}`),
          ),
          outcome: "error",
        };
      }
      session.setCwd(target);
    } else if (mutation.type === "export") {
      session.setEnv(mutation.key, mutation.value);
    } else {
      session.unsetEnv(mutation.keys);
    }
  } catch (e) {
    // session.setEnv / unsetEnv throw CAPABILITY_DENIED on reserved keys.
    // Surface as exec-level error so the LLM sees the refusal.
    return { response: errorResponse(e), outcome: "error" };
  }
  const response = format({
    exit_code: null,
    stdout: new Uint8Array(0),
    stderr: new Uint8Array(0),
    preview_bytes_limit: session.policy.preview_bytes,
    stderr_bytes_limit: session.policy.stderr_preview_bytes,
  });
  return { response, outcome: "intercept" };
}

/**
 * Expand a leading `~` or `~/...` in a cd target. Uses the session's env
 * overlay HOME first (so `export HOME=/custom` takes effect), then falls back
 * to the server process env. No-op for paths that don't start with `~`.
 */
function expandHome(p: string, session: Session): string {
  if (p === "~") {
    return session.getEnvOverlay().HOME ?? process.env.HOME ?? p;
  }
  if (p.startsWith("~/")) {
    const home = session.getEnvOverlay().HOME ?? process.env.HOME;
    if (home) return path.join(home, p.slice(2));
  }
  return p;
}

function buildSubprocessEnv(session: Session): Record<string, string> {
  const base: Record<string, string> = {};
  // Minimal safe base: HOME, USER, LANG come from the host process.
  for (const k of ["HOME", "USER", "LANG", "LC_ALL"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  const overlay = session.getEnvOverlay();
  const path_env = session.policy.path_env;
  // Catalog env vars MUST win over any overlay — session.setEnv rejects
  // A2E_CATALOG_* as reserved, but defense-in-depth: apply catalog env AFTER
  // overlay so even a skipped validation can't shadow them.
  const catalogEnv: Record<string, string> = {};
  if (session.catalog) {
    catalogEnv.A2E_CATALOG_INDEX = session.catalog.index_dir;
    catalogEnv.A2E_CATALOG_CONTENT = session.catalog.content_dir;
    catalogEnv.A2E_CATALOG_REACHABILITY = session.catalog.reachability.report_path;
  }
  return {
    ...base,
    ...overlay,
    ...catalogEnv,
    PATH: path_env,
  };
}

function errorResponse(e: unknown): ExecResponse {
  if (e instanceof A2EError) {
    return format({
      exit_code: null,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 0,
      stderr_bytes_limit: 0,
      errorCode: e.code,
      errorMessage: e.message,
    });
  }
  const code: ErrorCode = "INTERNAL";
  const message = e instanceof Error ? e.message : "unknown error";
  return format({
    exit_code: null,
    stdout: new Uint8Array(0),
    stderr: new Uint8Array(0),
    preview_bytes_limit: 0,
    stderr_bytes_limit: 0,
    errorCode: code,
    errorMessage: message,
  });
}
