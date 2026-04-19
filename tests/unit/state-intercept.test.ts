import { describe, it, expect } from "vitest";
import { classify } from "../../src/exec/state-intercept.js";

describe("state-intercept.classify", () => {
  it("intercepts pure cd", () => {
    const r = classify("cd /tmp");
    expect(r.kind).toBe("intercept");
    if (r.kind === "intercept" && r.mutation.type === "cd") {
      expect(r.mutation.path).toBe("/tmp");
    } else {
      expect.fail("expected cd mutation");
    }
  });

  it("intercepts pure export", () => {
    const r = classify("export FOO=bar");
    expect(r.kind).toBe("intercept");
    if (r.kind === "intercept" && r.mutation.type === "export") {
      expect(r.mutation).toEqual({ type: "export", key: "FOO", value: "bar" });
    } else {
      expect.fail("expected export mutation");
    }
  });

  it("intercepts pure unset with one key", () => {
    const r = classify("unset FOO");
    expect(r.kind).toBe("intercept");
    if (r.kind === "intercept" && r.mutation.type === "unset") {
      expect(r.mutation.keys).toEqual(["FOO"]);
    }
  });

  it("intercepts pure unset with multiple keys", () => {
    const r = classify("unset FOO BAR BAZ");
    expect(r.kind).toBe("intercept");
    if (r.kind === "intercept" && r.mutation.type === "unset") {
      expect(r.mutation.keys).toEqual(["FOO", "BAR", "BAZ"]);
    }
  });

  it("does NOT intercept compound command", () => {
    expect(classify("cd /tmp && ls").kind).toBe("spawn");
    expect(classify("cd /tmp; ls").kind).toBe("spawn");
    expect(classify("cd /tmp | head").kind).toBe("spawn");
  });

  it("does NOT intercept regular commands", () => {
    expect(classify("ls -la").kind).toBe("spawn");
    expect(classify("echo hello").kind).toBe("spawn");
    expect(classify("curl https://example.com").kind).toBe("spawn");
  });

  it("does NOT intercept cd without argument", () => {
    expect(classify("cd").kind).toBe("spawn");
  });

  it("does NOT intercept export with quoted value", () => {
    expect(classify('export FOO="hello world"').kind).toBe("spawn");
  });

  it("does NOT intercept command substitution", () => {
    expect(classify("cd $(pwd)").kind).toBe("spawn");
    expect(classify("cd `pwd`").kind).toBe("spawn");
  });

  it("trims leading/trailing whitespace", () => {
    expect(classify("  cd /tmp  ").kind).toBe("intercept");
  });
});
