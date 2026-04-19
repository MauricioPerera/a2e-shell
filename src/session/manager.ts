/**
 * Session manager — in-memory registry of live sessions.
 */

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolvePolicy } from "../capabilities/policy.js";
import { buildRedactor } from "../credentials/redactor.js";
import { createSession, type Session } from "./state.js";
import { validateEnvMap, validateCwd } from "./validation.js";
import { A2EError } from "../errors.js";
import { bootstrapCatalog } from "../catalog/bootstrap.js";
import type { CatalogCache } from "../catalog/cache.js";
import type { CatalogInfo, CreateSessionRequest } from "../io/protocol.js";

export interface ManagerConfig {
  readonly sessionsDir: string;
  readonly redactEnvKeys: readonly string[];
  readonly catalogBootstrapTimeoutMs: number;
  readonly catalogCache: CatalogCache;
  /**
   * Absolute path prefixes under which `initial_cwd` and PATCH /cwd are allowed
   * to point. Defaults to [sessionsDir] when unset. Empty array disables the
   * check (NOT recommended for production).
   */
  readonly allowedCwdPrefixes: readonly string[];
}

export interface SessionManager {
  create(req: CreateSessionRequest): Promise<Session>;
  get(id: string): Session;
  delete(id: string): Promise<boolean>;
  list(): readonly string[];
  sweepExpired(now?: Date): number;
  /** Accessor so routes can read the same prefix policy as create(). */
  allowedCwdPrefixes(): readonly string[];
}

export function createManager(cfg: ManagerConfig): SessionManager {
  const sessions = new Map<string, Session>();
  // Default prefix: sessionsDir (every created session's default cwd lives here).
  const effectiveCwdPrefixes = cfg.allowedCwdPrefixes.length > 0
    ? cfg.allowedCwdPrefixes
    : [cfg.sessionsDir];

  return {
    async create(req) {
      const id = crypto.randomUUID();
      if (req.mode === "bounded") {
        throw new A2EError(
          "NOT_IMPLEMENTED_V1",
          "bounded mode is reserved for v2; use unrestricted",
        );
      }
      const policy = resolvePolicy({
        mode: req.mode,
        ...(req.capabilities ? { overrides: req.capabilities } : {}),
      });
      // Fold the catalog auth env_var into the redactor keys so any leakage
      // (git stderr, echoed output, ...) is scrubbed with the session's secrets.
      const redactKeys = [...cfg.redactEnvKeys];
      if (req.catalog?.auth?.type === "token") {
        redactKeys.push(req.catalog.auth.env_var);
      }
      const redactor = buildRedactor(redactKeys, process.env);
      validateEnvMap(req.initial_env);
      const defaultCwd = path.join(cfg.sessionsDir, id);
      // Ensure the default session dir exists before any cwd validation.
      await fsp.mkdir(defaultCwd, { recursive: true });
      const initial_cwd = req.initial_cwd
        ? await validateCwd(req.initial_cwd, effectiveCwdPrefixes)
        : defaultCwd;
      const transcript_path = path.join(cfg.sessionsDir, id, "transcript.jsonl");
      const expires_at = new Date(Date.now() + policy.max_session_ttl_s * 1000);

      let catalog: CatalogInfo | null = null;
      if (req.catalog) {
        try {
          catalog = await bootstrapCatalog({
            spec: req.catalog,
            targetRoot: path.join(cfg.sessionsDir, id, "catalog"),
            timeoutMs: cfg.catalogBootstrapTimeoutMs,
            policy,
            redactor,
            cache: cfg.catalogCache,
          });
        } catch (e) {
          // Bootstrap left partial worktrees / clone artifacts on disk. Wipe
          // them so a retry is clean and so we don't leak disk for failed
          // sessions that never reached the in-memory registry.
          await fsp.rm(path.join(cfg.sessionsDir, id), { recursive: true, force: true }).catch(() => {});
          throw e;
        }
      }

      const session = createSession({
        session_id: id,
        policy,
        initial_cwd,
        initial_env_overlay: req.initial_env ?? {},
        redactor,
        expires_at,
        transcript_path,
        catalog,
      });
      sessions.set(id, session);
      return session;
    },

    get(id) {
      const s = sessions.get(id);
      if (!s) throw new A2EError("NOT_FOUND", `session '${id}' not found`, 404);
      if (s.expiresAt.getTime() < Date.now()) {
        sessions.delete(id);
        void removeSessionDir(cfg.sessionsDir, id);
        void pruneWorktrees(s.catalog?.mirror_path ?? null);
        throw new A2EError("CONFLICT", `session '${id}' expired`, 409);
      }
      return s;
    },

    async delete(id) {
      const s = sessions.get(id);
      const existed = sessions.delete(id);
      if (existed && s) {
        // Synchronous disk cleanup so 204 is an honest "all gone". The git
        // worktree prune is still fire-and-forget since it only touches metadata.
        await removeSessionDir(cfg.sessionsDir, id);
        void pruneWorktrees(s.catalog?.mirror_path ?? null);
      }
      return existed;
    },

    list() {
      return [...sessions.keys()];
    },

    sweepExpired(now = new Date()) {
      let n = 0;
      for (const [id, s] of sessions) {
        if (s.expiresAt.getTime() < now.getTime()) {
          sessions.delete(id);
          void removeSessionDir(cfg.sessionsDir, id);
          void pruneWorktrees(s.catalog?.mirror_path ?? null);
          n++;
        }
      }
      return n;
    },
    allowedCwdPrefixes: () => effectiveCwdPrefixes,
  };
}

/** Remove the session directory from disk. Best-effort. */
async function removeSessionDir(sessionsDir: string, id: string): Promise<void> {
  const sessionDir = path.join(sessionsDir, id);
  try {
    await fsp.rm(sessionDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Prune stale worktree metadata from the shared-mirror bare clone. Fire-and-forget. */
async function pruneWorktrees(mirrorPath: string | null): Promise<void> {
  if (!mirrorPath) return;
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["-C", mirrorPath, "worktree", "prune"], {
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
}
