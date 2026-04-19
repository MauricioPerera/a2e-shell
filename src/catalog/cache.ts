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
}

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
      fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
      const cloneArgs = [...authArgs, "clone", "--bare"];
      if (cfg.filterBlobs) cloneArgs.push("--filter=blob:none");
      cloneArgs.push(repoUrl, mirrorPath);
      await runGit(cloneArgs, timeoutMs, undefined, redactor, authEnv);
      await markRefreshed(mirrorPath);
      return false;
    }
    if (await needsRefresh(mirrorPath, cfg.refreshSeconds)) {
      await runGit(
        [...authArgs, "remote", "update", "--prune"],
        timeoutMs,
        mirrorPath,
        redactor,
        authEnv,
      );
      await markRefreshed(mirrorPath);
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
        // SHA not reachable from mirror's refs: fetch it explicitly.
        await runGit(
          [...authArgs, "fetch", "--depth=1", "origin", ref],
          timeoutMs,
          mirrorPath,
          redactor,
          authEnv,
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
    return { resolved_sha: sha, used_cache: existedBefore, mirror_path: mirrorPath };
  }

  return {
    async materialize(input) {
      if (!cfg.enabled) return materializeDirect(input);
      return materializeViaMirror(input);
    },
  };
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
