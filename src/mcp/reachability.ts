/**
 * Merge MCP primitives (tools + resources + prompts) into the catalog's
 * reachability surface so the agent sees them as first-class entries via
 * `$A2E_CATALOG_REACHABILITY`.
 *
 * Each connected server contributes three buckets under the `mcp.<server-id>.*`
 * prefix. All entries are reachable — if they weren't, session creation
 * would have failed.
 */

import type { McpClient } from "./client.js";

export interface ReachabilityMcpTool {
  readonly kind: "tool";
  readonly reachable: true;
  readonly server: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface ReachabilityMcpResource {
  readonly kind: "resource";
  readonly reachable: true;
  readonly server: string;
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface ReachabilityMcpPrompt {
  readonly kind: "prompt";
  readonly reachable: true;
  readonly server: string;
  readonly name: string;
  readonly description?: string;
  readonly arguments?: unknown;
}

export type ReachabilityMcpEntry =
  | ReachabilityMcpTool
  | ReachabilityMcpResource
  | ReachabilityMcpPrompt;

export interface McpReachabilityReport {
  readonly tools: Record<string, ReachabilityMcpTool>;
  readonly resources: Record<string, ReachabilityMcpResource>;
  readonly prompts: Record<string, ReachabilityMcpPrompt>;
  readonly summary: {
    readonly servers: number;
    readonly tools: number;
    readonly resources: number;
    readonly prompts: number;
  };
}

/**
 * Build a structured per-primitive report keyed by `<server-id>.<name>` for
 * tools and prompts, and `<server-id>.<uri>` for resources. Returns null
 * when no MCP clients are configured.
 */
export function buildMcpReachability(
  mcpClients: ReadonlyMap<string, McpClient>,
): McpReachabilityReport | null {
  if (mcpClients.size === 0) return null;

  const tools: Record<string, ReachabilityMcpTool> = {};
  const resources: Record<string, ReachabilityMcpResource> = {};
  const prompts: Record<string, ReachabilityMcpPrompt> = {};

  for (const client of mcpClients.values()) {
    const sid = client.state.id;
    for (const [name, tool] of client.state.tools) {
      tools[`${sid}.${name}`] = {
        kind: "tool",
        reachable: true,
        server: sid,
        name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      };
    }
    for (const [uri, resource] of client.state.resources) {
      resources[`${sid}.${uri}`] = {
        kind: "resource",
        reachable: true,
        server: sid,
        uri,
        ...(resource.name !== undefined ? { name: resource.name } : {}),
        ...(resource.description !== undefined ? { description: resource.description } : {}),
        ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
      };
    }
    for (const [name, prompt] of client.state.prompts) {
      prompts[`${sid}.${name}`] = {
        kind: "prompt",
        reachable: true,
        server: sid,
        name,
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        ...(prompt.arguments !== undefined ? { arguments: prompt.arguments } : {}),
      };
    }
  }

  return {
    tools,
    resources,
    prompts,
    summary: {
      servers: mcpClients.size,
      tools: Object.keys(tools).length,
      resources: Object.keys(resources).length,
      prompts: Object.keys(prompts).length,
    },
  };
}
