import { z } from "zod";
import { ERROR_CODES } from "../errors.js";

export const SessionMode = z.enum(["unrestricted", "bounded"]);
export type SessionMode = z.infer<typeof SessionMode>;

export const CapabilitiesInput = z
  .object({
    binaries_allowlist: z.array(z.string().min(1)).optional(),
    http_domains_allowlist: z.array(z.string().min(1)).optional(),
    max_exec_timeout_ms: z.number().int().positive().optional(),
    max_response_bytes: z.number().int().positive().optional(),
    max_session_ttl_s: z.number().int().positive().optional(),
  })
  .strict();
export type CapabilitiesInput = z.infer<typeof CapabilitiesInput>;

const REPO_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;

/**
 * Auth for private repo clones. Credentials NEVER appear in the request body —
 * the spec names env vars on the server that hold the material. The runtime
 * resolves them, injects them appropriately (`http.extraheader` for tokens,
 * `GIT_SSH_COMMAND` for SSH keys), and adds sensitive values to the session
 * redactor so any accidental leakage is scrubbed before reaching the transcript.
 *
 * Supported types:
 *   - `token`: HTTPS with PAT (GitHub/GitLab/Bitbucket)
 *   - `ssh_key`: ssh:// or git@ with a private key file pointed at by an env var
 */
export const CatalogAuthSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("token"),
    env_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env_var must be UPPER_SNAKE_CASE"),
    username: z.string().min(1).default("x-access-token"),
  }),
  z.object({
    type: z.literal("ssh_key"),
    /** Env var whose value is the absolute path to a private key file. */
    key_path_env_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env_var must be UPPER_SNAKE_CASE"),
    /**
     * Env var whose value is the absolute path to a known_hosts file.
     * When absent, StrictHostKeyChecking=accept-new is used (trust-on-first-use).
     */
    known_hosts_env_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env_var must be UPPER_SNAKE_CASE").optional(),
  }),
]);
export type CatalogAuthSpec = z.infer<typeof CatalogAuthSpec>;

export const CatalogSpec = z
  .object({
    repo_url: z.string().regex(REPO_URL_RE, "must be http(s)://, git@, ssh://, or file://"),
    // Any git ref: branch name, tag, or 40-char commit SHA. 40-hex triggers the SHA clone path.
    index_ref: z.string().min(1).default("index"),
    content_ref: z.string().min(1).default("main"),
    auth: CatalogAuthSpec.optional(),
  })
  .strict();
export type CatalogSpec = z.infer<typeof CatalogSpec>;

export const CreateSessionRequest = z
  .object({
    mode: SessionMode.default("unrestricted"),
    capabilities: CapabilitiesInput.optional(),
    initial_cwd: z.string().optional(),
    initial_env: z.record(z.string(), z.string()).optional(),
    catalog: CatalogSpec.optional(),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const ReachabilitySummary = z
  .object({
    total: z.number().int().nonnegative(),
    reachable: z.number().int().nonnegative(),
    unreachable: z.number().int().nonnegative(),
    report_path: z.string(),
  })
  .strict();
export type ReachabilitySummary = z.infer<typeof ReachabilitySummary>;

export const CatalogInfo = z
  .object({
    index_dir: z.string(),
    content_dir: z.string(),
    index_sha: z.string().regex(/^[a-f0-9]{40}$/),
    content_sha: z.string().regex(/^[a-f0-9]{40}$/),
    manifest_source_sha: z.string().regex(/^[a-f0-9]{40}$/),
    in_sync: z.boolean(),
    reachability: ReachabilitySummary,
    /** Absolute path of the shared-mirror bare clone. Null in direct (no-cache) mode. */
    mirror_path: z.string().nullable(),
  })
  .strict();
export type CatalogInfo = z.infer<typeof CatalogInfo>;

export const CreateSessionResponse = z
  .object({
    session_id: z.string().uuid(),
    mode: SessionMode,
    cwd: z.string(),
    expires_at: z.string().datetime(),
    catalog: CatalogInfo.nullable(),
  })
  .strict();
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ExecRequest = z
  .object({
    command: z.string().min(1).max(16_384),
    bind_as: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "bind_as must be a bare identifier")
      .optional(),
    stdin: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ExecRequest = z.infer<typeof ExecRequest>;

export const ExecError = z
  .object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  })
  .strict();
export type ExecError = z.infer<typeof ExecError>;

export const ExecResponse = z
  .object({
    status_line: z.string(),
    shape: z.string().nullable(),
    preview: z.unknown().nullable(),
    binding: z
      .string()
      .regex(/^\$[a-zA-Z_][a-zA-Z0-9_]*$/)
      .nullable(),
    /**
     * Truncated tail of subprocess stderr. Always populated when stderr had
     * bytes, regardless of exit code — LLMs need error signals for exit!=0
     * and warning signals for exit==0 alike. Null only when stderr was empty
     * or the response is an intercept/error short-circuit.
     */
    stderr: z.string().nullable(),
    /** True if stdout was truncated at max_response_bytes. */
    truncated: z.boolean(),
    /** True if the response was served from the session's idempotency cache. */
    idempotent_hit: z.boolean().optional(),
    error: ExecError.optional(),
  })
  .strict();
export type ExecResponse = z.infer<typeof ExecResponse>;

export const PatchCwdRequest = z.object({ cwd: z.string().min(1) }).strict();
export type PatchCwdRequest = z.infer<typeof PatchCwdRequest>;

export const PatchEnvRequest = z
  .object({
    set: z.record(z.string(), z.string()).optional(),
    unset: z.array(z.string()).optional(),
  })
  .strict();
export type PatchEnvRequest = z.infer<typeof PatchEnvRequest>;

export const StateResponse = z
  .object({
    session_id: z.string().uuid(),
    cwd: z.string(),
    env_overlay_keys: z.array(z.string()),
    bindings: z.record(
      z.string(),
      z.object({ shape: z.string(), size_bytes: z.number().int().nonnegative() }),
    ),
    history_size: z.number().int().nonnegative(),
    expires_at: z.string().datetime(),
  })
  .strict();
export type StateResponse = z.infer<typeof StateResponse>;

export const HttpErrorBody = z
  .object({
    error: z.enum(ERROR_CODES),
    request_id: z.string(),
    message: z.string().optional(),
  })
  .strict();
export type HttpErrorBody = z.infer<typeof HttpErrorBody>;
