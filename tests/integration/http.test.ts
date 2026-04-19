import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildApp } from "../../src/http/server.js";
import { createManager } from "../../src/session/manager.js";
import { createCatalogCache } from "../../src/catalog/cache.js";

function makeApp(opts?: {
  authTokens?: readonly string[];
  rateLimitPerMinute?: number;
  rateLimitCreatePerMinute?: number;
}) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "http-"));
  const catalogCache = createCatalogCache({
    enabled: false, cacheDir: path.join(sessionsDir, ".cache"), refreshSeconds: 3600, filterBlobs: false, maxBytes: 0, sweepIntervalSeconds: 0,
  });
  const manager = createManager({
    sessionsDir,
    redactEnvKeys: [],
    catalogBootstrapTimeoutMs: 30_000,
    catalogCache,
    allowedCwdPrefixes: [],
  });
  const app = buildApp({
    manager,
    config: {
      port: 0,
      authTokens: opts?.authTokens ?? [],
      maxRequestBytes: 1_048_576,
      redactEnvKeys: [],
      rateLimitPerMinute: opts?.rateLimitPerMinute ?? 0,
      rateLimitCreatePerMinute: opts?.rateLimitCreatePerMinute ?? 0,
    },
  });
  return { app, sessionsDir };
}

async function postJson(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown, headers?: Record<string, string>) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

describe("HTTP server", () => {
  let cleanup: string;

  beforeEach(() => { cleanup = ""; });
  afterEach(() => {
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("GET /healthz → 200 {ok:true}", async () => {
    const { app } = makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /sessions with empty body → creates an unrestricted session", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe("unrestricted");
    expect(body.catalog).toBeNull();
    expect(typeof body.session_id).toBe("string");
  });

  it("POST /sessions with bounded mode → 400 NOT_IMPLEMENTED_V1", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", { mode: "bounded" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_IMPLEMENTED_V1");
  });

  it("POST /sessions with invalid mode → 400 PARSE_ERROR", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", { mode: "hacker" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("PARSE_ERROR");
  });

  it("POST /sessions with reserved env key → 400 PARSE_ERROR", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", {
      initial_env: { LD_PRELOAD: "/evil.so" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("PARSE_ERROR");
    expect(body.message).toContain("reserved");
  });

  it("POST /sessions with relative initial_cwd → 400", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", { initial_cwd: "./rel" });
    expect(res.status).toBe(400);
  });

  it("DELETE /sessions/:id on unknown id → 404", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await app.request("/sessions/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("auth required: missing bearer → 401 on /sessions", async () => {
    const { app, sessionsDir } = makeApp({ authTokens: ["secret-tok-1234"] });
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", {});
    expect(res.status).toBe(401);
  });

  it("auth required: wrong bearer → 401", async () => {
    const { app, sessionsDir } = makeApp({ authTokens: ["secret-tok-1234"] });
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", {}, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("auth required: correct bearer → 201", async () => {
    const { app, sessionsDir } = makeApp({ authTokens: ["secret-tok-1234"] });
    cleanup = sessionsDir;
    const res = await postJson(app, "/sessions", {}, { authorization: "Bearer secret-tok-1234" });
    expect(res.status).toBe(201);
  });

  it("GET /sessions/:id/state on unknown id → 404", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const res = await app.request("/sessions/nope/state");
    expect(res.status).toBe(404);
  });

  it("rate limit fires at cap", async () => {
    const { app, sessionsDir } = makeApp({ rateLimitPerMinute: 3 });
    cleanup = sessionsDir;
    const create = await postJson(app, "/sessions", {});
    const sid = ((await create.json()) as { session_id: string }).session_id;

    const hits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.request(`/sessions/${sid}/state`);
      hits.push(r.status);
    }
    expect(hits.filter((s) => s === 200).length).toBe(3);
    expect(hits.filter((s) => s === 429).length).toBe(2);
  });

  it("create rate limit fires at cap (keyed by bearer token)", async () => {
    const { app, sessionsDir } = makeApp({
      authTokens: ["tok-x"],
      rateLimitCreatePerMinute: 2,
    });
    cleanup = sessionsDir;
    const hits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await postJson(app, "/sessions", {}, { authorization: "Bearer tok-x" });
      hits.push(r.status);
    }
    expect(hits.filter((s) => s === 201).length).toBe(2);
    expect(hits.filter((s) => s === 429).length).toBe(2);
  });

  it("idempotent exec: second call with same key returns cached + idempotent_hit", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const create = await postJson(app, "/sessions", {
      capabilities: { binaries_allowlist: ["echo", "printf"] },
    });
    const sid = ((await create.json()) as { session_id: string }).session_id;

    const r1 = await postJson(app, `/sessions/${sid}/exec`, {
      command: "printf 'hello world'",
      idempotency_key: "op-1",
    });
    const b1 = (await r1.json()) as { preview: unknown; idempotent_hit?: boolean };
    expect(b1.idempotent_hit).toBeUndefined();

    const r2 = await postJson(app, `/sessions/${sid}/exec`, {
      command: "printf 'hello world'",
      idempotency_key: "op-1",
    });
    const b2 = (await r2.json()) as { preview: unknown; idempotent_hit?: boolean };
    expect(b2.idempotent_hit).toBe(true);
    expect(b2.preview).toEqual(b1.preview);
  });

  it("export of reserved env via intercept → CAPABILITY_DENIED", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const create = await postJson(app, "/sessions", {});
    const sid = ((await create.json()) as { session_id: string }).session_id;

    const r = await postJson(app, `/sessions/${sid}/exec`, {
      command: "export LD_PRELOAD=/evil.so",
    });
    const body = (await r.json()) as { error?: { code: string } };
    expect(r.status).toBe(200);
    expect(body.error?.code).toBe("CAPABILITY_DENIED");
  });

  it("initial_cwd outside allowed prefix → 400", async () => {
    // Default prefix is sessionsDir; /etc is outside.
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    const r = await postJson(app, "/sessions", { initial_cwd: "/etc" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("PARSE_ERROR");
    expect(body.message).toContain("allowed prefixes");
  });

  it("cd ~ expands HOME in intercept (no spawn needed)", async () => {
    const { app, sessionsDir } = makeApp();
    cleanup = sessionsDir;
    // Use a real, always-existing dir as HOME for the session.
    const home = os.tmpdir();
    const create = await postJson(app, "/sessions", {
      initial_env: { CUSTOM: "x" }, // HOME is reserved; can't inject via request.
    });
    const sid = ((await create.json()) as { session_id: string }).session_id;

    // Intercept `cd ~` with process.env.HOME (tmpdir is guaranteed to exist).
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await postJson(app, `/sessions/${sid}/exec`, { command: "cd ~" });
      const body = (await r.json()) as { status_line: string; error?: unknown };
      expect(body.status_line).toBe("[exit 0]");
      expect(body.error).toBeUndefined();
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }

    const state = await app.request(`/sessions/${sid}/state`);
    const ss = (await state.json()) as { cwd: string };
    // cd resolved to HOME → cwd is the tmpdir path.
    expect(ss.cwd).toBe(path.resolve(home));
  });
});
