/**
 * Session manager — in-memory registry of live sessions.
 */

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { resolvePolicy } from "../capabilities/policy.js";
import { buildRedactor } from "../credentials/redactor.js";
import { createSession, type Session } from "./state.js";
import { validateEnvMap, validateCwd } from "./validation.js";
import { readState } from "./persistence.js";
import { A2EError } from "../errors.js";
import { bootstrapCatalog } from "../catalog/bootstrap.js";
import type { CatalogCache } from "../catalog/cache.js";
import type { CatalogInfo, CreateSessionRequest, McpServerInfo } from "../io/protocol.js";
import { logger } from "../logging/logger.js";
import { sessionsActive, sessionLifecycle } from "../metrics/metrics.js";
import { connectMcpServer, type McpClient } from "../mcp/client.js";
import { buildMcpReachability } from "../mcp/reachability.js";

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
  /**
   * Experimental. When true, sessions write state.json atomically on every
   * mutation so `POST /sessions/:id/resume` can rebuild them after a restart.
   */
  readonly persistenceEnabled: boolean;
}

export interface SessionManager {
  create(req: CreateSessionRequest): Promise<Session>;
  /** Experimental. Reconstruct a session from disk state.json. */
  resume(id: string): Promise<Session>;
  get(id: string): Session;
  delete(id: string): Promise<boolean>;
  list(): readonly string[];
  sweepExpired(now?: Date): number;
  /** Accessor so routes can read the same prefix policy as create(). */
  allowedCwdPrefixes(): readonly string[];
  /** True if state.json writes are enabled. */
  persistenceEnabled(): boolean;
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
      // Same discipline for MCP auth: the token lives in an env var and we
      // never want its value echoed into any stream surfacing to the agent.
      for (const server of req.mcp_servers ?? []) {
        if (server.auth?.type === "token") redactKeys.push(server.auth.env_var);
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
        const bootstrapStart = Date.now();
        try {
          catalog = await bootstrapCatalog({
            spec: req.catalog,
            targetRoot: path.join(cfg.sessionsDir, id, "catalog"),
            timeoutMs: cfg.catalogBootstrapTimeoutMs,
            policy,
            redactor,
            cache: cfg.catalogCache,
          });
          logger.info({
            event: "catalog.bootstrap.ok",
            session_id: id,
            duration_ms: Date.now() - bootstrapStart,
            index_sha: catalog.index_sha,
            content_sha: catalog.content_sha,
            in_sync: catalog.in_sync,
          });
        } catch (e) {
          // Bootstrap left partial worktrees / clone artifacts on disk. Wipe
          // them so a retry is clean and so we don't leak disk for failed
          // sessions that never reached the in-memory registry.
          await fsp.rm(path.join(cfg.sessionsDir, id), { recursive: true, force: true }).catch(() => {});
          sessionLifecycle.inc({ event: "bootstrap_failed" });
          logger.warn({
            event: "catalog.bootstrap.failed",
            session_id: id,
            duration_ms: Date.now() - bootstrapStart,
            code: e instanceof A2EError ? e.code : "INTERNAL",
          });
          throw e;
        }
      }

      // RFC 001 v1.1 — connect MCP servers (if any) and cache tool lists.
      // If any server fails to connect, wipe the session dir and reject the
      // entire create — same defense-in-depth as catalog bootstrap failures.
      const mcpClients = new Map<string, McpClient>();
      if (req.mcp_servers && req.mcp_servers.length > 0) {
        try {
          for (const spec of req.mcp_servers) {
            const client = await connectMcpServer({
              spec,
              processEnv: process.env,
              redactor,
            });
            mcpClients.set(spec.id, client);
          }
        } catch (e) {
          for (const c of mcpClients.values()) c.close();
          await fsp.rm(path.join(cfg.sessionsDir, id), { recursive: true, force: true }).catch(() => {});
          sessionLifecycle.inc({ event: "mcp_connect_failed" });
          logger.warn({
            event: "mcp.server.connect_failed",
            session_id: id,
            code: e instanceof A2EError ? e.code : "INTERNAL",
          });
          throw e;
        }
      }

