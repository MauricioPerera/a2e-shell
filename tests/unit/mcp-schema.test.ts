import { describe, it, expect } from "vitest";
import { McpServerSpec, McpServersArray } from "../../src/mcp/schema.js";

describe("McpServerSpec", () => {
  it("accepts minimal valid config", () => {
    const r = McpServerSpec.parse({ id: "gh", url: "https://example.com/mcp" });
    expect(r.id).toBe("gh");
    expect(r.transport).toBe("http");
    expect(r.timeout_ms).toBe(30_000);
  });

  it("accepts token auth with defaults", () => {
    const r = McpServerSpec.parse({
      id: "gh",
      url: "https://example.com/mcp",
      auth: { type: "token", env_var: "GH_TOKEN" },
    });
    expect(r.auth).toEqual({
      type: "token",
      env_var: "GH_TOKEN",
      scheme: "Bearer",
      header: "Authorization",
    });
  });

  it("rejects non-UPPER_SNAKE_CASE env var", () => {
    expect(() =>
      McpServerSpec.parse({
        id: "gh",
        url: "https://example.com/mcp",
        auth: { type: "token", env_var: "lowercase" },
      }),
    ).toThrow();
  });

  it("rejects bad server id", () => {
    expect(() =>
      McpServerSpec.parse({ id: "BadId", url: "https://example.com/mcp" }),
    ).toThrow();
    expect(() =>
      McpServerSpec.parse({ id: "1starts-with-digit", url: "https://example.com/mcp" }),
    ).toThrow();
  });

  it("accepts sse transport in rc.3", () => {
    const r = McpServerSpec.parse({ id: "gh", url: "https://example.com/mcp", transport: "sse" });
    expect(r.transport).toBe("sse");
  });

  it("rejects unknown transports", () => {
    expect(() =>
      McpServerSpec.parse({ id: "gh", url: "https://example.com/mcp", transport: "stdio" }),
    ).toThrow();
    expect(() =>
      McpServerSpec.parse({ id: "gh", url: "https://example.com/mcp", transport: "websocket" }),
    ).toThrow();
  });
});

describe("McpServersArray", () => {
  it("accepts empty array", () => {
    expect(McpServersArray.parse([])).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      McpServersArray.parse([
        { id: "gh", url: "https://a.com/mcp" },
        { id: "gh", url: "https://b.com/mcp" },
      ]),
    ).toThrow(/duplicate/);
  });

  it("rejects more than 8 servers", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      url: "https://x.com/mcp",
    }));
    expect(() => McpServersArray.parse(many)).toThrow(/up to 8/);
  });
});
