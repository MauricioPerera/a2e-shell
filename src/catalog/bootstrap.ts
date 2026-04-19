/**
 * Catalog bootstrap — materialize index + content trees for a session.
 *
 * Delegates the clone/worktree mechanics to the CatalogCache; this module
 * owns auth header construction, manifest parsing, and reachability.
 *
 * Layout on disk:
 *   <targetRoot>/index/     — index branch working tree (manifest + partitions)
 *   <targetRoot>/content/   — content branch working tree
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { A2EError } from "../errors.js";
import type { CatalogSpec, CatalogInfo, CatalogAuthSpec } from "../io/protocol.js";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import type { Redactor } from "../credentials/redactor.js";
import type { CatalogCache } from "./cache.js";
import { computeReachability, writeReachability } from "./reachability.js";

export interface GitAuthInvocation {
  readonly extraArgs: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>>;
}

export interface BootstrapInput {
  readonly spec: CatalogSpec;
  readonly targetRoot: string;
  readonly timeoutMs: number;
  readonly policy: Pick<ResolvedPolicy, "binaries_allowlist">;
  readonly redactor: Redactor;
  readonly cache: CatalogCache;
}

export async function bootstrapCatalog(input: BootstrapInput): Promise<CatalogInfo> {
  const indexDir = path.join(input.targetRoot, "index");
  const contentDir = path.join(input.targetRoot, "content");
  const auth = buildGitAuth(input.spec.auth);

  fs.mkdirSync(input.targetRoot, { recursive: true });

  // Promise.allSettled — ensure BOTH operations fully settle before we decide.
  // Plain Promise.all rejects fast on first failure but lets the sibling keep
  // writing to disk, racing any cleanup from the caller. allSettled means we
  // always know everything has finished before we report status.
  const settled = await Promise.allSettled([
    input.cache.materialize({
      repo_url: input.spec.repo_url,
      ref: input.spec.index_ref,
      target_dir: indexDir,
      authArgs: auth.extraArgs,
      authEnv: auth.extraEnv,
      timeoutMs: input.timeoutMs,
      redactor: input.redactor,
    }),
    input.cache.materialize({
      repo_url: input.spec.repo_url,
      ref: input.spec.content_ref,
      target_dir: contentDir,
      authArgs: auth.extraArgs,
      authEnv: auth.extraEnv,
      timeoutMs: input.timeoutMs,
      redactor: input.redactor,
    }),
  ]);
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) {
    throw rejected.reason;
  }
  const [indexSettled, contentSettled] = settled;
  if (indexSettled?.status !== "fulfilled" || contentSettled?.status !== "fulfilled") {
    throw new A2EError("INTERNAL", "bootstrap: unexpected settle state", 500);
  }
  const indexRes = indexSettled.value;
  const contentRes = contentSettled.value;

  const manifestPath = path.join(indexDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new A2EError(
      "UPSTREAM_ERROR",
      `catalog: index ref '${input.spec.index_ref}' has no manifest.json at root`,
      500,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    source_sha?: string;
  };
  const manifestSourceSha = manifest.source_sha ?? "";
  if (!/^[a-f0-9]{40}$/.test(manifestSourceSha)) {
    throw new A2EError(
      "UPSTREAM_ERROR",
      `catalog: manifest.source_sha is missing or malformed`,
      500,
    );
  }

  const report = computeReachability({ indexDir, policy: input.policy });
  const reportPath = writeReachability(input.targetRoot, report);

  // Both materializations use the same mirror (if cache enabled); take either.
  const mirror_path = indexRes.mirror_path ?? contentRes.mirror_path ?? null;

  return {
    index_dir: indexDir,
    content_dir: contentDir,
    index_sha: indexRes.resolved_sha,
    content_sha: contentRes.resolved_sha,
    manifest_source_sha: manifestSourceSha,
    in_sync: contentRes.resolved_sha === manifestSourceSha,
    reachability: {
      total: report.summary.total,
      reachable: report.summary.reachable,
      unreachable: report.summary.unreachable,
      report_path: reportPath,
    },
    mirror_path,
  };
}

/**
 * Resolve the auth spec into git invocation args + env. Reads all material
 * (tokens, key paths) from process.env — never from the request body.
 * Throws CAPABILITY_DENIED when a referenced env var is missing or a
 * referenced file does not exist.
 */
export function buildGitAuth(spec: CatalogAuthSpec | undefined): GitAuthInvocation {
  const empty: GitAuthInvocation = { extraArgs: [], extraEnv: {} };
  if (!spec) return empty;

  if (spec.type === "token") {
    const token = process.env[spec.env_var];
    if (!token) {
      throw new A2EError(
        "CAPABILITY_DENIED",
        `catalog: auth env var '${spec.env_var}' is not set on the server`,
        403,
      );
    }
    const basic = Buffer.from(`${spec.username}:${token}`).toString("base64");
    return {
      extraArgs: ["-c", `http.extraheader=Authorization: Basic ${basic}`],
      extraEnv: {},
    };
  }

  if (spec.type === "ssh_key") {
    const keyPath = process.env[spec.key_path_env_var];
    if (!keyPath) {
      throw new A2EError(
        "CAPABILITY_DENIED",
        `catalog: ssh key env var '${spec.key_path_env_var}' is not set on the server`,
        403,
      );
    }
    if (!fs.existsSync(keyPath)) {
      throw new A2EError(
        "CAPABILITY_DENIED",
        `catalog: ssh key file does not exist (path from ${spec.key_path_env_var})`,
        403,
      );
    }

    let knownHostsPath: string | undefined;
    if (spec.known_hosts_env_var) {
      const raw = process.env[spec.known_hosts_env_var];
      if (!raw) {
        throw new A2EError(
          "CAPABILITY_DENIED",
          `catalog: known_hosts env var '${spec.known_hosts_env_var}' is not set on the server`,
          403,
        );
      }
      if (!fs.existsSync(raw)) {
        throw new A2EError(
          "CAPABILITY_DENIED",
          `catalog: known_hosts file does not exist (path from ${spec.known_hosts_env_var})`,
          403,
        );
      }
      knownHostsPath = raw;
    }

    const sshParts = [
      "ssh",
      "-i", shellEscape(keyPath),
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      ...(knownHostsPath
        ? ["-o", `UserKnownHostsFile=${shellEscape(knownHostsPath)}`, "-o", "StrictHostKeyChecking=yes"]
        : ["-o", "StrictHostKeyChecking=accept-new"]),
    ];
    return {
      extraArgs: [],
      extraEnv: { GIT_SSH_COMMAND: sshParts.join(" ") },
    };
  }

  return empty;
}

/** Minimal shell quoting for paths that may contain spaces. SSH parses the
 * command string, so any whitespace-bearing path needs quoting. Single-quote
 * wrapping plus embedded-quote escaping is safe against all shell-meaningful
 * characters. */
function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_\-./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
