import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createCatalogCache } from "../../src/catalog/cache.js";
import { buildRedactor } from "../../src/credentials/redactor.js";

function sh(cmd: string, cwd?: string): string {
  return execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

function makeBareRepo(base: string): { url: string; sha: string } {
  const repoDir = path.join(base, "src.git");
  fs.mkdirSync(repoDir);
  // core.autocrlf=false keeps byte-exact line endings round-tripping through
  // checkout on Windows CI / dev boxes where the git global default converts.
  sh("git init -q -b main && git config core.autocrlf false && git config user.name x && git config user.email x@y", repoDir);
  fs.writeFileSync(path.join(repoDir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", repoDir);
  const sha = sh("git rev-parse HEAD", repoDir);
  return { url: `file://${repoDir}`, sha };
}

const redactor = buildRedactor([], {});

describe("createCatalogCache (shared-mirror mode)", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("first call populates mirror; second call reuses it", async () => {
    const { url, sha } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: false, maxBytes: 0, sweepIntervalSeconds: 0,
    });

    const t1 = path.join(base, "s1");
    const r1 = await cache.materialize({
      repo_url: url, ref: "main", target_dir: t1,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    expect(r1.used_cache).toBe(false);
    expect(r1.resolved_sha).toBe(sha);
    expect(fs.existsSync(path.join(t1, "a.txt"))).toBe(true);

    const t2 = path.join(base, "s2");
    const r2 = await cache.materialize({
      repo_url: url, ref: "main", target_dir: t2,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    expect(r2.used_cache).toBe(true);
    expect(r2.resolved_sha).toBe(sha);
    expect(fs.existsSync(path.join(t2, "a.txt"))).toBe(true);
    expect(r1.mirror_path).toBe(r2.mirror_path);
  });

  it("resolves SHA refs directly from the mirror", async () => {
    const { url, sha } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: false, maxBytes: 0, sweepIntervalSeconds: 0,
    });

    const t = path.join(base, "s1");
    const r = await cache.materialize({
      repo_url: url, ref: sha, target_dir: t,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    expect(r.resolved_sha).toBe(sha);
    expect(r.used_cache).toBe(false);
  });

  it("coalesces concurrent materialize calls for the same repo", async () => {
    const { url } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: false, maxBytes: 0, sweepIntervalSeconds: 0,
    });

    const [r1, r2, r3] = await Promise.all([
      cache.materialize({ repo_url: url, ref: "main", target_dir: path.join(base, "a"), authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor }),
      cache.materialize({ repo_url: url, ref: "main", target_dir: path.join(base, "b"), authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor }),
      cache.materialize({ repo_url: url, ref: "main", target_dir: path.join(base, "c"), authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor }),
    ]);
    expect(r1.mirror_path).toBe(r2.mirror_path);
    expect(r2.mirror_path).toBe(r3.mirror_path);
    // Exactly one of the three observed a cold mirror (no prior existence).
    const cold = [r1, r2, r3].filter((r) => !r.used_cache).length;
    expect(cold).toBeGreaterThanOrEqual(1);
  });

  it("filterBlobs=true makes the mirror a partial (promisor) repo", async () => {
    const { url } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: true, maxBytes: 0, sweepIntervalSeconds: 0,
    });

    const t = path.join(base, "s1");
    await cache.materialize({
      repo_url: url, ref: "main", target_dir: t,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });

    // The mirror must be configured as a promisor with blob:none filter.
    const mirror = fs.readdirSync(path.join(base, "cache"))
      .map((d) => path.join(base, "cache", d, "mirror.git"))
      .find((p) => fs.existsSync(p));
    expect(mirror).toBeDefined();
    const filter = sh(`git config --get remote.origin.partialclonefilter`, mirror!);
    expect(filter).toBe("blob:none");
    const promisor = sh(`git config --get remote.origin.promisor`, mirror!);
    expect(promisor).toBe("true");

    // Worktree still materializes the file (promisor fetches the blob on demand).
    // Normalize CRLF → LF because the user's global core.autocrlf may convert
    // on checkout; the test only cares that the blob content round-tripped.
    const got = fs.readFileSync(path.join(t, "a.txt"), "utf8").replace(/\r\n/g, "\n");
    expect(got).toBe("hello\n");
  });

  it("sweep: evicts idle mirrors when total exceeds maxBytes", async () => {
    const { url } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: false,
      maxBytes: 1, // force eviction
      sweepIntervalSeconds: 0,
    });
    const wt = path.join(base, "s1");
    await cache.materialize({
      repo_url: url, ref: "main", target_dir: wt,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    // Remove worktree so the mirror becomes evictable.
    fs.rmSync(wt, { recursive: true, force: true });

    const r = await cache.sweep();
    expect(r.mirrors_evicted).toBeGreaterThan(0);
    expect(r.total_bytes_after).toBeLessThan(r.total_bytes_before);
    cache.shutdown();
  });

  it("sweep: does NOT evict mirrors with live worktrees", async () => {
    const { url } = makeBareRepo(base);
    const cache = createCatalogCache({
      enabled: true,
      cacheDir: path.join(base, "cache"),
      refreshSeconds: 3600,
      filterBlobs: false,
      maxBytes: 1,
      sweepIntervalSeconds: 0,
    });
    const wt = path.join(base, "s1");
    await cache.materialize({
      repo_url: url, ref: "main", target_dir: wt,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    const r = await cache.sweep();
    expect(r.mirrors_evicted).toBe(0);
    cache.shutdown();
  });

  it("disabled mode produces no mirror", async () => {
    const { url, sha } = makeBareRepo(base);
    const cacheDir = path.join(base, "cache");
    const cache = createCatalogCache({
      enabled: false,
      cacheDir,
      refreshSeconds: 3600,
      filterBlobs: false, maxBytes: 0, sweepIntervalSeconds: 0,
    });

    const t = path.join(base, "s1");
    const r = await cache.materialize({
      repo_url: url, ref: "main", target_dir: t,
      authArgs: [], authEnv: {}, timeoutMs: 30_000, redactor,
    });
    expect(r.resolved_sha).toBe(sha);
    expect(r.mirror_path).toBeNull();
    expect(r.used_cache).toBe(false);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(path.join(t, "a.txt"))).toBe(true);
  });
});
