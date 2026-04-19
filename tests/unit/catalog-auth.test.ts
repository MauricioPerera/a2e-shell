import { describe, it, expect } from "vitest";
import { CatalogAuthSpec, CatalogSpec } from "../../src/io/protocol.js";

describe("CatalogAuthSpec schema", () => {
  it("accepts a token with default username", () => {
    const r = CatalogAuthSpec.safeParse({ type: "token", env_var: "GITHUB_TOKEN" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBe("x-access-token");
  });

  it("accepts a token with explicit username", () => {
    const r = CatalogAuthSpec.safeParse({ type: "token", env_var: "TOK", username: "bob" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBe("bob");
  });

  it("rejects env_var that is not UPPER_SNAKE_CASE", () => {
    expect(CatalogAuthSpec.safeParse({ type: "token", env_var: "lower" }).success).toBe(false);
    expect(CatalogAuthSpec.safeParse({ type: "token", env_var: "Mixed_Case" }).success).toBe(false);
    expect(CatalogAuthSpec.safeParse({ type: "token", env_var: "HAS-DASH" }).success).toBe(false);
  });

  it("rejects env_var starting with a digit", () => {
    expect(CatalogAuthSpec.safeParse({ type: "token", env_var: "1TOKEN" }).success).toBe(false);
  });

  it("rejects unknown auth types", () => {
    expect(
      CatalogAuthSpec.safeParse({ type: "basic", username: "u", password: "p" } as unknown).success,
    ).toBe(false);
  });

  it("accepts ssh_key with only key_path_env_var", () => {
    const r = CatalogAuthSpec.safeParse({ type: "ssh_key", key_path_env_var: "MY_KEY" });
    expect(r.success).toBe(true);
  });

  it("accepts ssh_key with known_hosts_env_var", () => {
    const r = CatalogAuthSpec.safeParse({
      type: "ssh_key",
      key_path_env_var: "MY_KEY",
      known_hosts_env_var: "MY_KH",
    });
    expect(r.success).toBe(true);
  });

  it("ssh_key rejects lowercase key_path_env_var", () => {
    const r = CatalogAuthSpec.safeParse({ type: "ssh_key", key_path_env_var: "my_key" });
    expect(r.success).toBe(false);
  });

  it("ssh_key without key_path_env_var → invalid", () => {
    const r = CatalogAuthSpec.safeParse({ type: "ssh_key" } as unknown);
    expect(r.success).toBe(false);
  });

  it("rejects empty username", () => {
    expect(
      CatalogAuthSpec.safeParse({ type: "token", env_var: "X", username: "" }).success,
    ).toBe(false);
  });
});

describe("CatalogSpec with auth", () => {
  it("accepts a catalog with auth", () => {
    const r = CatalogSpec.safeParse({
      repo_url: "https://github.com/o/r",
      auth: { type: "token", env_var: "GH" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a catalog without auth (public repo)", () => {
    const r = CatalogSpec.safeParse({ repo_url: "https://github.com/o/r" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.auth).toBeUndefined();
  });

  it("strict: rejects unknown top-level fields", () => {
    const r = CatalogSpec.safeParse({
      repo_url: "file:///x",
      surprise: 1,
    } as unknown);
    expect(r.success).toBe(false);
  });
});
