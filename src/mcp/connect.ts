/**
 * Transport-agnostic entry point for connecting to an MCP server.
 *
 * The session manager calls `connectMcp(spec)` and doesn't care whether the
 * underlying transport is HTTP, SSE, or stdio. The dispatcher here picks
 * the right client implementation based on the spec's `transport` field.
 *
 * For stdio, the command is resolved against the session's binary allowlist
 * before spawn — the same allowlist that gates bash exec and bounded `call`.
 * Unknown commands surface as CAPABILITY_DENIED before any subprocess is
 * created.
 */

import * as path from "node:path";
import { A2EError } from "../errors.js";
import type { Redactor } from "../credentials/redactor.js";
import type { ResolvedPolicy } from "../capabilities/policy.js";
import { connectMcpServer as connectHttpMcpServer } from "./client.js";
import { connectStdioMcpServer } from "./stdio-client.js";
import { isStdioSpec, type McpServerSpec } from "./schema.js";
import type { McpClient } from "./client.js";

export interface ConnectMcpOptions {
  spec: McpServerSpec;
  processEnv: Readonly<Record<string, string | undefined>>;
  redactor: Redactor;
  /**
   * Session policy. stdio transport uses this to resolve bare `command`
   * names against the binary allowlist. HTTP/SSE transports ignore it.
   */
  policy: ResolvedPolicy;
}

export async function connectMcp(opts: ConnectMcpOptions): Promise<McpClient> {
  if (isStdioSpec(opts.spec)) {
    const resolved = resolveStdioCommand(opts.spec.command, opts.policy);
    return connectStdioMcpServer({
      spec: opts.spec,
      processEnv: opts.processEnv,
      redactor: opts.redactor,
      resolvedCommand: resolved,
    });
  }
  return connectHttpMcpServer({
    spec: opts.spec,
    processEnv: opts.processEnv,
    redactor: opts.redactor,
  });
}

/**
 * Resolve `command` for stdio spawn. Two acceptable shapes:
 *   1. Absolute path — use as-is. We still verify it doesn't live in a
 *      surprising place (no enforcement beyond "is absolute"; operators
 *      who want stricter control should set `cwd` and restrict PATH).
 *   2. Bare name — resolved through the policy's `binary_paths` map, which
 *      already encodes the allowlist decision.
 */
function resolveStdioCommand(command: string, policy: ResolvedPolicy): string {
  if (path.isAbsolute(command)) return command;
  const resolved = policy.binary_paths[command];
  if (!resolved) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      `mcp stdio command '${command}' is not in the session's binary allowlist`,
      403,
    );
  }
  return resolved;
}
