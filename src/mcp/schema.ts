/**
 * Zod schema for the `mcp_servers` session spec field.
 *
 * Transports (v1.3):
 *   - "http" / "sse": MCP 2025-06-18 Streamable HTTP transport (v1.1).
 *   - "stdio": subprocess with line-framed JSON-RPC on stdin/stdout (v1.3).
 *
 * Auth via env var reference (never inline), same discipline as catalog auth.
 * `stdio` has no headers; auth, if any, is the subprocess's concern — typically
 * via env overlay which is passed through `spec.env`.
 */

import { z } from "zod";

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const McpAuthSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("token"),
    /** Env var holding the bearer token. */
    env_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env_var must be UPPER_SNAKE_CASE"),
    /**
     * Authorization scheme. Default "Bearer". Servers sometimes require
     * custom schemes (e.g. "Token", "Api-Key").
     */
    scheme: z.string().min(1).default("Bearer"),
    /** Header name. Default "Authorization". */
    header: z.string().min(1).default("Authorization"),
  }),
]);
export type McpAuthSpec = z.infer<typeof McpAuthSpec>;

// --- HTTP / SSE branch ------------------------------------------------------

const McpServerSpecHttp = z
  .object({
    id: z.string().regex(ID_RE, "id must be a short lowercase identifier"),
    /**
     * Transport. "http" = classic request/response; "sse" = Streamable HTTP
     * where the server MAY return text/event-stream on a per-request basis.
     * From the client's perspective the only real difference is whether we
     * announce the intent to accept event-stream responses.
     */
    transport: z.enum(["http", "sse"]).default("http"),
    /** Absolute URL of the MCP endpoint. */
    url: z.string().url("url must be absolute"),
    auth: McpAuthSpec.optional(),
    /**
     * Per-call timeout in ms. Default 30s, same as exec timeout. Applied to
     * tools/call and to the initial handshake.
     */
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
  })
  .strict();

// --- stdio branch -----------------------------------------------------------

const McpServerSpecStdio = z
  .object({
    id: z.string().regex(ID_RE, "id must be a short lowercase identifier"),
    transport: z.literal("stdio"),
    /**
     * Absolute binary path OR bare name. Bare names are resolved via the
     * session's binary allowlist (same policy that gates bash exec and
     * bounded-mode `call <binary>`). Absolute paths must start with "/" on
     * Unix or "C:\\" etc. on Windows.
     */
    command: z.string().min(1, "command cannot be empty"),
    /** argv for the subprocess. Default: []. */
    args: z.array(z.string()).default([]),
    /**
     * Env overlay. Merged on top of the server process env before spawn.
     * Keys must be valid env-var names; values are strings. No secret
     * injection here — use `auth` env_var references for tokens (but note:
     * stdio has no native auth layer, so env is the only channel).
     */
    env: z.record(z.string().regex(ENV_KEY_RE), z.string()).default({}),
    /** Working directory. Default: server process cwd. */
    cwd: z.string().optional(),
    /** Per-call timeout in ms. Default 30s. */
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
  })
  .strict();

// --- union ------------------------------------------------------------------

/**
 * Discriminated union on `transport`. Existing sessions that either omit
 * `transport` or set it to "http" / "sse" get the v1.1 behavior unchanged.
 * `transport: "stdio"` opts into subprocess spawn at session create.
 */
export const McpServerSpec = z.union([McpServerSpecHttp, McpServerSpecStdio]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export type McpServerSpecHttpT = z.infer<typeof McpServerSpecHttp>;
export type McpServerSpecStdioT = z.infer<typeof McpServerSpecStdio>;

/**
 * True iff the spec targets a subprocess (not an HTTP endpoint).
 * Narrow on this before touching `.url` / `.command` etc.
 */
export function isStdioSpec(spec: McpServerSpec): spec is McpServerSpecStdioT {
  return spec.transport === "stdio";
}

/**
 * Top-level field on `CreateSessionRequest`. Optional array.
 * No-op sessions (no mcp_servers) behave identically to v1.0.
 */
export const McpServersArray = z
  .array(McpServerSpec)
  .max(8, "up to 8 MCP servers per session in v1.1-rc.1")
  .refine(
    (arr) => new Set(arr.map((s) => s.id)).size === arr.length,
    { message: "duplicate mcp_server id in list" },
  );
