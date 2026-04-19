/**
 * Shared catalog cache.
 *
 * One bare mirror per repo_url (keyed by sha256(url)). Sessions receive a
 * worktree pointed at the requested commit SHA — shares git objects with the
 * mirror, materializes only its working files.
 *
 * Refresh policy: branch/tag refs refetch from origin if the cache has been
 * silent longer than `refreshSeconds`. SHA refs are immutable → zero-refresh
 * after first fetch.
 *
 * Concurrency: in-flight clone/refresh of the same repo collapses to a single
 * promise across concurrent callers in the same Node process. Multi-process
 * sharding is out of scope; deployments with N workers should pin sticky
 * session routing or use independent cache dirs.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { A2EError } from "../errors.js";
import type { Redactor } from "../credentials/redactor.js";
import { logger } from "../logging/logger.js";
import { catalogMirrorEvents, catalogMirrorsActive } from "../metrics/metrics.js";

const SHA_RE = /^[a-f0-9]{40}$/;

export interface CatalogCacheConfig {
  readonly enabled: boolean;
  readonly cacheDir: string;
  readonly refreshSeconds: number;
  /**
   * When true, the cache mirror is created with `--filter=blob:none`. Blobs
   * are fetched on-demand via the promisor remote when worktrees materialize
   * files. Significantly reduces disk + network for repos with heavy history.
   * Requires `uploadpack.allowFilter=true` on the server (GitHub/GitLab have it).
   */
  readonly filterBlobs: boolean;
  /**
   * Soft cap on the total cache directory size in bytes. The LRU sweeper runs
   * periodically; if total exceeds the cap, it evicts idle mirrors (no active
   * worktrees) in ascending last-access order until the total is under the cap.
   * `0` disables LRU eviction entirely (unbounded cache).
   */
  readonly maxBytes: number;
  /** Sweep interval in seconds for LRU + worktree prune. `0` disables. */
  readonly sweepIntervalSeconds: number;
}

/** Upper-bound on git subprocess calls run from sweep tasks. */
const SWEEP_GIT_TIMEOUT_MS = 10_000;
/** Cross-process lock settings for mirror creation. */
const MIRROR_LOCK_STALE_MS = 10 * 60_000; // 10 min — considered dead
const MIRROR_LOCK_POLL_MS = 100;
/** Transient git error strings that warrant a retry in resolveSha. */
const TRANSIENT_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /could not read from remote/i,
  /early EOF/i,
  /HTTP 5\d\d/i,
];

export interface MaterializeInput {
  readonly repo_url: string;
  readonly ref: string;
  readonly target_dir: string;
  /** Extra `-c ...` args prepended to every git invocation (e.g. http.extraheader). */
  readonly authArgs: readonly string[];
  /** Extra env vars merged into each git subprocess env (e.g. GIT_SSH_COMMAND). */
  readonly authEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly redactor: Redactor;
}

export interface MaterializeResult {
  readonly resolved_sha: string;
  readonly used_cache: boolean;
  readonly mirror_path: string | null;
}

export interface CatalogCache {
  materialize(input: MaterializeInput): Promise<MaterializeResult>;
  /** Run one LRU + prune pass. Exposed for tests and operator-triggered sweeps. */
  sweep(): Promise<SweepResult>;
  /** Stop background timers. Idempotent. */
  shutdown(): void;
}

export interface SweepResult {
  readonly total_bytes_before: number;
  readonly total_bytes_after: number;
  readonly mirrors_before: number;
  readonly mirrors_evicted: number;
  readonly mirrors_pruned: number;
}

