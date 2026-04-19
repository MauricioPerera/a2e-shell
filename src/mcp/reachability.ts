/**
 * Merge MCP tools into the catalog's reachability surface so the agent sees
 * them as first-class entries via `$A2E_CATALOG_REACHABILITY`.
 *
 * MCP tools are always "reachable" (the server is connected; if it weren't,
 * session creation would have failed). The reachability extension is
 * therefore a flat dump of the connected servers' tool catalogs, keyed by
 * `mcp.<server-id>.<tool-name>`.
 */

import type { McpClient } from "./client.js";

export interface ReachabilityMcpEntry {
  readonly reachable: true;
  readonly server: string;
  readonly tool: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

/**
 * Serializes the MCP surface into the reachability JSON under a `mcp_tools`
 * bucket. Returns null when no MCP clients are configured (keeps the
 * existing reachability structure unchanged).
 */
export function buildMcpReachability(
  mcpClients: ReadonlyMap<string, McpClient>,
): Record<string, ReachabilityMcpEntry> | null {
  if (mcpClients.size === 0) return null;
  const out: Record<string, ReachabilityMcpEntry> = {};
  for (const client of mcpClients.values()) {
    for (const [name, tool] of client.state.tools) {
      const key = `${client.state.id}.${name}`;
      out[key] = {
        reachable: true,
        server: client.state.id,
        tool: name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      };
    }
  }
  return out;
}
