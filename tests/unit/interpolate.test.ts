import { describe, it, expect } from "vitest";
import { interpolate, type Bindings } from "../../src/exec/interpolate.js";
import { A2EError } from "../../src/errors.js";

function bindings(obj: Record<string, string>): Bindings {
  return new Map(Object.entries(obj).map(([k, v]) => [
    k,
    { value: v, shape: `text[${v.length}b]`, size_bytes: v.length },
  ]));
}

describe("interpolate", () => {
  it("resolves a single ${$name} token", () => {
    const out = interpolate("echo ${$greeting}", bindings({ greeting: "hi" }));
    expect(out).toBe("echo hi");
  });

  it("resolves multiple tokens in one command", () => {
    const out = interpolate(
      "echo ${$a} and ${$b}",
      bindings({ a: "x", b: "y" }),
    );
    expect(out).toBe("echo x and y");
  });

  it("passes through commands with no interpolation", () => {
    expect(interpolate("ls -la", new Map())).toBe("ls -la");
    expect(interpolate("echo $HOME", new Map())).toBe("echo $HOME");
  });

  it("rejects ${$var.field}", () => {
    expect(() =>
      interpolate("echo ${$data.user.id}", bindings({ data: "{}" })),
    ).toThrowError(A2EError);
    try {
      interpolate("echo ${$data.user.id}", bindings({ data: "{}" }));
    } catch (e) {
      expect((e as A2EError).code).toBe("INTERPOLATION_REJECTED");
    }
  });

  it("rejects ${VAR} (bash-style)", () => {
    expect(() => interpolate("echo ${HOME}", new Map())).toThrowError(A2EError);
  });

  it("rejects ${$var[0]}", () => {
    expect(() =>
      interpolate("echo ${$xs[0]}", bindings({ xs: "[]" })),
    ).toThrowError(A2EError);
  });

  it("rejects ${$a + 1}", () => {
    expect(() =>
      interpolate("echo ${$a + 1}", bindings({ a: "1" })),
    ).toThrowError(A2EError);
  });

  it("rejects empty ${}", () => {
    expect(() => interpolate("echo ${}", new Map())).toThrowError(A2EError);
  });

  it("throws SCOPE_MISS for unknown bindings", () => {
    try {
      interpolate("echo ${$unknown}", new Map());
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as A2EError).code).toBe("SCOPE_MISS");
    }
  });

  it("preserves unicode in binding values", () => {
    const out = interpolate("echo ${$msg}", bindings({ msg: "hola 🌍" }));
    expect(out).toBe("echo hola 🌍");
  });
});
