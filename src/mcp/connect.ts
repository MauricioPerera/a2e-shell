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
import { isNpmCommand, resolveNpmCommand } from "./npm-resolver.js";
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
    const { resolvedCommand, prependArgs } = resolveStdioSpawn(
      opts.spec.command,
      opts.policy,
    );
    return connectStdioMcpServer({
      spec: opts.spec,
      processEnv: opts.processEnv,
      redactor: opts.redactor,
      resolvedCommand,
      ...(prependArgs.length > 0 ? { prependArgs } : {}),
    });
  }
  return connectHttpMcpServer({
    spec: opts.spec,
    processEnv: opts.processEnv,
    redactor: opts.redactor,
  });
}

/**
 * Resolve a stdio `command` into the concrete spawn tuple.
 *
 * Three acceptable shapes:
 *   1. `npm:<pkg>@<ver>` — RFC 003 sugar. Expands to `npx -y pkg@ver ...`.
 *      Requires `npx` in the binary allowlist.
 *   2. Absolute path — use as-is. No enforcement beyond "is absolute";
 *      operators who want stricter control should set `cwd` and PATH.
 *   3. Bare name — resolved through the policy's `binary_paths` map.
 */
function resolveStdioSpawn(
  command: string,
  policy: ResolvedPolicy,
): { resolvedCommand: string; prependArgs: readonly string[] } {
  if (isNpmCommand(command)) {
    const r = resolveNpmCommand(command, policy);
    return { resolvedCommand: r.resolvedCommand, prependArgs: r.prependArgs };
  }
  if (path.isAbsolute(command)) {
    return { resolvedCommand: command, prependArgs: [] };
  }
  const resolved = policy.binary_paths[command];
  if (!resolved) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      `mcp stdio command '${command}' is not in the session's binary allowlist`,
      403,
    );
  }
  return { resolvedCommand: resolved, prependArgs: [] };
}
