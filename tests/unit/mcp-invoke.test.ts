import { describe, it, expect } from "vitest";
import { isMcpInvoke, parseInvoke, parseRead, parsePrompt } from "../../src/mcp/invoke.js";

describe("isMcpInvoke", () => {
  it("matches all three MCP verbs", () => {
    expect(isMcpInvoke("/bin/mcp-invoke")).toBe(true);
    expect(isMcpInvoke("/bin/mcp-invoke gh create_issue {}")).toBe(true);
    expect(isMcpInvoke("/bin/mcp-read gh catalog://docs/foo")).toBe(true);
    expect(isMcpInvoke("/bin/mcp-prompt gh greet {}")).toBe(true);
  });
  it("ignores leading whitespace", () => {
    expect(isMcpInvoke("   /bin/mcp-invoke gh a {}")).toBe(true);
    expect(isMcpInvoke("   /bin/mcp-read gh x://y")).toBe(true);
  });
  it("rejects similar-but-different paths", () => {
    expect(isMcpInvoke("/bin/mcp-invoker foo")).toBe(false);
    expect(isMcpInvoke("/bin/mcp-reader foo")).toBe(false);
    expect(isMcpInvoke("/bin/mcp-prompts foo")).toBe(false);
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

describe("parseRead", () => {
  it("parses server + uri", () => {
    const r = parseRead("/bin/mcp-read gh catalog://docs/example-api");
    expect(r.server).toBe("gh");
    expect(r.uri).toBe("catalog://docs/example-api");
  });
  it("accepts file:// URIs", () => {
    const r = parseRead("/bin/mcp-read fs file:///tmp/foo.txt");
    expect(r.uri).toBe("file:///tmp/foo.txt");
  });
  it("accepts URIs with query strings", () => {
    const r = parseRead("/bin/mcp-read api https://x.com/r?id=1&foo=bar");
    expect(r.uri).toBe("https://x.com/r?id=1&foo=bar");
  });
  it("rejects missing uri", () => {
    expect(() => parseRead("/bin/mcp-read gh")).toThrow(/missing resource uri/);
  });
  it("rejects obvious non-URIs", () => {
    expect(() => parseRead("/bin/mcp-read gh plainword")).toThrow(/does not look like/);
  });
});

describe("parsePrompt", () => {
  it("parses server + name + args", () => {
    const r = parsePrompt('/bin/mcp-prompt gh greet {"name":"world"}');
    expect(r.server).toBe("gh");
    expect(r.name).toBe("greet");
    expect(r.args).toEqual({ name: "world" });
  });
  it("allows empty args", () => {
    const r = parsePrompt("/bin/mcp-prompt gh greet");
    expect(r.args).toEqual({});
  });
  it("rejects missing name", () => {
    expect(() => parsePrompt("/bin/mcp-prompt gh")).toThrow(/missing prompt name/);
  });
  it("rejects non-object args", () => {
    expect(() => parsePrompt('/bin/mcp-prompt gh greet [1,2]')).toThrow(/JSON object/);
  });
});
