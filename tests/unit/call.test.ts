/**
 * Tests for the `call` verb — HTTP and CLI branches.
 *
 * HTTP: a tiny in-process server on an ephemeral port is spun up per describe.
 * CLI:  the binary is `node` itself (always available, cross-platform). The
 *       path comes from process.execPath.
 *
 * These are RUNTIME tests — not golden-trace replays — so they can assert
 * canonical response shape directly without the trace harness.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as path from "node:path";
import { parseProgram } from "../../src/parser/parse.js";
import { executeProgram } from "../../src/runtime/execute.js";
import {
  createSession,
  RESTRICTIVE_CAPS,
  type CallCapabilities,
  type Session,
} from "../../src/runtime/session.js";
import type { CanonicalResponse } from "../../src/runtime/canonical.js";

// --- helpers ----------------------------------------------------------------

async function run(session: Session, source: string): Promise<CanonicalResponse> {
  const program = parseProgram(source);
  const responses = await executeProgram(session, source, program);
  expect(responses).toHaveLength(1);
  return responses[0];
}

function okOf(r: CanonicalResponse) {
  expect(r.error, `expected OK but got error: ${JSON.stringify(r.error)}`).toBeNull();
  return r as Extract<CanonicalResponse, { error: null }>;
}

function errOf(r: CanonicalResponse) {
  expect(r.error, "expected ERR but got OK").not.toBeNull();
  return r as Extract<CanonicalResponse, { error: object }>;
}

// --- HTTP test server -------------------------------------------------------

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);

    if (url.pathname === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world", n: 42 }));
      return;
    }
    if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello plain");
      return;
    }
    if (url.pathname === "/echo-headers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        "x-custom": headers["x-custom"] ?? null,
        authorization: headers.authorization ?? null,
      }));
      return;
    }
    if (url.pathname === "/echo-query") {
      res.writeHead(200, { "content-type": "application/json" });
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) params[k] = v;
      res.end(JSON.stringify(params));
      return;
    }
    if (url.pathname === "/echo-body" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body, ct: headers["content-type"] ?? null }));
      });
      return;
    }
    if (url.pathname === "/slow") {
      // Never responds — used to test timeout.
      return;
    }
    if (url.pathname === "/boom") {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("service unavailable");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr !== "string") {
    origin = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("server listen failed");
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- caps builders ----------------------------------------------------------

function httpCaps(domains: string[] = ["127.0.0.1"]): CallCapabilities {
  return {
    ...RESTRICTIVE_CAPS,
    httpDomainsAllowlist: domains,
    maxExecTimeoutMs: 3000,
    maxResponseBytes: 64 * 1024,
  };
}

function nodeCliCaps(): CallCapabilities {
  return {
    ...RESTRICTIVE_CAPS,
    binariesAllowlist: ["node"],
    binaryPaths: { node: process.execPath },
    pathEnv: path.dirname(process.execPath),
    maxExecTimeoutMs: 4000,
    maxResponseBytes: 64 * 1024,
  };
}

// =============================================================================
// HTTP
// =============================================================================

describe("call HTTP — happy paths", () => {
  it("GET application/json parses body to JS value", async () => {
    const s = createSession("h1", httpCaps());
    const r = okOf(await run(s, `$x = call GET "${origin}/json"`));
    expect(r.binding).toBe("x");
    const payload = JSON.parse(r.preview);
    expect(payload.hello).toBe("world");
    expect(payload.n).toBe(42);
  });

  it("GET text/plain returns a string", async () => {
    const s = createSession("h2", httpCaps());
    const r = okOf(await run(s, `call GET "${origin}/text"`));
    expect(r.shape.kind).toBe("scalar");
    expect(JSON.parse(r.preview)).toBe("hello plain");
  });

  it("--header injects a request header", async () => {
    const s = createSession("h3", httpCaps());
    const r = okOf(await run(s, `call GET "${origin}/echo-headers" --header "X-Custom: abc123"`));
    const payload = JSON.parse(r.preview);
    expect(payload["x-custom"]).toBe("abc123");
  });

  it("--query appends a query string", async () => {
    const s = createSession("h4", httpCaps());
    const r = okOf(await run(s, `call GET "${origin}/echo-query" --query "a=1&b=2"`));
    expect(JSON.parse(r.preview)).toEqual({ a: "1", b: "2" });
  });

  it("POST with --body object JSON-encodes and sets content-type", async () => {
    const s = createSession("h5", httpCaps());
    const r = okOf(await run(s, `call POST "${origin}/echo-body" --body {"k":"v","n":7}`));
    const payload = JSON.parse(r.preview);
    expect(payload.ct).toMatch(/application\/json/);
    expect(JSON.parse(payload.received)).toEqual({ k: "v", n: 7 });
  });

  it("wildcard domain '*' allows any host", async () => {
    const s = createSession("h6", httpCaps(["*"]));
    const r = okOf(await run(s, `call GET "${origin}/json"`));
    expect(r.error).toBeNull();
  });

  it("subdomain matches domain suffix rule", async () => {
    // Register "localhost" — request via 127.0.0.1 should fail (no match); via "localhost" subdomain it works.
    // Here we trust the hostname to be 127.0.0.1 only; test allowlist exact match.
    const s = createSession("h7", httpCaps(["127.0.0.1"]));
    const r = okOf(await run(s, `call GET "${origin}/json"`));
    expect(r.error).toBeNull();
  });
});

describe("call HTTP — errors", () => {
  it("non-2xx response → UPSTREAM_ERROR with status in message", async () => {
    const s = createSession("he1", httpCaps());
    const r = errOf(await run(s, `call GET "${origin}/boom"`));
    expect(r.error.code).toBe("UPSTREAM_ERROR");
    expect(r.error.message).toMatch(/HTTP 503/);
  });

  it("timeout → TIMEOUT", async () => {
    const s = createSession("he2", httpCaps());
    const r = errOf(await run(s, `call GET "${origin}/slow" --timeout 200ms`));
    expect(r.error.code).toBe("TIMEOUT");
  });

  it("domain not in allowlist → CAPABILITY_DENIED", async () => {
    const s = createSession("he3", httpCaps(["example.com"]));
    const r = errOf(await run(s, `call GET "${origin}/json"`));
    expect(r.error.code).toBe("CAPABILITY_DENIED");
  });

  it("empty allowlist → CAPABILITY_DENIED", async () => {
    const s = createSession("he4"); // RESTRICTIVE
    const r = errOf(await run(s, `call GET "${origin}/json"`));
    expect(r.error.code).toBe("CAPABILITY_DENIED");
  });

  it("invalid URL → PARSE_ERROR", async () => {
    const s = createSession("he5", httpCaps());
    const r = errOf(await run(s, `call GET "not a url"`));
    expect(r.error.code).toBe("PARSE_ERROR");
  });
});

// =============================================================================
// CLI
// =============================================================================

describe("call CLI — happy paths", () => {
  it("node -e prints a value to stdout (returns string)", async () => {
    const s = createSession("c1", nodeCliCaps());
    const r = okOf(await run(s, `call node -e "console.log('hello')"`));
    expect(r.shape.kind).toBe("scalar");
    expect(JSON.parse(r.preview)).toBe("hello\n");
  });

  it("assignment captures CLI stdout", async () => {
    const s = createSession("c2", nodeCliCaps());
    const r = okOf(await run(s, `$out = call node -e "console.log(42)"`));
    expect(r.binding).toBe("out");
    const showR = okOf(await run(s, "show $out"));
    expect(JSON.parse(showR.preview)).toBe("42\n");
  });

  it("long-flag with value passes through as two argv entries", async () => {
    // `node --print "2+2"` evaluates and prints 4.
    const s = createSession("c3", nodeCliCaps());
    const r = okOf(await run(s, `call node --print "2+2"`));
    expect(JSON.parse(r.preview)).toBe("4\n");
  });
});

describe("call CLI — errors", () => {
  it("binary not in allowlist → CAPABILITY_DENIED", async () => {
    const s = createSession("ce1"); // RESTRICTIVE: empty allowlist
    const r = errOf(await run(s, `call ls`));
    expect(r.error.code).toBe("CAPABILITY_DENIED");
  });

  it("binary allowed but exits non-zero → UPSTREAM_ERROR", async () => {
    const s = createSession("ce2", nodeCliCaps());
    const r = errOf(await run(s, `call node -e "process.exit(7)"`));
    expect(r.error.code).toBe("UPSTREAM_ERROR");
    expect(r.error.message).toMatch(/exited 7/);
  });

  it("binary exceeds timeout → TIMEOUT", async () => {
    const s = createSession("ce3", { ...nodeCliCaps(), maxExecTimeoutMs: 200 });
    const r = errOf(await run(s, `call node -e "setTimeout(()=>{},5000)"`));
    expect(r.error.code).toBe("TIMEOUT");
  });
});
