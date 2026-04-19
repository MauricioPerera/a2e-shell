/**
 * Capability policy resolution.
 *
 * Responsibilities:
 *   - Merge defaults (env) with per-session overrides.
 *   - Resolve binaries_allowlist to absolute paths by searching a candidate PATH.
 *   - Build the PATH string for subprocess env from that resolution.
 *   - Enforce binary allowlist at exec time.
 *
 * v1 does NOT wrap `curl` in a proxy. HTTP domain allowlist is stored for
 * downstream audit/inspection but not enforced at this layer. Deployments that
 * need hard egress control must run a2e-shell behind a network-namespace firewall.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { A2EError } from "../errors.js";
import type { CapabilitiesInput } from "../io/protocol.js";

export interface ResolvedPolicy {
  readonly mode: "unrestricted" | "bounded";
  readonly binaries_allowlist: readonly string[];
  readonly binary_paths: Readonly<Record<string, string>>;
  readonly path_env: string;
  readonly http_domains_allowlist: readonly string[];
  readonly max_exec_timeout_ms: number;
  readonly max_response_bytes: number;
  readonly max_session_ttl_s: number;
  readonly preview_bytes: number;
  readonly stderr_preview_bytes: number;
  readonly max_bindings: number;
  readonly max_binding_bytes: number;
  readonly max_total_binding_bytes: number;
  readonly max_transcript_bytes: number;
}

export interface ResolveInput {
  readonly mode: "unrestricted" | "bounded";
  readonly overrides?: CapabilitiesInput;
}

/** Bash builtins that carry no external binary. Always permitted. */
export const SAFE_BUILTINS: ReadonlySet<string> = new Set([
  "cd", "export", "unset", "echo", "printf", "pwd", "test", "[",
  "true", "false", ":", "read", "set", "shift", "return", "exit",
  "local", "declare", "readonly", "typeset", "alias", "unalias",
  "type", "command", "help", "times",
]);

/** Builtins that must NEVER be permitted — they allow code loading / eval. */
export const BLOCKED_BUILTINS: ReadonlySet<string> = new Set(["eval", "source", ".", "exec"]);

/**
 * True if the binary is invokable from within a session under `policy`:
 *   - Not a blocked builtin
 *   - Safe builtin OR explicitly in the allowlist
 * This is the canonical source of truth used by both runtime enforcement
 * and static reachability analysis over the catalog.
 */
export function isBinaryReachable(
  binary: string,
  policy: Pick<ResolvedPolicy, "binaries_allowlist">,
): boolean {
  if (BLOCKED_BUILTINS.has(binary)) return false;
  if (SAFE_BUILTINS.has(binary)) return true;
  return policy.binaries_allowlist.includes(binary);
}

const DEFAULT_CANDIDATE_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

