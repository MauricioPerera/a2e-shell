/**
 * Zod schema for the `mcp_servers` session spec field.
 *
 * RFC 001 v1.1-rc.1 scope:
 *   - HTTP transport only (stdio, SSE deferred to rc.2/rc.3)
 *   - Multiple servers per session allowed, but stressed beyond 1 server
 *     is unverified in rc.1 — rate limits are per-server so N servers
 *     N× the budget
 *   - Auth via env var reference (never inline), same discipline as catalog auth
 */

import { z } from "zod";

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

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

export const McpServerSpec = z
  .object({
    /**
     * Short id the agent uses to reference the server via /bin/mcp-invoke.
     * Must be [a-z][a-z0-9_-]{0,31} so it's safe in shell tokens.
     */
    id: z.string().regex(ID_RE, "id must be a short lowercase identifier"),
    /**
     * Transport. Accepted values (rc.3):
     *   "http" — classic request/response; server returns application/json
     *   "sse"  — Streamable HTTP; server MAY return text/event-stream on a per-request basis
     * From the client's perspective the only real difference is whether we
     * announce the intent to accept event-stream responses. Any server that
     * speaks the MCP 2025-06-18 Streamable HTTP transport accepts either.
     */
    transport: z.enum(["http", "sse"]).default("http"),
    /** Absolute URL of the MCP endpoint. */
    url: z.string().url("url must be absolute"),
    auth: McpAuthSpec.optional(),
    /**
     * Per-call timeout in ms. Default 30s, same as exec timeout.
     * Applied to tools/call and to the initial handshake.
     */
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
  })
  .strict();
export type McpServerSpec = z.infer<typeof McpServerSpec>;

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
