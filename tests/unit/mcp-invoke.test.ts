import { describe, it, expect } from "vitest";
import { isMcpInvoke, parseInvoke } from "../../src/mcp/invoke.js";

describe("isMcpInvoke", () => {
  it("matches bare prefix", () => {
    expect(isMcpInvoke("/bin/mcp-invoke")).toBe(true);
  });
  it("matches prefix + space", () => {
    expect(isMcpInvoke("/bin/mcp-invoke gh create_issue {}")).toBe(true);
  });
  it("ignores leading whitespace", () => {
    expect(isMcpInvoke("   /bin/mcp-invoke gh a {}")).toBe(true);
  });
  it("rejects similar-but-different paths", () => {
    expect(isMcpInvoke("/bin/mcp-invoker foo")).toBe(false);
    expect(isMcpInvoke("/bin/mcp foo")).toBe(false);
    expect(isMcpInvoke("mcp-invoke gh a {}")).toBe(false);
  });
  it("rejects plain bash command", () => {
    expect(isMcpInvoke("curl -sS https://example.com")).toBe(false);
  });
});

describe("parseInvoke", () => {
  it("parses basic form", () => {
    const r = parseInvoke('/bin/mcp-invoke gh get_issue {"owner":"a","repo":"b","issue":1}');
    expect(r.server).toBe("gh");
    expect(r.tool).toBe("get_issue");
    expect(r.args).toEqual({ owner: "a", repo: "b", issue: 1 });
  });

  it("accepts empty args", () => {
    const r = parseInvoke("/bin/mcp-invoke gh list_repos {}");
    expect(r.args).toEqual({});
  });

  it("accepts args with spaces inside JSON strings", () => {
    const r = parseInvoke(
      '/bin/mcp-invoke gh create_issue {"title":"hello world","body":"multi line\\ntext"}',
    );
    expect(r.args).toEqual({ title: "hello world", body: "multi line\ntext" });
  });

  it("rejects missing tool", () => {
    expect(() => parseInvoke("/bin/mcp-invoke gh")).toThrow(/missing tool/);
  });

  it("rejects invalid server id", () => {
    expect(() => parseInvoke("/bin/mcp-invoke 9bad tool {}")).toThrow(/invalid server id/);
    expect(() => parseInvoke("/bin/mcp-invoke Foo tool {}")).toThrow(/invalid server id/);
  });

  it("rejects invalid tool name", () => {
    expect(() => parseInvoke("/bin/mcp-invoke gh @bad {}")).toThrow(/invalid tool name/);
  });

  it("rejects malformed JSON args", () => {
    expect(() => parseInvoke("/bin/mcp-invoke gh tool {invalid}")).toThrow(/valid JSON/);
  });

  it("rejects non-object args", () => {
    expect(() => parseInvoke("/bin/mcp-invoke gh tool [1,2,3]")).toThrow(/JSON object/);
    expect(() => parseInvoke("/bin/mcp-invoke gh tool null")).toThrow(/JSON object/);
    expect(() => parseInvoke('/bin/mcp-invoke gh tool "str"')).toThrow(/JSON object/);
  });

  it("tolerates leading whitespace", () => {
    const r = parseInvoke("  /bin/mcp-invoke gh a {}");
    expect(r.server).toBe("gh");
    expect(r.tool).toBe("a");
  });
});
