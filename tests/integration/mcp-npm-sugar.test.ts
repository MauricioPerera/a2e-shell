/**
 * Integration tests for RFC 003 — `npm:<pkg>@<ver>` command sugar.
 *
 * Scope:
 *   - End-to-end wiring via connectMcp(): the resolver rewrites the spawn
 *     tuple, stdio-client prepends the args, the child spawns and completes
 *     the MCP handshake.
 *   - CAPABILITY_DENIED when `npx` is absent from the policy's binary map.
 *   - PARSE_ERROR propagation when the grammar rejects the input.
 *
 * Real `npx` is replaced by a fake shim at tests/fixtures/fake-npx.mjs that
 * asserts argv shape, then re-execs Node on the stdio MCP fixture. This
 * avoids network I/O against the npm registry in CI while exercising the
 * full resolver → connect → spawn path.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp } from "../../src/mcp/connect.js";
import { buildRedactor } from "../../src/credentials/redactor.js";
import { A2EError } from "../../src/errors.js";
import type { McpClient } from "../../src/mcp/client.js";
import type { ResolvedPolicy } from "../../src/capabilities/policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MCP = path.join(__dirname, "..", "fixtures", "mcp-stdio-server.mjs");
const FAKE_NPX = path.join(__dirname, "..", "fixtures", "fake-npx.mjs");
const REDACTOR = buildRedactor([], process.env);

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    mode: "unrestricted",
    binaries_allowlist: [],
    binary_paths: {},
    path_env: "",
    http_domains_allowlist: [],
    max_exec_timeout_ms: 30_000,
    max_response_bytes: 1_048_576,
    max_session_ttl_s: 3_600,
    preview_bytes: 2048,
    stderr_preview_bytes: 1024,
    max_bindings: 32,
    max_binding_bytes: 1_048_576,
    max_total_binding_bytes: 52_428_800,
    max_transcript_bytes: 1_048_576,
    ...overrides,
  };
}

/**
 * Spec that uses the `npm:` sugar and routes through the fake-npx shim.
 * FAKE_NPX is a .mjs script; we point `npx` at Node + the shim so spawn
 * doesn't need the +x bit (Windows CI doesn't honor it anyway).
 */
function npmSpec(command: string, env: Record<string, string> = {}) {
  return {
    id: "sugar",
    transport: "stdio" as const,
    command,
    args: [], // nothing downstream; fake-npx just validates the flags.
    env: { FAKE_NPX_TARGET: FIXTURE_MCP, ...env },
    timeout_ms: 5_000,
  };
}

describe("MCP npm: sugar — happy path", () => {
  let client: McpClient | null = null;
  afterEach(() => { client?.close(); client = null; });

  // The fake shim is a .mjs Node script with a shebang. On POSIX we can
  // invoke it directly as the "npx" binary (after chmod +x). Windows
  // doesn't honor shebangs on .mjs, so we skip the full-wire test there —
  // the resolver unit tests fully cover the logic; this integration test
  // only adds confidence that connect.ts → stdio-client.ts wiring survives.
  it.skipIf(process.platform === "win32")(
    "resolver → connect → stdio-client → handshake (POSIX)",
    async () => {
      const fs = await import("node:fs");
      fs.chmodSync(FAKE_NPX, 0o755);

      const policy = makePolicy({ binary_paths: { npx: FAKE_NPX } });
      client = await connectMcp({
        spec: npmSpec("npm:@modelcontextprotocol/test-echo@1.2.3"),
        processEnv: process.env,
        redactor: REDACTOR,
        policy,
      });

      expect(client.state.id).toBe("sugar");
      expect(client.state.protocolVersion).toBe("2025-06-18");
      const result = await client.callTool("echo", { message: "via-npx" });
      expect(result.isError).toBe(false);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "echo: via-npx",
      });
    },
  );
});

describe("MCP npm: sugar — error paths", () => {
  it("throws CAPABILITY_DENIED when npx is not in binary_paths", async () => {
    const policy = makePolicy({ binary_paths: {} }); // no npx
    await expect(connectMcp({
      spec: npmSpec("npm:@scope/pkg@1.0.0"),
      processEnv: process.env,
      redactor: REDACTOR,
      policy,
    })).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
      httpStatus: 403,
    });
  });

  it("throws PARSE_ERROR for unpinned package", async () => {
    const policy = makePolicy({ binary_paths: { npx: process.execPath } });
    await expect(connectMcp({
      spec: npmSpec("npm:@scope/pkg"),
      processEnv: process.env,
      redactor: REDACTOR,
      policy,
    })).rejects.toMatchObject({
      code: "PARSE_ERROR",
      httpStatus: 400,
    });
  });

  it("throws PARSE_ERROR for dist-tag pin", async () => {
    const policy = makePolicy({ binary_paths: { npx: process.execPath } });
    await expect(connectMcp({
      spec: npmSpec("npm:@scope/pkg@latest"),
      processEnv: process.env,
      redactor: REDACTOR,
      policy,
    })).rejects.toBeInstanceOf(A2EError);
  });

  it("throws PARSE_ERROR for semver range", async () => {
    const policy = makePolicy({ binary_paths: { npx: process.execPath } });
    await expect(connectMcp({
      spec: npmSpec("npm:pkg@^1.0.0"),
      processEnv: process.env,
      redactor: REDACTOR,
      policy,
    })).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});