export function createCatalogCache(cfg: CatalogCacheConfig): CatalogCache {
  const inFlight = new Map<string, Promise<void>>();

  async function ensureMirror(
    mirrorPath: string,
    repoUrl: string,
    authArgs: readonly string[],
    authEnv: Readonly<Record<string, string>>,
    timeoutMs: number,
    redactor: Redactor,
  ): Promise<boolean> {
    // Returns true if the mirror existed before this call (cache hit).
    const existed = fs.existsSync(mirrorPath);
    if (!existed) {
      // Cross-process lock: prevent two workers clone-racing the same repo.
      // The in-process inFlight map above only coalesces within this process.
      fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
      const lockPath = path.join(path.dirname(mirrorPath), ".lock");
      const releaseLock = await acquireLock(lockPath, timeoutMs);
      try {
        // Another worker may have finished cloning while we waited for the lock.
        if (fs.existsSync(mirrorPath)) {
          logger.info({
            event: "catalog.mirror.claimed",
            mirror_path: mirrorPath,
            note: "another worker created the mirror while we waited",
          });
          return true;
        }
        const cloneStart = Date.now();
        const cloneArgs = [...authArgs, "clone", "--bare"];
        if (cfg.filterBlobs) cloneArgs.push("--filter=blob:none");
        cloneArgs.push(repoUrl, mirrorPath);
        await runGit(cloneArgs, timeoutMs, undefined, redactor, authEnv);
        await markRefreshed(mirrorPath);
        // Seed the access marker now so LRU doesn't see stat() fallback on a
        // newly-cloned mirror before any materialize finishes.
        await touchAccess(mirrorPath);
        catalogMirrorEvents.inc({ event: "created" });
        catalogMirrorsActive.inc();
        logger.info({
          event: "catalog.mirror.created",
          mirror_path: mirrorPath,
          duration_ms: Date.now() - cloneStart,
          filter_blobs: cfg.filterBlobs,
        });
        return false;
      } finally {
        await releaseLock();
      }
    }
    if (await needsRefresh(mirrorPath, cfg.refreshSeconds)) {
      const refreshStart = Date.now();
      await runGit(
        [...authArgs, "remote", "update", "--prune"],
        timeoutMs,
        mirrorPath,
        redactor,
        authEnv,
      );
      await markRefreshed(mirrorPath);
      catalogMirrorEvents.inc({ event: "refreshed" });
      logger.info({
        event: "catalog.mirror.refreshed",
        mirror_path: mirrorPath,
        duration_ms: Date.now() - refreshStart,
      });
    }
    return true;
  }

  async function resolveSha(
    mirrorPath: string,
    ref: string,
    authArgs: readonly string[],
    authEnv: Readonly<Record<string, string>>,
    timeoutMs: number,
    redactor: Redactor,
  ): Promise<string> {
    if (SHA_RE.test(ref)) {
      try {
        await runGit(["rev-parse", "--verify", `${ref}^{commit}`], 5_000, mirrorPath, redactor);
      } catch {
        // SHA not reachable from mirror's refs: fetch it explicitly, with
        // retries for transient network errors.
        await withTransientRetry(
          () => runGit(
            [...authArgs, "fetch", "--depth=1", "origin", ref],
            timeoutMs,
            mirrorPath,
            redactor,
            authEnv,
          ),
          { op: "fetch", mirror: mirrorPath },
        );
      }
      return ref;
    }
    const out = await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      5_000,
      mirrorPath,
      redactor,
    );
    return out.trim();
  }

  async function addWorktree(
    mirrorPath: string,
    sha: string,
    targetDir: string,
    redactor: Redactor,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    await runGit(
      ["worktree", "add", "--detach", "--force", targetDir, sha],
      30_000,
      mirrorPath,
      redactor,
    );
  }

  async function materializeDirect(input: MaterializeInput): Promise<MaterializeResult> {
    // No shared cache: each session clones directly, no mirror reuse.
    const filterFlag = cfg.filterBlobs ? ["--filter=blob:none"] : [];
    if (SHA_RE.test(input.ref)) {
      fs.mkdirSync(input.target_dir, { recursive: true });
      await runGit([...input.authArgs, "init", "-q"], 5_000, input.target_dir, input.redactor);
      await runGit([...input.authArgs, "remote", "add", "origin", input.repo_url], 5_000, input.target_dir, input.redactor);
      await runGit(
        [...input.authArgs, "fetch", "--depth=1", ...filterFlag, "origin", input.ref],
        input.timeoutMs,
        input.target_dir,
        input.redactor,
        input.authEnv,
      );
      await runGit([...input.authArgs, "checkout", "--detach", input.ref], 10_000, input.target_dir, input.redactor);
    } else {
      await runGit(
        [...input.authArgs, "clone", "--depth=1", ...filterFlag, "--single-branch", "--branch", input.ref, input.repo_url, input.target_dir],
        input.timeoutMs,
        undefined,
        input.redactor,
        input.authEnv,
      );
    }
    const sha = (await runGit(["rev-parse", "HEAD"], 5_000, input.target_dir, input.redactor)).trim();
    return { resolved_sha: sha, used_cache: false, mirror_path: null };
  }

  async function materializeViaMirror(input: MaterializeInput): Promise<MaterializeResult> {
    const repoKey = crypto.createHash("sha256").update(input.repo_url).digest("hex").slice(0, 24);
    const mirrorPath = path.join(cfg.cacheDir, repoKey, "mirror.git");

    // Coalesce concurrent ensure/resolve for the same repo.
    let existedBefore = false;
    const key = mirrorPath;
    const existingPromise = inFlight.get(key);
    if (existingPromise) {
      await existingPromise;
      existedBefore = true;
    } else {
      const p = (async () => {
        existedBefore = await ensureMirror(
          mirrorPath,
          input.repo_url,
          input.authArgs,
          input.authEnv,
          input.timeoutMs,
          input.redactor,
        );
      })();
      inFlight.set(key, p);
      try {
        await p;
      } finally {
        inFlight.delete(key);
      }
    }

    const sha = await resolveSha(mirrorPath, input.ref, input.authArgs, input.authEnv, input.timeoutMs, input.redactor);
    await addWorktree(mirrorPath, sha, input.target_dir, input.redactor);
    await touchAccess(mirrorPath);
    return { resolved_sha: sha, used_cache: existedBefore, mirror_path: mirrorPath };
  }

  /**
   * Sweep pass with inFlight awareness:
   *   1. Skip mirrors currently being cloned/refreshed (race-free eviction).
   *   2. Worktree prune every non-in-flight mirror.
   *   3. Measure sizes; evict idle (no live worktrees + not in-flight) oldest-
   *      first until total is under maxBytes.
   *   4. Re-check `hasLiveWorktrees` immediately before rm to minimize the
   *      window in which a session could materialize a worktree we're about
   *      to delete.
   */
  async function doSweepInner(): Promise<SweepResult> {
    const mirrors = (await listMirrors(cfg.cacheDir))
      .filter((m) => !inFlight.has(m));
    let pruned = 0;
    for (const m of mirrors) {
      if (await pruneOne(m)) {
        pruned++;
        catalogMirrorEvents.inc({ event: "pruned" });
      }
    }
    const withStats = await Promise.all(
      mirrors.map(async (m) => ({
        path: m,
        size: await dirSizeBytes(m).catch(() => 0),
        lastAccess: await readLastAccess(m),
        hasLiveWorktrees: await hasLiveWorktrees(m),
      })),
    );
    const totalBefore = withStats.reduce((a, m) => a + m.size, 0);

    let evicted = 0;
    let totalAfter = totalBefore;
    if (cfg.maxBytes > 0 && totalBefore > cfg.maxBytes) {
      const evictable = withStats
        .filter((m) => !m.hasLiveWorktrees)
        .sort((a, b) => a.lastAccess - b.lastAccess);
      for (const m of evictable) {
        if (totalAfter <= cfg.maxBytes) break;
        // Race-tightening re-check: inFlight AND live-worktrees both revalidated.
        if (inFlight.has(m.path)) continue;
        if (await hasLiveWorktrees(m.path)) continue;
        try {
          await fsp.rm(path.dirname(m.path), { recursive: true, force: true });
          totalAfter -= m.size;
          evicted++;
          catalogMirrorsActive.dec();
          catalogMirrorEvents.inc({ event: "evicted" });
          logger.info({
            event: "catalog.mirror.evicted",
            mirror_path: m.path,
            size_bytes: m.size,
            last_access_ms_ago: Date.now() - m.lastAccess,
          });
        } catch (e) {
          logger.warn({
            event: "catalog.mirror.evict_failed",
            mirror_path: m.path,
            err: String(e),
          });
        }
      }
    }
    if (pruned > 0 || evicted > 0) {
      logger.info({
        event: "catalog.sweep",
        mirrors_before: mirrors.length,
        mirrors_pruned: pruned,
        mirrors_evicted: evicted,
        total_bytes_before: totalBefore,
        total_bytes_after: totalAfter,
      });
    }
    return {
      total_bytes_before: totalBefore,
      total_bytes_after: totalAfter,
      mirrors_before: mirrors.length,
      mirrors_evicted: evicted,
      mirrors_pruned: pruned,
    };
  }

  // Seed the active-mirrors gauge from disk so restarts don't under-report.
  if (cfg.enabled) {
    listMirrors(cfg.cacheDir)
      .then((ms) => catalogMirrorsActive.set(ms.length))
      .catch(() => { /* best-effort */ });
  }

  let sweepTimer: NodeJS.Timeout | null = null;
  if (cfg.enabled && cfg.sweepIntervalSeconds > 0) {
    sweepTimer = setInterval(() => {
      doSweepInner().catch((e) => {
        logger.warn({ event: "catalog.sweep.failed", err: String(e) });
      });
    }, cfg.sweepIntervalSeconds * 1000);
    sweepTimer.unref();
  }

  return {
    async materialize(input) {
      if (!cfg.enabled) return materializeDirect(input);
      return materializeViaMirror(input);
    },
    async sweep() {
      return cfg.enabled ? doSweepInner() : {
        total_bytes_before: 0,
        total_bytes_after: 0,
        mirrors_before: 0,
        mirrors_evicted: 0,
        mirrors_pruned: 0,
      };
    },
    shutdown() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}

