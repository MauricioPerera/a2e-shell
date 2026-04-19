/**
 * Shared validators for session state that arrives via request body.
 * Session creation and PATCH routes both delegate here so the security
 * envelope is identical regardless of entry point.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { A2EError } from "../errors.js";

/**
 * Env vars whose values, if forwarded to a subprocess, can meaningfully shift
 * execution: library preload hijacks, PATH shadowing, shell-parsing surprises.
 * Also includes A2E_CATALOG_* so the LLM can't shadow the catalog paths.
 */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_BIND_NOW",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONSTARTUP",
  "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_AUTH_SOCK",
  "IFS", "CDPATH", "BASH_ENV", "ENV",
  "A2E_CATALOG_INDEX", "A2E_CATALOG_CONTENT", "A2E_CATALOG_REACHABILITY",
]);

/** True if the env var name (case-insensitive) is in RESERVED_ENV_KEYS. */
export function isReservedEnvKey(name: string): boolean {
  return RESERVED_ENV_KEYS.has(name.toUpperCase());
}

export const MAX_ENV_ENTRIES = 64;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws PARSE_ERROR on any invalid key. Accepts undefined as a no-op. */
export function validateEnvMap(env: Readonly<Record<string, string>> | undefined): void {
  if (!env) return;
  const keys = Object.keys(env);
  if (keys.length > MAX_ENV_ENTRIES) {
    throw new A2EError(
      "PARSE_ERROR",
      `env: too many entries (${keys.length} > ${MAX_ENV_ENTRIES})`,
      400,
    );
  }
  for (const k of keys) {
    validateEnvKey(k);
  }
}

export function validateEnvKey(k: string): void {
  if (!ENV_NAME_RE.test(k)) {
    throw new A2EError("PARSE_ERROR", `env: '${k}' is not a valid env var name`, 400);
  }
  if (RESERVED_ENV_KEYS.has(k.toUpperCase())) {
    throw new A2EError("PARSE_ERROR", `env: '${k}' is reserved and cannot be set via request`, 400);
  }
}

export function validateUnsetList(keys: readonly string[] | undefined): void {
  if (!keys) return;
  if (keys.length > MAX_ENV_ENTRIES) {
    throw new A2EError(
      "PARSE_ERROR",
      `env unset: too many entries (${keys.length} > ${MAX_ENV_ENTRIES})`,
      400,
    );
  }
  for (const k of keys) {
    if (!ENV_NAME_RE.test(k)) {
      throw new A2EError("PARSE_ERROR", `env unset: '${k}' is not a valid env var name`, 400);
    }
    // Unsetting a reserved key is a no-op for us (we never allowed it) but
    // refuse the request so the caller's intent can't masquerade as success.
    if (RESERVED_ENV_KEYS.has(k.toUpperCase())) {
      throw new A2EError("PARSE_ERROR", `env unset: '${k}' is reserved`, 400);
    }
  }
}

/**
 * Validate a requested cwd:
 *   - must be absolute
 *   - must exist and be a directory
 *   - must NOT resolve through a symlink (request path == realpath)
 *   - resolved path must lie within an allowed prefix (inclusive).
 *
 * Allowed prefixes are normalized before comparison. Any prefix mismatch
 * triggers PARSE_ERROR so the caller can correct the request.
 *
 * The symlink check specifically defeats:
 *   ln -s /etc <sessions>/safe-dir; then requesting "<sessions>/safe-dir" as cwd.
 */
export async function validateCwd(
  requested: string,
  allowedPrefixes: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(requested)) {
    throw new A2EError("PARSE_ERROR", "cwd must be an absolute path", 400);
  }
  let resolved: string;
  try {
    resolved = await fsp.realpath(requested);
  } catch (e) {
    throw new A2EError(
      "PARSE_ERROR",
      `cwd cannot be accessed: ${(e as Error).message}`,
      400,
    );
  }
  if (resolved !== path.resolve(requested)) {
    throw new A2EError(
      "PARSE_ERROR",
      "cwd resolves through a symlink; use the canonical path instead",
      400,
    );
  }
  const st = await fsp.stat(resolved);
  if (!st.isDirectory()) {
    throw new A2EError("PARSE_ERROR", "cwd is not a directory", 400);
  }
  if (allowedPrefixes.length > 0 && !isUnderAnyPrefix(resolved, allowedPrefixes)) {
    throw new A2EError(
      "PARSE_ERROR",
      "cwd is outside the allowed prefixes for this deployment",
      400,
    );
  }
  return resolved;
}

function isUnderAnyPrefix(p: string, prefixes: readonly string[]): boolean {
  for (const raw of prefixes) {
    const prefix = path.resolve(raw);
    if (p === prefix || p.startsWith(prefix + path.sep)) return true;
  }
  return false;
}
