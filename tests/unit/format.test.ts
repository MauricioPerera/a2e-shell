import { describe, it, expect } from "vitest";
import { detectShape, format } from "../../src/io/format.js";

const enc = new TextEncoder();

describe("detectShape", () => {
  it("returns null for empty stdout", () => {
    expect(detectShape(new Uint8Array(0))).toBeNull();
  });

  it("classifies JSON array with inner type", () => {
    const s = detectShape(enc.encode(JSON.stringify([{ id: 1 }, { id: 2 }])));
    expect(s).toBe("json<Array<Object>>[2]");
  });

  it("classifies JSON array of strings", () => {
    const s = detectShape(enc.encode(JSON.stringify(["a", "b", "c"])));
    expect(s).toBe("json<Array<string>>[3]");
  });

  it("classifies JSON object", () => {
    const s = detectShape(enc.encode(JSON.stringify({ a: 1, b: 2, c: 3 })));
    expect(s).toBe("json<Object>[3]");
  });

  it("classifies JSON primitive", () => {
    expect(detectShape(enc.encode("42"))).toBe("json<number>");
    expect(detectShape(enc.encode('"hi"'))).toBe("json<string>");
    expect(detectShape(enc.encode("true"))).toBe("json<boolean>");
    expect(detectShape(enc.encode("null"))).toBe("json<null>");
  });

  it("classifies JSONL with multiple lines", () => {
    const s = detectShape(enc.encode('{"a":1}\n{"a":2}\n{"a":3}\n'));
    expect(s).toBe("jsonl[3]");
  });

  it("falls back to text when mixed content", () => {
    const s = detectShape(enc.encode("hello world\nnot json\n"));
    expect(s).toMatch(/^text\[\d+b\]$/);
  });

  it("classifies binary with null bytes", () => {
    const buf = new Uint8Array([0x48, 0x00, 0x65, 0x6c]);
    const s = detectShape(buf);
    expect(s).toBe("binary[4b]");
  });
});

describe("format", () => {
  it("emits error response when errorCode is set", () => {
    const r = format({
      exit_code: null,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
      errorCode: "CAPABILITY_DENIED",
      errorMessage: "binary 'rm' not in allowlist",
    });
    expect(r.status_line).toBe("[error: CAPABILITY_DENIED]");
    expect(r.shape).toBeNull();
    expect(r.preview).toBeNull();
    expect(r.binding).toBeNull();
    expect(r.stderr).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.error?.code).toBe("CAPABILITY_DENIED");
  });

  it("emits [exit 0] for successful intercept (exit_code=null, no error)", () => {
    const r = format({
      exit_code: null,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
    });
    expect(r.status_line).toBe("[exit 0]");
    expect(r.shape).toBeNull();
    expect(r.preview).toBeNull();
    expect(r.stderr).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("emits [exit N] for a successful spawn", () => {
    const r = format({
      exit_code: 0,
      stdout: enc.encode("hello\n"),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
    });
    expect(r.status_line).toBe("[exit 0]");
    expect(r.shape).toMatch(/^text\[\d+b\]$/);
    expect(r.preview).toBe("hello\n");
    expect(r.truncated).toBe(false);
  });

  it("attaches binding when bind_as is set", () => {
    const r = format({
      exit_code: 0,
      stdout: enc.encode("data"),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
      bind_as: "result",
    });
    expect(r.binding).toBe("$result");
  });

  it("parses JSON preview as object", () => {
    const r = format({
      exit_code: 0,
      stdout: enc.encode('{"a":1,"b":2}'),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
    });
    expect(r.preview).toEqual({ a: 1, b: 2 });
  });

  it("truncates preview at limit but reports true byte length in shape", () => {
    const big = "x".repeat(10_000);
    const r = format({
      exit_code: 0,
      stdout: enc.encode(big),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 100,
      stderr_bytes_limit: 2048,
    });
    expect(r.shape).toBe("text[10000b]");
    expect((r.preview as string).length).toBe(100);
  });

  it("surfaces stderr for non-zero exit", () => {
    const r = format({
      exit_code: 127,
      stdout: new Uint8Array(0),
      stderr: enc.encode("bash: frobnicate: command not found\n"),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
    });
    expect(r.status_line).toBe("[exit 127]");
    expect(r.stderr).toBe("bash: frobnicate: command not found\n");
  });

  it("surfaces stderr for successful exec with warnings", () => {
    const r = format({
      exit_code: 0,
      stdout: enc.encode("ok\n"),
      stderr: enc.encode("warning: deprecated flag\n"),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
    });
    expect(r.status_line).toBe("[exit 0]");
    expect(r.stderr).toBe("warning: deprecated flag\n");
  });

  it("truncates stderr at stderr_bytes_limit", () => {
    const big = "x".repeat(5000);
    const r = format({
      exit_code: 1,
      stdout: new Uint8Array(0),
      stderr: enc.encode(big),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 128,
    });
    expect((r.stderr as string).length).toBe(128);
  });

  it("surfaces truncated=true when upstream set it", () => {
    const r = format({
      exit_code: 0,
      stdout: enc.encode("partial"),
      stderr: new Uint8Array(0),
      preview_bytes_limit: 2048,
      stderr_bytes_limit: 2048,
      truncated: true,
    });
    expect(r.truncated).toBe(true);
  });
});