async function listMirrors(cacheDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const mirror = path.join(cacheDir, e.name, "mirror.git");
      if (fs.existsSync(mirror)) out.push(mirror);
    }
    return out;
  } catch {
    return [];
  }
}

async function pruneOne(mirrorPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["-C", mirrorPath, "worktree", "prune"], {
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const t = setTimeout(() => child.kill("SIGKILL"), SWEEP_GIT_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
    child.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

async function hasLiveWorktrees(mirrorPath: string): Promise<boolean> {
  const worktreesDir = path.join(mirrorPath, "worktrees");
  try {
    const entries = await fsp.readdir(worktreesDir);
    // After `git worktree prune`, only live worktrees remain.
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function dirSizeBytes(p: string): Promise<number> {
  let total = 0;
  const stack: string[] = [p];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const ep = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(ep);
      else if (e.isFile()) {
        try { total += (await fsp.stat(ep)).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/**
 * Cross-process advisory lock via exclusive file creation.
 *
 * Creates `<lockPath>` with O_CREAT|O_EXCL. On EEXIST, polls every 100ms until
 * either the lock file disappears or its mtime exceeds MIRROR_LOCK_STALE_MS
 * (holder crashed). Stale locks are stolen with a warning.
 *
 * Multi-process safe because `open(path, 'wx')` is atomic at the OS layer.
 */
async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fh = await fsp.open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      return async () => {
        try { await fsp.unlink(lockPath); } catch { /* already gone */ }
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      // Check for stale holder.
      try {
        const st = await fsp.stat(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > MIRROR_LOCK_STALE_MS) {
          logger.warn({
            event: "catalog.lock.stale_steal",
            lock_path: lockPath,
            age_ms: ageMs,
          });
          await fsp.unlink(lockPath).catch(() => { /* raced */ });
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat; retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new A2EError(
          "TIMEOUT",
          `could not acquire mirror lock within ${timeoutMs}ms: ${lockPath}`,
          500,
        );
      }
      await new Promise((r) => setTimeout(r, MIRROR_LOCK_POLL_MS));
    }
  }
}

async function touchAccess(mirrorPath: string): Promise<void> {
  const marker = path.join(mirrorPath, ".a2e-last-access");
  const now = new Date();
  try {
    await fsp.writeFile(marker, now.toISOString(), "utf8");
  } catch { /* best-effort */ }
}

async function readLastAccess(mirrorPath: string): Promise<number> {
  const marker = path.join(mirrorPath, ".a2e-last-access");
  try {
    const st = await fsp.stat(marker);
    return st.mtimeMs;
  } catch {
    // Fall back to mirror dir mtime if access marker never got written.
    try {
      return (await fsp.stat(mirrorPath)).mtimeMs;
    } catch {
      return 0;
    }
  }
}

async function withTransientRetry<T>(
  op: () => Promise<T>,
  ctx: { op: string; mirror: string },
): Promise<T> {
  const delays = [100, 500, 2_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === delays.length) throw e;
      logger.warn({
        event: "catalog.transient_retry",
        op: ctx.op,
        mirror_path: ctx.mirror,
        attempt: attempt + 1,
        next_delay_ms: delays[attempt],
      });
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
}

async function needsRefresh(mirrorPath: string, refreshSeconds: number): Promise<boolean> {
  const marker = path.join(mirrorPath, ".a2e-last-refresh");
  try {
    const st = await fsp.stat(marker);
    const ageSec = (Date.now() - st.mtimeMs) / 1000;
    return ageSec > refreshSeconds;
  } catch {
    return true;
  }
}

async function markRefreshed(mirrorPath: string): Promise<void> {
  const marker = path.join(mirrorPath, ".a2e-last-refresh");
  await fsp.writeFile(marker, new Date().toISOString(), "utf8");
}

async function runGit(
  args: readonly string[],
  timeoutMs: number,
  cwd: string | undefined,
  redactor: Redactor,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new A2EError("UPSTREAM_ERROR", `git spawn failed: ${err.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const verb = firstNonConfigArg(args);
      if (timedOut) {
        reject(new A2EError("TIMEOUT", `git ${verb} exceeded ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const clean = redactor.redact(Buffer.concat(stderr));
        reject(new A2EError(
          "UPSTREAM_ERROR",
          `git ${verb} exit ${code}: ${Buffer.from(clean).toString("utf8").trim()}`,
          500,
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function firstNonConfigArg(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") { i++; continue; }
    return args[i] ?? "?";
  }
  return "?";
}
