/**
 * Bridge between the existing HTTP session surface (src/session/state.ts) and
 * the bounded-verb runtime (src/runtime/*).
 *
 * Entry point: executeBoundedTurn(session, req). Called from pipeline.ts when
 * session.policy.mode === "bounded". Responsible for:
 *
 *   1. Lazy-initialising the per-session BoundedRuntime on first call
 *      (WeakMap keyed by the outer Session so lifetime is coupled).
 *   2. Translating HTTP Session policy → CallCapabilities the runtime expects.
 *   3. Parsing + executing the command via src/runtime/execute.js.
 *   4. Mapping the bounded CanonicalResponse back into the existing
 *      ExecResponse shape so the HTTP layer, transcript writer, idempotency
 *      cache etc. remain transport-agnostic.
 *
 * Notes:
 *   - Bindings live on the BoundedRuntime side, NOT on session.getBindings()
 *     (which is the unrestricted-mode map). They are separate storage by
 *     design — the two modes don't share variable scope.
 *   - Persistence is NOT wired: restoring a bounded session from disk starts
 *     with an empty bindings map. Deferred to v0.2.
 *   - No idempotency-cache integration is done here; the outer handler in
 *     exec.ts already caches the ExecResponse we return.
 */

import { A2EError, type ErrorCode } from "../errors.js";
import type { ExecRequest, ExecResponse } from "../io/protocol.js";
import { describeShape, type CanonicalResponse } from "../runtime/canonical.js";
import { parseProgram } from "../parser/parse.js";
import { executeProgram } from "../runtime/execute.js";
import {
  createSession as createBoundedSession,
  type CallCapabilities,
  type Session as BoundedSession,
} from "../runtime/session.js";
import type { Session } from "../session/state.js";

// WeakMap lifetime is tied to the outer Session; when the manager releases the
// Session, the bounded runtime state becomes unreachable and is GC'd.
const boundedRuntimes: WeakMap<Session, BoundedSession> = new WeakMap();

export async function executeBoundedTurn(
  session: Session,
  req: ExecRequest,
): Promise<ExecResponse> {
  const rt = getOrCreateBoundedRuntime(session);

  try {
    const program = parseProgram(req.command);
    const responses = await executeProgram(rt, req.command, program);
    // Program can produce multiple responses only for multi-stmt inputs, which
    // the grammar doesn't allow in v0.1 (one-stmt-per-turn). If we get more
    // than one, take the LAST (outermost block) — that's the user-visible one.
    const last = responses[responses.length - 1];
    if (!last) {
      // Empty program (rare: just whitespace). Surface as an error so
      // clients don't get a 200 with no information.
      throw new A2EError("PARSE_ERROR", "empty program");
    }
    return toExecResponse(last);
  } catch (e) {
    if (e instanceof A2EError) {
      return errorExecResponse(e.code, e.message);
    }
    return errorExecResponse("INTERNAL", (e as Error).message);
  }
}

function getOrCreateBoundedRuntime(session: Session): BoundedSession {
  let rt = boundedRuntimes.get(session);
  if (!rt) {
    rt = createBoundedSession(session.id, capsFromPolicy(session));
    boundedRuntimes.set(session, rt);
  }
  return rt;
}

function capsFromPolicy(session: Session): CallCapabilities {
  const p = session.policy;
  return {
    binariesAllowlist: p.binaries_allowlist,
    httpDomainsAllowlist: p.http_domains_allowlist,
    maxExecTimeoutMs: p.max_exec_timeout_ms,
    maxResponseBytes: p.max_response_bytes,
    binaryPaths: p.binary_paths,
    pathEnv: p.path_env,
  };
}

/**
 * Map bounded canonical response → HTTP ExecResponse shape. Two translation
 * rules:
 *   - shape: Shape object → string descriptor (e.g. "list[3]", "scalar[4B]").
 *   - binding: bare name → "$name" (the HTTP contract prefixes with $).
 */
function toExecResponse(r: CanonicalResponse): ExecResponse {
  if (r.error !== null) {
    return errorExecResponse(r.error.code, r.error.message, r.stderr);
  }
  const shapeStr = r.shape.kind === "void" ? null : describeShape(r.shape);
  // Preview in bounded mode is always a string; the HTTP contract uses
  // `unknown`. For record/list shapes we JSON.parse back so clients receive
  // structured data, mirroring the "preview is a cheap peek" semantics.
  const preview = parsePreviewBack(r.preview);
  return {
    status_line: r.status_line,
    shape: shapeStr,
    preview,
    binding: r.binding ? `$${r.binding}` : null,
    // Bounded CanonicalOk contract pins stderr="" on success; the HTTP
    // contract uses null for the same condition.
    stderr: null,
    truncated: r.truncated,
  };
}

function parsePreviewBack(preview: string): unknown {
  if (preview === "") return "";
  // Heuristic: if preview starts with {, [, " or is a bare literal, try JSON.
  // If it fails (truncated preview with "…+Nmore"), fall back to the string.
  const first = preview.charAt(0);
  const isDigit = first >= "0" && first <= "9";
  if (first !== "{" && first !== "[" && first !== "\"" && first !== "-" &&
      !isDigit &&
      preview !== "true" && preview !== "false" && preview !== "null") {
    return preview;
  }
  try {
    return JSON.parse(preview);
  } catch {
    return preview;
  }
}

function errorExecResponse(code: string, message: string, stderr: string | null = null): ExecResponse {
  // Map to the closed ErrorCode enum. Unknown codes (e.g. from unexpected
  // sources) fall back to INTERNAL — keeps the response z-schema-valid.
  const mapped: ErrorCode = isKnownErrorCode(code) ? code : "INTERNAL";
  return {
    status_line: `ERR | ${mapped}`,
    shape: null,
    preview: null,
    binding: null,
    stderr,
    truncated: false,
    error: { code: mapped, message },
  };
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "PARSE_ERROR", "CAPABILITY_DENIED", "INTERPOLATION_REJECTED", "SCOPE_MISS",
  "TIMEOUT", "SIZE_LIMIT", "UPSTREAM_ERROR", "INTERNAL", "UNAUTHORIZED",
  "NOT_FOUND", "CONFLICT", "PAYLOAD_TOO_LARGE", "RATE_LIMITED",
  "SERVICE_UNAVAILABLE", "NOT_IMPLEMENTED_V1",
  "MCP_SERVER_UNREACHABLE", "MCP_AUTH_FAILED", "MCP_TOOL_NOT_FOUND",
  "MCP_PROTOCOL_ERROR", "MCP_TIMEOUT",
]);

function isKnownErrorCode(code: string): code is ErrorCode {
  return KNOWN_ERROR_CODES.has(code);
}
