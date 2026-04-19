/**
 * Reachability analysis over a catalog.
 *
 * Given an already-cloned catalog index (manifest.json + partitions) and the
 * session's policy, determine which entries are invokable with the session's
 * current capabilities.
 *
 * Only the `skills` category has executable `requires`; docs/prompts/templates
 * are passive content and are always reachable if present.
 *
 * Writes `reachability.json` at the catalog root, read-only from the agent's
 * perspective. Never mutates the cloned index files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isBinaryReachable, type ResolvedPolicy } from "../capabilities/policy.js";

export interface ReachabilityEntry {
  readonly reachable: boolean;
  readonly missing_binaries?: readonly string[];
}

export interface ReachabilityReport {
  readonly schema_version: "1.0";
  readonly computed_at: string;
  readonly by_category: Readonly<Record<string, Readonly<Record<string, ReachabilityEntry>>>>;
  readonly summary: { readonly total: number; readonly reachable: number; readonly unreachable: number };
}

export interface ReachabilitySummary {
  readonly total: number;
  readonly reachable: number;
  readonly unreachable: number;
}

export interface ComputeInput {
  readonly indexDir: string;
  readonly policy: Pick<ResolvedPolicy, "binaries_allowlist">;
}

export function computeReachability(input: ComputeInput): ReachabilityReport {
  const manifestPath = path.join(input.indexDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    categories: Record<string, { path: string }>;
  };

  const byCategory: Record<string, Record<string, ReachabilityEntry>> = {};
  let total = 0;
  let reachable = 0;

  for (const [category, ref] of Object.entries(manifest.categories)) {
    const partitionPath = path.join(input.indexDir, ref.path);
    if (!fs.existsSync(partitionPath)) continue;
    const partition = JSON.parse(fs.readFileSync(partitionPath, "utf8")) as {
      entries: Record<string, { requires?: string[] }>;
    };
    const perEntry: Record<string, ReachabilityEntry> = {};
    for (const [name, entry] of Object.entries(partition.entries)) {
      total++;
      const requires = entry.requires ?? [];
      if (requires.length === 0) {
        perEntry[name] = { reachable: true };
        reachable++;
        continue;
      }
      const missing = requires.filter((b) => !isBinaryReachable(b, input.policy));
      if (missing.length === 0) {
        perEntry[name] = { reachable: true };
        reachable++;
      } else {
        perEntry[name] = { reachable: false, missing_binaries: missing };
      }
    }
    byCategory[category] = perEntry;
  }

  return {
    schema_version: "1.0",
    computed_at: new Date().toISOString(),
    by_category: byCategory,
    summary: { total, reachable, unreachable: total - reachable },
  };
}

export function writeReachability(catalogRoot: string, report: ReachabilityReport): string {
  const out = path.join(catalogRoot, "reachability.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  return out;
}
