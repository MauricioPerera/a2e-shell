/**
 * `call` verb — HTTP and CLI branches.
 *
 * HTTP:  `call <METHOD> <url> [--header s]* [--body v] [--query s] [--timeout d]`
 *   - Uses native fetch. Domain must be in caps.httpDomainsAllowlist
 *     (or "*" wildcard); otherwise CAPABILITY_DENIED before the request fires.
 *   - Body encoding: string → sent as-is; any other Value → JSON.stringify
 *     with Content-Type: application/json unless the caller set it.
 *   - Response decoding:
 *       application/json  → parsed JSON (RuntimeValue)
 *       text/*            → string
 *       other             → hex preview ({ hex: "..." , bytes: N })
 *   - Non-2xx → UPSTREAM_ERROR with {status, body_preview}.
 *
 * CLI:   `call <binary> [args...]`
 *   - Binary must resolve via caps.binaryPaths (preferred) or be a
 *     SAFE_BUILTIN. Otherwise CAPABILITY_DENIED before spawn.
 *   - Spawn: shell:false, argv array. Never bash -c.
 *   - Timeout: SIGKILL at caps.maxExecTimeoutMs (or smaller if --timeout flag).
 *   - Exit 0 → stdout as string if UTF-8 decodable, else Buffer.
 *   - Exit ≠ 0 → UPSTREAM_ERROR with {exit_code, stderr_preview}.
 *
 * Neither branch resolves credentials. Env handed to CLI spawn is the
 * already-scrubbed caps.pathEnv; HTTP headers come straight from the
 * grammar — no session auth is injected here.
 */

import { spawn } from "node:child_process";
import type {
  CliArg,
  CliCall,
  HttpCall,
  HttpOption,
  Value,
} from "../parser/ast.js";
import { A2EError } from "../errors.js";
import { evalValue } from "../runtime/evaluate.js";
import type { CallCapabilities, RuntimeValue, Session } from "../runtime/session.js";

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const STDERR_PREVIEW_BYTES = 512;
const BODY_PREVIEW_BYTES = 512;

// =============================================================================
// HTTP
// =============================================================================

export async function runCallHttp(
  session: Session,
  cmd: HttpCall,
): Promise<RuntimeValue> {
  const urlVal = evalValue(cmd.url, { session });
  if (typeof urlVal !== "string") {
    throw new A2EError("PARSE_ERROR", `call url must evaluate to string, got ${typeof urlVal}`);
  }
  const url = parseUrl(urlVal);
  enforceDomainAllowlist(url, session.caps);

  // Resolve options.
  const opts = resolveHttpOptions(session, cmd.options);
  const timeoutMs = Math.min(
    opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    session.caps.maxExecTimeoutMs,
  );

  // Attach query string if --query was provided.
  if (opts.query) {
    const qp = typeof opts.query === "string"
      ? opts.query
      : new URLSearchParams(opts.query as Record<string, string>).toString();
    url.search = url.search ? `${url.search}&${qp}` : `?${qp}`;
  }

  // Body encoding.
  const headers = new Headers();
  for (const [k, v] of opts.headers) headers.set(k, v);
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const init: RequestInit = {
    method: cmd.method,
    headers,
    signal: ctrl.signal,
  };
  if (body !== undefined) init.body = body;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === "AbortError") {
      throw new A2EError("TIMEOUT", `HTTP request exceeded ${timeoutMs}ms`);
    }
    throw new A2EError(
      "UPSTREAM_ERROR",
      `HTTP fetch failed: ${(e as Error).message}`,
    );
  }
  clearTimeout(timer);

  // Read body with size cap.
  const raw = await readCappedBody(response, session.caps.maxResponseBytes);
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();

  if (response.status >= 400) {
    const preview = previewBytes(raw, BODY_PREVIEW_BYTES);
    throw new A2EError(
      "UPSTREAM_ERROR",
      `HTTP ${response.status} ${response.statusText}: ${preview}`,
    );
  }

  return decodeHttpBody(raw, ct);
}

interface ResolvedHttpOptions {
  headers: Array<[string, string]>;
  body?: RuntimeValue;
  query?: RuntimeValue;
  timeoutMs?: number;
}

function resolveHttpOptions(session: Session, opts: HttpOption[]): ResolvedHttpOptions {
  const out: ResolvedHttpOptions = { headers: [] };
  for (const opt of opts) {
    switch (opt.kind) {
      case "header": {
        const v = evalValue(opt.value as Value, { session });
        if (typeof v !== "string") {
          throw new A2EError("PARSE_ERROR", `--header must be string ("Name: value")`);
        }
        const colon = v.indexOf(":");
        if (colon < 0) {
          throw new A2EError("PARSE_ERROR", `--header must contain ':' separator: ${v}`);
        }
        out.headers.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()]);
        break;
      }
      case "body":    out.body    = evalValue(opt.value as Value, { session }); break;
      case "query":   out.query   = evalValue(opt.value as Value, { session }); break;
      case "timeout": out.timeoutMs = opt.duration.ms; break;
    }
  }
  return out;
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new A2EError("PARSE_ERROR", `invalid URL: ${raw}`);
  }
}