function parseEnvList(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function findBinary(name: string, dirs: readonly string[]): string | null {
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

export function resolvePolicy(input: ResolveInput): ResolvedPolicy {
  const env = process.env;
  const defaultAllow = parseEnvList(env.A2E_DEFAULT_BINARIES_ALLOWLIST, [
    "curl", "jq", "gh", "aws", "kubectl", "git",
    "grep", "sed", "awk", "rg", "head", "tail",
    "wc", "cut", "sort", "uniq", "xargs",
    "pwd", "echo", "cat",
  ]);

  const overrideAllow = input.overrides?.binaries_allowlist;
  const binaries_allowlist = Array.from(
    new Set(overrideAllow ?? defaultAllow),
  );

  const binary_paths: Record<string, string> = {};
  const pathDirs = new Set<string>();
  for (const name of binaries_allowlist) {
    if (SAFE_BUILTINS.has(name) || BLOCKED_BUILTINS.has(name)) continue;
    const p = findBinary(name, DEFAULT_CANDIDATE_DIRS);
    if (p) {
      binary_paths[name] = p;
      pathDirs.add(path.dirname(p));
    }
  }
  const path_env = Array.from(pathDirs).join(":");

  const http_domains_allowlist = input.overrides?.http_domains_allowlist
    ?? parseEnvList(env.A2E_DEFAULT_HTTP_DOMAINS_ALLOWLIST, []);

  return {
    mode: input.mode,
    binaries_allowlist,
    binary_paths,
    path_env,
    http_domains_allowlist,
    max_exec_timeout_ms: input.overrides?.max_exec_timeout_ms
      ?? parseEnvInt(env.A2E_DEFAULT_MAX_EXEC_TIMEOUT_MS, 30_000),
    max_response_bytes: input.overrides?.max_response_bytes
      ?? parseEnvInt(env.A2E_DEFAULT_MAX_RESPONSE_BYTES, 262_144),
    max_session_ttl_s: input.overrides?.max_session_ttl_s
      ?? parseEnvInt(env.A2E_DEFAULT_MAX_SESSION_TTL_S, 3_600),
    preview_bytes: parseEnvInt(env.A2E_DEFAULT_PREVIEW_BYTES, 2_048),
    stderr_preview_bytes: parseEnvInt(env.A2E_DEFAULT_STDERR_PREVIEW_BYTES, 2_048),
    max_bindings: parseEnvInt(env.A2E_DEFAULT_MAX_BINDINGS, 128),
    max_binding_bytes: parseEnvInt(env.A2E_DEFAULT_MAX_BINDING_BYTES, 10_485_760),
    max_total_binding_bytes: parseEnvInt(env.A2E_DEFAULT_MAX_TOTAL_BINDING_BYTES, 52_428_800),
    max_transcript_bytes: parseEnvInt(env.A2E_DEFAULT_MAX_TRANSCRIPT_BYTES, 104_857_600),
  };
}

/**
 * Static analysis of the command string. Splits on shell operators (|, ||, &&,
 * ;, & at end-of-segment) and inspects argv[0] of each segment.
 *
 * Rules:
 *   - argv[0] in BLOCKED_BUILTINS → CAPABILITY_DENIED
 *   - argv[0] in SAFE_BUILTINS → OK
 *   - argv[0] in binaries_allowlist → OK
 *   - anything else → CAPABILITY_DENIED
 *
 * The parser is NOT a full shell grammar. It recognizes basic separators,
 * ignores content inside single/double quotes for operator detection, and
 * rejects command substitution `$( ... )` and backticks as structural hazards.
 */
export function enforceBinaryAllowlist(
  command: string,
  policy: ResolvedPolicy,
): void {
  if (/\$\(|`/.test(command)) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      "command substitution ($(...) / backticks) is not allowed",
    );
  }
  const segments = splitSegments(command);
  const allow = new Set(policy.binaries_allowlist);
  for (const seg of segments) {
    const token = firstToken(seg);
    if (!token) continue;
    if (BLOCKED_BUILTINS.has(token)) {
      throw new A2EError(
        "CAPABILITY_DENIED",
        `builtin '${token}' is blocked`,
      );
    }
    if (SAFE_BUILTINS.has(token)) continue;
    if (allow.has(token)) continue;
    throw new A2EError(
      "CAPABILITY_DENIED",
      `binary '${token}' not in allowlist`,
    );
  }
}

/** Split on |, ||, &&, ;, respecting single/double quotes. */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (quote) {
      buf += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === "|" || c === "&") {
      if (cmd[i + 1] === c) {
        out.push(buf);
        buf = "";
        i += 2;
        continue;
      }
      if (c === "|") {
        out.push(buf);
        buf = "";
        i++;
        continue;
      }
    }
    if (c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function firstToken(segment: string): string | null {
  // Strip leading redirections, env-var prefixes like `FOO=bar cmd ...`.
  let s = segment.trim();
  // skip leading `FOO=bar` assignments (inline env)
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  const m = s.match(/^(\S+)/);
  return m ? m[1]! : null;
}