      // If we have a catalog AND MCP clients, write an mcp-tools.json file
      // into the catalog's index dir so reachability queries see MCP tools.
      if (catalog && mcpClients.size > 0) {
        const mcpReport = buildMcpReachability(mcpClients);
        if (mcpReport) {
          try {
            await fsp.writeFile(
              path.join(catalog.index_dir, "mcp-tools.json"),
              JSON.stringify(mcpReport, null, 2),
            );
          } catch (e) {
            logger.warn({
              event: "mcp.reachability.write_failed",
              session_id: id,
              err: String(e),
            });
          }
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
        catalog_spec: req.catalog ?? null,
        persistenceEnabled: cfg.persistenceEnabled,
        mcpClients,
      });
      sessions.set(id, session);
      sessionsActive.set(sessions.size);
      sessionLifecycle.inc({ event: "created" });
      logger.info({
        event: "session.created",
        session_id: id,
        mode: policy.mode,
        has_catalog: catalog !== null,
        expires_at: expires_at.toISOString(),
      });
      // Force an initial state.json write so POST /sessions/:id/resume can
      // find this session even if the process crashes before any mutation
      // (otherwise the client holds a session_id that will never resolve).
      // Noop when persistence is disabled.
      if (cfg.persistenceEnabled) {
        session.touchForPersistence();
        await session.flush();
      }
      return session;
    },

    async resume(id) {
      if (!cfg.persistenceEnabled) {
        throw new A2EError(
          "NOT_IMPLEMENTED_V1",
          "session persistence is disabled (set A2E_SESSION_PERSISTENCE=true)",
          400,
        );
      }
      if (sessions.has(id)) {
        throw new A2EError("CONFLICT", `session '${id}' is already live`, 409);
      }
      const statePath = path.join(cfg.sessionsDir, id, "state.json");
      let state;
      try {
        state = await readState(statePath);
      } catch (e) {
        throw new A2EError(
          "NOT_FOUND",
          `session '${id}' has no resumable state: ${(e as Error).message}`,
          404,
        );
      }
      if (state.session_id !== id) {
        throw new A2EError(
          "UPSTREAM_ERROR",
          `state.json session_id '${state.session_id}' doesn't match URL '${id}'`,
          500,
        );
      }
      const expiresAt = new Date(state.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        throw new A2EError("CONFLICT", `session '${id}' has expired`, 409);
      }
      // Catalog sanity: if the session had one, verify the worktree paths
      // still exist. If they don't, reject — operator decides whether to
      // re-bootstrap via a fresh create.
      if (state.catalog) {
        if (!fs.existsSync(state.catalog.index_dir) || !fs.existsSync(state.catalog.content_dir)) {
          throw new A2EError(
            "UPSTREAM_ERROR",
            `session '${id}' catalog worktree paths no longer exist; create a fresh session`,
            500,
          );
        }
      }
      const redactKeys = [...cfg.redactEnvKeys];
      if (state.catalog_spec?.auth?.type === "token") {
        redactKeys.push(state.catalog_spec.auth.env_var);
      }
      const redactor = buildRedactor(redactKeys, process.env);
      const transcript_path = path.join(cfg.sessionsDir, id, "transcript.jsonl");
      const session = createSession({
        session_id: id,
        policy: state.policy,
        initial_cwd: state.cwd,
        initial_env_overlay: state.env_overlay,
        redactor,
        expires_at: expiresAt,
        transcript_path,
        catalog: state.catalog,
        catalog_spec: state.catalog_spec,
        persistenceEnabled: true,
        restored: {
          bindings: state.bindings,
          turn: state.turn,
          history_size: state.history_size,
          transcript_bytes: state.transcript_bytes,
        },
      });
      sessions.set(id, session);
      sessionsActive.set(sessions.size);
      sessionLifecycle.inc({ event: "resumed" });
      logger.info({
        event: "session.resumed",
        session_id: id,
        turn: state.turn,
        bindings_count: Object.keys(state.bindings).length,
        has_catalog: state.catalog !== null,
      });
      return session;
    },

    get(id) {
      const s = sessions.get(id);
      if (!s) throw new A2EError("NOT_FOUND", `session '${id}' not found`, 404);
      if (s.expiresAt.getTime() < Date.now()) {
        sessions.delete(id);
        sessionsActive.set(sessions.size);
        sessionLifecycle.inc({ event: "expired" });
        logger.info({ event: "session.expired", session_id: id });
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
        sessionsActive.set(sessions.size);
        sessionLifecycle.inc({ event: "deleted" });
        logger.info({ event: "session.deleted", session_id: id });
        // Close MCP clients (no-op in HTTP transport; placeholder for SSE/stdio).
        for (const c of s.mcpClients.values()) c.close();
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
          sessionLifecycle.inc({ event: "expired" });
          void removeSessionDir(cfg.sessionsDir, id);
          void pruneWorktrees(s.catalog?.mirror_path ?? null);
          n++;
        }
      }
      if (n > 0) {
        sessionsActive.set(sessions.size);
        logger.info({ event: "session.sweep", expired_count: n });
      }
      return n;
    },
    allowedCwdPrefixes: () => effectiveCwdPrefixes,
    persistenceEnabled: () => cfg.persistenceEnabled,
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
