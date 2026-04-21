/**
 * `npm:<pkg>@<ver>` command-sugar resolver (RFC 003, v1.4).
 *
 * An MCP stdio spec may set `command: "npm:@scope/name@1.2.3"` instead of
 * writing out `npx` + args manually. This resolver expands the shorthand
 * into the canonical spawn tuple:
 *
 *   command : <absolute path of npx from policy.binary_paths>
 *   args    : ["-y", "<pkg>@<ver>", ...spec.args]
 *
 * Validation is strict (see RFC 003 §Grammar): every accepted input pins
 * one immutable artifact. Tags, ranges, or missing-version forms are
 * rejected with VALIDATION_ERROR so drift never enters the session spec.
 *
 * If `npx` is not in the session's binary allowlist the resolver throws
 * CAPABILITY_DENIED — no silent fallback, no implicit install.
 */

import { A2EError } from "../errors.js";
import { logger } from "../logging/logger.js";
import type { ResolvedPolicy } from "../capabilities/policy.js";

/**
 * Matches `npm:<pkg>@<version>` where pkg is an npm package name
 * (scoped or unscoped) and version is exact semver 2.0.
 *
 * Groups:
 *   1 — package name (with optional @scope/ prefix)
 *   2 — semver version (x.y.z with optional -prerelease and +build)
 */
const NPM_RE = /^npm:(@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export interface NpmResolution {
  /** Absolute path to the `npx` binary from the policy. */
  readonly resolvedCommand: string;
  /** Args to prepend before the caller-supplied `spec.args`. */
  readonly prependArgs: readonly string[];
  /** Parsed package name (with @scope/ prefix if scoped). */
  readonly packageName: string;
  /** Parsed pinned version. */
  readonly version: string;
}

/**
 * True iff the raw command string uses the `npm:` sugar. Callers should
 * check this before the binary-allowlist fallback path.
 */
export function isNpmCommand(command: string): boolean {
  return command.startsWith("npm:");
}

/**
 * Expand `npm:<pkg>@<ver>` into the concrete spawn tuple.
 *
 * Throws `PARSE_ERROR` (400) on grammar failure, `CAPABILITY_DENIED`
 * (403) if `npx` is not allow-listed. Never touches the network or the
 * filesystem beyond reading `policy.binary_paths`.
 */
export function resolveNpmCommand(
  command: string,
  policy: ResolvedPolicy,
): NpmResolution {
  const m = NPM_RE.exec(command);
  if (!m) {
    throw new A2EError(
      "PARSE_ERROR",
      `mcp command '${command}' is not a valid npm: sugar — expected 'npm:<pkg>@<x.y.z>' with an exact pinned semver (no tags, no ranges)`,
      400,
    );
  }
  const packageName = m[1]!;
  const version = m[2]!;

  const npxPath = policy.binary_paths["npx"];
  if (!npxPath) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      "mcp 'npm:' sugar requires 'npx' in binaries_allowlist",
      403,
    );
  }

  logger.info({
    event: "mcp.stdio.npm_sugar_resolved",
    package: packageName,
    version,
  });

  return {
    resolvedCommand: npxPath,
    prependArgs: ["-y", `${packageName}@${version}`],
    packageName,
    version,
  };
}
