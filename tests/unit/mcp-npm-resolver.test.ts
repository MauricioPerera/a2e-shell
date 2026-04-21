/**
 * Unit tests for RFC 003 — `npm:<pkg>@<ver>` sugar resolver.
 *
 * The resolver is pure: it takes a command string + a resolved policy and
 * returns a spawn tuple (or throws). No network, no subprocess. Tests cover
 * the grammar (accept + reject) and the CAPABILITY_DENIED path when `npx`
 * is missing from the binary allowlist.
 */

import { describe, it, expect } from "vitest";
import { isNpmCommand, resolveNpmCommand } from "../../src/mcp/npm-resolver.js";
import { A2EError } from "../../src/errors.js";
import type { ResolvedPolicy } from "../../src/capabilities/policy.js";

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    mode: "unrestricted",
    binaries_allowlist: [],
    binary_paths: { npx: "/usr/bin/npx" },
    path_env: "/usr/bin",
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

describe("isNpmCommand", () => {
  it("detects the npm: prefix", () => {
    expect(isNpmCommand("npm:foo@1.0.0")).toBe(true);
    expect(isNpmCommand("npm:@scope/pkg@1.0.0")).toBe(true);
  });

  it("rejects commands that happen to contain npm", () => {
    expect(isNpmCommand("/usr/bin/npm")).toBe(false);
    expect(isNpmCommand("npm-cli-something")).toBe(false);
    expect(isNpmCommand("mcp-server-npm")).toBe(false);
    expect(isNpmCommand("")).toBe(false);
  });
});

describe("resolveNpmCommand — grammar: accept", () => {
  const policy = makePolicy();

  it("accepts unscoped package with exact semver", () => {
    const r = resolveNpmCommand("npm:mcp-server-git@0.6.2", policy);
    expect(r.packageName).toBe("mcp-server-git");
    expect(r.version).toBe("0.6.2");
    expect(r.resolvedCommand).toBe("/usr/bin/npx");
    expect(r.prependArgs).toEqual(["-y", "mcp-server-git@0.6.2"]);
  });

  it("accepts scoped package", () => {
    const r = resolveNpmCommand(
      "npm:@modelcontextprotocol/server-filesystem@1.2.3",
      policy,
    );
    expect(r.packageName).toBe("@modelcontextprotocol/server-filesystem");
    expect(r.version).toBe("1.2.3");
    expect(r.prependArgs).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem@1.2.3",
    ]);
  });

  it("accepts prerelease versions", () => {
    const r = resolveNpmCommand("npm:@scope/name@1.0.0-rc.1", policy);
    expect(r.version).toBe("1.0.0-rc.1");
  });

  it("accepts build metadata", () => {
    const r = resolveNpmCommand("npm:@scope/name@2.0.0+build.42", policy);
    expect(r.version).toBe("2.0.0+build.42");
  });

  it("accepts prerelease + build metadata combined", () => {
    const r = resolveNpmCommand("npm:pkg@1.0.0-alpha.1+sha.abc123", policy);
    expect(r.version).toBe("1.0.0-alpha.1+sha.abc123");
  });
});

describe("resolveNpmCommand — grammar: reject", () => {
  const policy = makePolicy();

  function rejects(cmd: string): A2EError {
    try {
      resolveNpmCommand(cmd, policy);
    } catch (e) {
      expect(e).toBeInstanceOf(A2EError);
      return e as A2EError;
    }
    throw new Error(`expected throw for ${cmd}`);
  }

  it("rejects missing version", () => {
    const e = rejects("npm:@scope/name");
    expect(e.code).toBe("PARSE_ERROR");
    expect(e.httpStatus).toBe(400);
  });

  it("rejects dist-tag instead of semver", () => {
    expect(rejects("npm:@scope/name@latest").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg@next").code).toBe("PARSE_ERROR");
  });

  it("rejects semver ranges", () => {
    expect(rejects("npm:@scope/name@^1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:@scope/name@~1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg@>=1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg@1.x").code).toBe("PARSE_ERROR");
  });

  it("rejects partial semver (missing patch)", () => {
    expect(rejects("npm:pkg@1.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg@1").code).toBe("PARSE_ERROR");
  });

  it("rejects empty and malformed shapes", () => {
    expect(rejects("npm:").code).toBe("PARSE_ERROR");
    expect(rejects("npm:@").code).toBe("PARSE_ERROR");
    expect(rejects("npm:@scope").code).toBe("PARSE_ERROR");
    expect(rejects("npm:@scope/").code).toBe("PARSE_ERROR");
    expect(rejects("npm:@scope/@1.0.0").code).toBe("PARSE_ERROR");
  });

  it("rejects uppercase (npm package names are lowercase)", () => {
    expect(rejects("npm:@Scope/Name@1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:BigPackage@1.0.0").code).toBe("PARSE_ERROR");
  });

  it("rejects shell-metacharacter attempts", () => {
    // All these fail grammar — nothing can sneak past spawn because spawn
    // uses shell:false, but we fail early with PARSE_ERROR for clarity.
    expect(rejects("npm:pkg;rm -rf@1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg|nc@1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg`whoami`@1.0.0").code).toBe("PARSE_ERROR");
    expect(rejects("npm:pkg$(id)@1.0.0").code).toBe("PARSE_ERROR");
  });
});

describe("resolveNpmCommand — capability gate", () => {
  it("throws CAPABILITY_DENIED when npx is not in the allowlist", () => {
    const policy = makePolicy({ binary_paths: {} });
    try {
      resolveNpmCommand("npm:@scope/name@1.0.0", policy);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(A2EError);
      const err = e as A2EError;
      expect(err.code).toBe("CAPABILITY_DENIED");
      expect(err.httpStatus).toBe(403);
      expect(err.message).toContain("npx");
      expect(err.message).toContain("binaries_allowlist");
    }
  });

  it("passes through the resolved npx path verbatim", () => {
    const policy = makePolicy({
      binary_paths: { npx: "/opt/homebrew/bin/npx" },
    });
    const r = resolveNpmCommand("npm:pkg@1.0.0", policy);
    expect(r.resolvedCommand).toBe("/opt/homebrew/bin/npx");
  });
});

describe("resolveNpmCommand — arg ordering", () => {
  it("prependArgs is always [-y, pkg@ver] regardless of package shape", () => {
    const policy = makePolicy();
    expect(resolveNpmCommand("npm:a@1.0.0", policy).prependArgs)
      .toEqual(["-y", "a@1.0.0"]);
    expect(resolveNpmCommand("npm:@s/b@2.3.4-rc.1", policy).prependArgs)
      .toEqual(["-y", "@s/b@2.3.4-rc.1"]);
  });
});
