/**
 * Unit tests for the bounded-verb parser (src/parser/parse.ts).
 *
 * Two concerns:
 *   1. Valid commands from the golden traces parse without error.
 *   2. Known-bad commands raise A2EError with the RIGHT code
 *      (PARSE_ERROR / INTERPOLATION_REJECTED / SCOPE_MISS).
 *
 * The AST shape is spot-checked — not exhaustively asserted — because the
 * golden-trace replay harness will do byte-exact validation once the runtime
 * dispatcher lands. Here we only care: parses, correct verb, correct error code.
 */

import { describe, it, expect } from "vitest";
import { parseProgram } from "../../src/parser/parse.js";
import { A2EError } from "../../src/errors.js";
import type {
  Program,
  Assignment,
  VerbCall,
  MetaCall,
  Block,
  ForeachBlock,
  IfBlock,
} from "../../src/parser/ast.js";

function parse(src: string): Program {
  return parseProgram(src);
}

function only<T>(p: Program): T {
  expect(p.stmts).toHaveLength(1);
  return p.stmts[0] as unknown as T;
}

function expectError(src: string, code: string, detailRe?: RegExp): void {
  try {
    parse(src);
    expect.fail(`expected A2EError but parse succeeded: ${src}`);
  } catch (e) {
    expect(e, `parsing '${src}' should throw A2EError`).toBeInstanceOf(A2EError);
    const err = e as A2EError;
    expect(err.code, `code for '${src}'`).toBe(code);
    if (detailRe) {
      expect(err.message).toMatch(detailRe);
    }
  }
}

// ===========================================================================
// Valid parses — extracted from tests/golden/bounded/*.trace.jsonl
// ===========================================================================

describe("parser — valid verb calls", () => {
  it("call GET <url> assignment", () => {
    const p = parse('$repos = call GET "https://api.github.com/orgs/nodejs/repos"');
    const stmt = only<Assignment>(p);
    expect(stmt.kind).toBe("assignment");
    expect(stmt.target).toBe("repos");
    expect(stmt.rhs.kind).toBe("call-http");
  });

  it("call <binary> with flags (jq example)", () => {
    const p = parse('call jq ".[] | .name"');
    const verb = only<VerbCall>(p);
    expect(verb.kind).toBe("call-cli");
    if (verb.kind === "call-cli") {
      expect(verb.binary).toBe("jq");
      expect(verb.args.length).toBeGreaterThan(0);
    }
  });

  it("filter ... where .field == bool", () => {
    const p = parse("$active = filter $repos where .archived == false");
    const stmt = only<Assignment>(p);
    expect(stmt.rhs.kind).toBe("filter");
  });

  it("transform pick field-list", () => {
    const p = parse("$s = transform $active pick a,b,c");
    const stmt = only<Assignment>(p);
    expect(stmt.rhs.kind).toBe("transform");
    if (stmt.rhs.kind === "transform") {
      expect(stmt.rhs.op.kind).toBe("pick");
      if (stmt.rhs.op.kind === "pick") {
        expect(stmt.rhs.op.fields).toEqual(["a", "b", "c"]);
      }
    }
  });

  it("save <value> as <name> --ttl <d>", () => {
    const p = parse("save $stats as stats_foo --ttl 300s");
    const verb = only<VerbCall>(p);
    expect(verb.kind).toBe("save");
    if (verb.kind === "save") {
      expect(verb.as).toBe("stats_foo");
      expect(verb.ttl?.ms).toBe(300_000);
    }
  });

  it("wait <duration>", () => {
    const p = parse("wait 30s");
    const verb = only<VerbCall>(p);
    expect(verb.kind).toBe("wait");
    if (verb.kind === "wait") {
      expect(verb.duration.ms).toBe(30_000);
    }
  });

  it("merge <a> <b> by .path --strategy inner", () => {
    const p = parse("$m = merge $a $b by .name --strategy inner");
    const stmt = only<Assignment>(p);
    expect(stmt.rhs.kind).toBe("merge");
    if (stmt.rhs.kind === "merge") {
      expect(stmt.rhs.strategy).toBe("inner");
    }
  });
});

describe("parser — valid meta calls", () => {
  for (const src of ["describe $x", "head $x", "head $x 3", "show $x", "env", "history", "history 5", "help", "help call"]) {
    it(`parses: ${src}`, () => {
      const p = parse(src);
      expect(p.stmts).toHaveLength(1);
      const stmt = p.stmts[0];
      expect(["describe", "head", "show", "env", "history", "help"]).toContain(stmt.kind);
    });
  }
});