function enforceDomainAllowlist(url: URL, caps: CallCapabilities): void {
  const allowed = caps.httpDomainsAllowlist;
  if (allowed.includes("*")) return;
  if (!allowed.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`))) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      `HTTP domain '${url.hostname}' not in allowlist`,
    );
  }
}

async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      // Keep only what fits, drop the rest.
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function decodeHttpBody(raw: Uint8Array, contentType: string): RuntimeValue {
  if (contentType.includes("application/json")) {
    const text = Buffer.from(raw).toString("utf8");
    try {
      return JSON.parse(text) as RuntimeValue;
    } catch (e) {
      throw new A2EError(
        "UPSTREAM_ERROR",
        `Content-Type claimed JSON but parse failed: ${(e as Error).message}`,
      );
    }
  }
  if (contentType.startsWith("text/") || contentType.includes("charset")) {
    return Buffer.from(raw).toString("utf8");
  }
  // Unknown — return as record describing the payload rather than raw Buffer
  // so the canonical response serializes predictably.
  return {
    content_type: contentType || "application/octet-stream",
    bytes: raw.length,
    hex_preview: Buffer.from(raw).toString("hex").slice(0, 1024),
  };
}

function previewBytes(raw: Uint8Array, limit: number): string {
  const text = Buffer.from(raw).toString("utf8");
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

// =============================================================================
// CLI
// =============================================================================

export async function runCallCli(
  session: Session,
  cmd: CliCall,
): Promise<RuntimeValue> {
  const binary = cmd.binary;
  enforceBinaryAllowlist(binary, session.caps);

  const argv = resolveCliArgs(session, cmd.args);
  const absPath = session.caps.binaryPaths[binary] ?? binary;

  const { stdout, stderr, exitCode, timedOut } = await spawnCapped(
    absPath,
    argv,
    {
      PATH: session.caps.pathEnv,
    },
    session.caps.maxExecTimeoutMs,
    session.caps.maxResponseBytes,
  );

  if (timedOut) {
    throw new A2EError(
      "TIMEOUT",
      `CLI '${binary}' exceeded ${session.caps.maxExecTimeoutMs}ms (SIGKILL sent)`,
    );
  }
  if (exitCode !== 0) {
    const errPreview = Buffer.from(stderr).toString("utf8").slice(0, STDERR_PREVIEW_BYTES);
    throw new A2EError(
      "UPSTREAM_ERROR",
      `CLI '${binary}' exited ${exitCode}: ${errPreview}`,
    );
  }

  // Prefer string if UTF-8 decodable without replacement chars.
  const text = Buffer.from(stdout).toString("utf8");
  if (!text.includes("\uFFFD")) return text;
  return Buffer.from(stdout);
}

function enforceBinaryAllowlist(binary: string, caps: CallCapabilities): void {
  if (!caps.binariesAllowlist.includes(binary)) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      `CLI binary '${binary}' not in allowlist`,
    );
  }
}

function resolveCliArgs(session: Session, args: CliArg[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    switch (a.kind) {
      case "arg":
        out.push(toCliArgString(evalValue(a.value as Value, { session })));
        break;
      case "lflag":
        if (a.value === null) {
          out.push(`--${a.name}`);
        } else {
          // Use space-separated form consistently; spawn passes each as a distinct argv entry.
          out.push(`--${a.name}`);
          out.push(toCliArgString(evalValue(a.value as Value, { session })));
        }
        break;
      case "sflag":
        out.push(`-${a.letter}`);
        if (a.value !== null) {
          out.push(toCliArgString(evalValue(a.value as Value, { session })));
        }
        break;
    }
  }
  return out;
}

function toCliArgString(v: RuntimeValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Buffer.isBuffer(v)) {
    throw new A2EError("PARSE_ERROR", "cannot pass raw bytes as CLI argument");
  }
  // Objects/arrays serialize to JSON so downstream tools (jq, etc.) can consume.
  return JSON.stringify(v);
}

interface CappedResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  timedOut: boolean;
}

function spawnCapped(
  binary: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<CappedResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, argv, {
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutTotal = 0;
    let stderrTotal = 0;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    const clipStdout = (c: Buffer): void => {
      if (stdoutTotal >= maxResponseBytes) return;
      const remaining = maxResponseBytes - stdoutTotal;
      if (c.length > remaining) {
        stdoutChunks.push(c.subarray(0, remaining));
        stdoutTotal = maxResponseBytes;
        // Kill the subprocess as soon as stdout hits the cap. Without this,
        // a runaway CLI keeps writing to a full pipe until the timeout timer
        // fires — wasted CPU + risk of OS pipe buffer saturation. SIGKILL
        // skips any graceful cleanup the child might do; acceptable for
        // "you exceeded the output budget" scenarios.
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      } else {
        stdoutChunks.push(c);
        stdoutTotal += c.length;
      }
    };
    const clipStderr = (c: Buffer): void => {
      if (stderrTotal >= STDERR_PREVIEW_BYTES) return;
      const remaining = STDERR_PREVIEW_BYTES - stderrTotal;
      if (c.length > remaining) {
        stderrChunks.push(c.subarray(0, remaining));
        stderrTotal = STDERR_PREVIEW_BYTES;
      } else {
        stderrChunks.push(c);
        stderrTotal += c.length;
      }
    };

    child.stdout.on("data", clipStdout);
    child.stderr.on("data", clipStderr);
    child.on("error", () => {
      clearTimeout(killTimer);
      resolve({
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
        exitCode: -1,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });
}
