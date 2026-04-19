import { describe, it, expect } from "vitest";
import {
  enforceBinaryAllowlist,
  resolvePolicy,
  type ResolvedPolicy,
} from "../../src/capabilities/policy.js";
import { A2EError } from "../../src/errors.js";

function makePolicy(allowlist: string[]): ResolvedPolicy {
  return {
    mode: "unrestricted",
    binaries_allowlist: allowlist,
    binary_paths: {},
    path_env: "",
    http_domains_allowlist: [],
    max_exec_timeout_ms: 30_000,
    max_response_bytes: 262_144,
    max_session_ttl_s: 3_600,
    preview_bytes: 2_048,
  };
}

describe("enforceBinaryAllowlist", () => {
  it("allows a binary in the allowlist", () => {
    expect(() =>
      enforceBinaryAllowlist("curl https://x", makePolicy(["curl"])),
    ).not.toThrow();
  });

  it("denies a binary NOT in the allowlist", () => {
    try {
      enforceBinaryAllowlist("rm -rf /", makePolicy(["curl"]));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as A2EError).code).toBe("CAPABILITY_DENIED");
    }
  });

  it("allows safe builtins even when absent from allowlist", () => {
    expect(() =>
      enforceBinaryAllowlist("echo hello", makePolicy([])),
    ).not.toThrow();
    expect(() =>
      enforceBinaryAllowlist("pwd", makePolicy([])),
    ).not.toThrow();
  });

  it("denies blocked builtins (eval, source, .)", () => {
    for (const b of ["eval", "source", "."]) {
      try {
        enforceBinaryAllowlist(`${b} whatever`, makePolicy([b]));
        expect.fail(`should have blocked '${b}'`);
      } catch (e) {
        expect((e as A2EError).code).toBe("CAPABILITY_DENIED");
      }
    }
  });

  it("denies command substitution", () => {
    expect(() =>
      enforceBinaryAllowlist("echo $(whoami)", makePolicy(["echo", "whoami"])),
    ).toThrowError(A2EError);
    expect(() =>
      enforceBinaryAllowlist("echo `whoami`", makePolicy(["echo", "whoami"])),
    ).toThrowError(A2EError);
  });

  it("enforces allowlist across pipe segments", () => {
    try {
      enforceBinaryAllowlist(
        "curl https://x | rm -rf /",
        makePolicy(["curl"]),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as A2EError).code).toBe("CAPABILITY_DENIED");
    }
  });

  it("enforces allowlist across && and ;", () => {
    expect(() =>
      enforceBinaryAllowlist("curl x && wget y", makePolicy(["curl"])),
    ).toThrowError(A2EError);
    expect(() =>
      enforceBinaryAllowlist("curl x; wget y", makePolicy(["curl"])),
    ).toThrowError(A2EError);
  });

  it("skips inline env assignments before the binary", () => {
    expect(() =>
      enforceBinaryAllowlist("FOO=bar curl https://x", makePolicy(["curl"])),
    ).not.toThrow();
  });

  it("ignores operators inside quoted strings", () => {
    expect(() =>
      enforceBinaryAllowlist(
        'echo "a | b; c"',
        makePolicy([]),
      ),
    ).not.toThrow();
  });
});

describe("resolvePolicy", () => {
  it("returns defaults when no overrides", () => {
    const p = resolvePolicy({ mode: "unrestricted" });
    expect(p.mode).toBe("unrestricted");
    expect(p.binaries_allowlist.length).toBeGreaterThan(0);
    expect(p.max_exec_timeout_ms).toBeGreaterThan(0);
  });

  it("accepts override of allowlist", () => {
    const p = resolvePolicy({
      mode: "unrestricted",
      overrides: { binaries_allowlist: ["only-this"] },
    });
    expect(p.binaries_allowlist).toEqual(["only-this"]);
  });

  it("deduplicates allowlist entries", () => {
    const p = resolvePolicy({
      mode: "unrestricted",
      overrides: { binaries_allowlist: ["curl", "curl", "jq"] },
    });
    expect(p.binaries_allowlist).toEqual(["curl", "jq"]);
  });
});
