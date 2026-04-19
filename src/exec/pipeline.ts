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

export async function executeTurn(
  session: Session,
  req: ExecRequest,
): Promise<ExecResponse> {
  const start = Date.now();
  try {
    const result = await runTurn(session, req);
    const isError = result.error !== undefined;
    const isIntercept = result.status_line === "[exit 0]" && result.shape === null && result.preview === null;
    const outcome = isError ? "error" : isIntercept ? "intercept" : "ok";
    execTotal.inc({ outcome });
    if (isError && result.error) errorsTotal.inc({ code: result.error.code });
    execDurationMs.observe(Date.now() - start);
    logger.info({
      event: "exec",
      session_id: session.id,
      outcome,
      duration_ms: Date.now() - start,
      command_bytes: req.command.length,
      has_bind: req.bind_as !== undefined,
      has_idempotency_key: req.idempotency_key !== undefined,
      ...(isError && result.error ? { error_code: result.error.code } : {}),
      ...(result.truncated ? { truncated: true } : {}),
    });
    return result;
  } catch (e) {
    // Defense in depth: runTurn wraps every branch in errorResponse, but if
    // something truly exceptional slips through, classify and surface.
    execTotal.inc({ outcome: "error" });
    execDurationMs.observe(Date.now() - start);
    const res = errorResponse(e);
    if (res.error) errorsTotal.inc({ code: res.error.code });
    return res;
  }
}

async function runTurn(
  session: Session,
  req: ExecRequest,
): Promise<ExecResponse> {
  let interpolated: string;
  try {
    interpolated = interpolate(req.command, session.getBindings());
  } catch (e) {
    return errorResponse(e);
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
    return errorResponse(e);
  }

  // Resolve stdin (may also interpolate).
  let stdin: string | undefined;
  if (req.stdin !== undefined) {
    try {
      stdin = interpolate(req.stdin, session.getBindings());
    } catch (e) {
      return errorResponse(e);
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

  const runResult = await run({
    command: interpolated,
    cwd: session.getCwd(),
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    timeout_ms,
    max_response_bytes: policy.max_response_bytes,
  });

  if (runResult.timed_out) {
    return errorResponse(
      new A2EError("TIMEOUT", `command exceeded timeout ${timeout_ms}ms`),
    );
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
      return errorResponse(e);
    }
  }

  return response;
}

async function applyIntercept(
  session: Session,
  mutation:
    | { type: "cd"; path: string }
    | { type: "export"; key: string; value: string }
    | { type: "unset"; keys: readonly string[] },
): Promise<ExecResponse> {
  try {
    if (mutation.type === "cd") {
      const target = path.isAbsolute(mutation.path)
        ? mutation.path
        : path.resolve(session.getCwd(), mutation.path);
      try {
        const st = await fsp.stat(target);
        if (!st.isDirectory()) {
          return errorResponse(
            new A2EError("UPSTREAM_ERROR", `cd: not a directory: ${target}`),
          );
        }
      } catch {
        return errorResponse(
          new A2EError("UPSTREAM_ERROR", `cd: no such directory: ${target}`),
        );
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
    return errorResponse(e);
  }
  return format({
    exit_code: null,
    stdout: new Uint8Array(0),
    stderr: new Uint8Array(0),
    preview_bytes_limit: session.policy.preview_bytes,
    stderr_bytes_limit: session.policy.stderr_preview_bytes,
  });
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