describe("parser — valid blocks", () => {
  it("foreach with --parallel and body", () => {
    const src = [
      "foreach $repo in $repos --parallel=3 do",
      '  $stats = call GET "https://api.github.com/repos/${$repo.full_name}/stats"',
      '  save $stats as "stats_${$repo.name}" --ttl 300s',
      "end",
    ].join("\n");
    const p = parse(src);
    const blk = only<ForeachBlock>(p);
    expect(blk.kind).toBe("foreach");
    if (blk.kind === "foreach") {
      expect(blk.itemVar).toBe("repo");
      expect(blk.parallel).toBe(3);
      expect(blk.body.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("if ... else ... end with path comparison", () => {
    const src = [
      "if $rate.rate.remaining < 10 do",
      "  wait 30s",
      "else",
      "  wait 0s",
      "end",
    ].join("\n");
    const p = parse(src);
    const blk = only<IfBlock>(p);
    expect(blk.kind).toBe("if");
    if (blk.kind === "if") {
      expect(blk.elseBody).not.toBeNull();
    }
  });
});

describe("parser — valid literals & interpolation", () => {
  it("list of object literals", () => {
    const p = parse('$m = merge $a [{"name":"x","score":1}] by .name');
    expect(only<Assignment>(p).rhs.kind).toBe("merge");
  });

  it("interpolation with single-level path", () => {
    const p = parse('$x = call GET "https://x.com/${$token}"');
    expect(only<Assignment>(p).rhs.kind).toBe("call-http");
  });

  it("interpolation with nested path ${$a.b}", () => {
    const p = parse('$x = call GET "https://x.com/${$repo.full_name}"');
    expect(only<Assignment>(p).rhs.kind).toBe("call-http");
  });
});

// ===========================================================================
// Rejections — must throw with correct error code
// ===========================================================================

describe("parser — rejections", () => {
  it("raw bash rejected (PARSE_ERROR)", () => {
    expectError("curl -sS https://api.github.com/zen", "PARSE_ERROR");
  });

  it("command substitution $() rejected (PARSE_ERROR)", () => {
    expectError("call GET $(echo https://evil.com)", "PARSE_ERROR");
  });

  it("backtick command substitution rejected (PARSE_ERROR)", () => {
    expectError("call GET `cat url.txt`", "PARSE_ERROR");
  });

  it("shell chaining (&&) rejected (PARSE_ERROR)", () => {
    expectError("wait 1s && wait 2s", "PARSE_ERROR");
  });

  it("redirection rejected (PARSE_ERROR)", () => {
    expectError("show $x > out.txt", "PARSE_ERROR");
  });

  it("interpolation with expression rejected (INTERPOLATION_REJECTED)", () => {
    expectError(
      'call GET "https://x.com/${$user.name + \'x\'}"',
      "INTERPOLATION_REJECTED",
    );
  });

  it("interpolation with space in body rejected (INTERPOLATION_REJECTED)", () => {
    expectError(
      'call GET "https://x.com/${$user name}"',
      "INTERPOLATION_REJECTED",
    );
  });

  it("$_ assignment rejected (SCOPE_MISS, R5)", () => {
    expectError('$_ = call GET "https://x.com/"', "SCOPE_MISS", /reserved/);
  });

  it("block as assignment rhs rejected (R6)", () => {
    // "$x = foreach ... end" violates R6: block cannot be rhs.
    expectError(
      "$x = foreach $i in $items do\n  wait 1s\nend",
      "PARSE_ERROR",
    );
  });

  it("MAX_BLOCK_DEPTH exceeded rejected (R7)", () => {
    // 5 levels of foreach → exceeds MAX_BLOCK_DEPTH=4
    const src = [
      "foreach $a in [1] do",
      "  foreach $b in [1] do",
      "    foreach $c in [1] do",
      "      foreach $d in [1] do",
      "        foreach $e in [1] do",
      "          wait 1s",
      "        end",
      "      end",
      "    end",
      "  end",
      "end",
    ].join("\n");
    expectError(src, "PARSE_ERROR", /MAX_BLOCK_DEPTH/);
  });

  it("MAX_LINE_LENGTH exceeded rejected (R7)", () => {
    const big = "show " + "$x".repeat(2500);
    expectError(big, "PARSE_ERROR", /MAX_LINE_LENGTH/);
  });

  it("unknown verb rejected (PARSE_ERROR)", () => {
    expectError("launch $rockets", "PARSE_ERROR");
  });
});
