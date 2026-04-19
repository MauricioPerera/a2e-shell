import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeReachability, writeReachability } from "../../src/catalog/reachability.js";

function writeIndex(root: string, data: { manifest: unknown; partitions: Record<string, unknown> }): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(data.manifest));
  for (const [name, part] of Object.entries(data.partitions)) {
    fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(part));
  }
}

describe("computeReachability", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("marks all skills reachable when their requires are in allowlist", () => {
    writeIndex(tmp, {
      manifest: { categories: { skills: { path: "skills.json" } } },
      partitions: {
        skills: { entries: { a: { requires: ["curl", "jq"] }, b: { requires: ["date"] } } },
      },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: ["curl", "jq", "date"] } });
    expect(r.summary).toEqual({ total: 2, reachable: 2, unreachable: 0 });
    expect(r.by_category.skills!.a!.reachable).toBe(true);
    expect(r.by_category.skills!.b!.reachable).toBe(true);
  });

  it("marks a skill unreachable when any requires is absent", () => {
    writeIndex(tmp, {
      manifest: { categories: { skills: { path: "skills.json" } } },
      partitions: { skills: { entries: { x: { requires: ["curl", "aws"] } } } },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: ["curl"] } });
    expect(r.summary).toEqual({ total: 1, reachable: 0, unreachable: 1 });
    expect(r.by_category.skills!.x).toEqual({ reachable: false, missing_binaries: ["aws"] });
  });

  it("treats safe builtins as reachable without allowlist", () => {
    writeIndex(tmp, {
      manifest: { categories: { skills: { path: "skills.json" } } },
      partitions: { skills: { entries: { e: { requires: ["echo", "printf"] } } } },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: [] } });
    expect(r.summary.reachable).toBe(1);
  });

  it("marks blocked builtins as unreachable", () => {
    writeIndex(tmp, {
      manifest: { categories: { skills: { path: "skills.json" } } },
      partitions: { skills: { entries: { bad: { requires: ["eval"] } } } },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: ["eval"] } });
    expect(r.summary.reachable).toBe(0);
    expect(r.by_category.skills!.bad!.missing_binaries).toEqual(["eval"]);
  });

  it("treats non-skill categories as always reachable", () => {
    writeIndex(tmp, {
      manifest: {
        categories: {
          docs:      { path: "docs.json" },
          prompts:   { path: "prompts.json" },
          templates: { path: "templates.json" },
        },
      },
      partitions: {
        docs:      { entries: { d1: {} } },
        prompts:   { entries: { p1: {} } },
        templates: { entries: { t1: {} } },
      },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: [] } });
    expect(r.summary).toEqual({ total: 3, reachable: 3, unreachable: 0 });
  });

  it("handles empty requires as reachable", () => {
    writeIndex(tmp, {
      manifest: { categories: { skills: { path: "skills.json" } } },
      partitions: { skills: { entries: { noop: {} } } },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: [] } });
    expect(r.summary.reachable).toBe(1);
  });

  it("skips a category whose partition file is missing", () => {
    writeIndex(tmp, {
      manifest: {
        categories: {
          skills: { path: "skills.json" },
          ghost:  { path: "ghost.json" },
        },
      },
      partitions: { skills: { entries: { a: { requires: [] } } } },
    });
    const r = computeReachability({ indexDir: tmp, policy: { binaries_allowlist: [] } });
    expect(r.summary.total).toBe(1);
    expect(r.by_category.ghost).toBeUndefined();
  });

  it("writeReachability emits valid JSON at the expected path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-"));
    const report = {
      schema_version: "1.0" as const,
      computed_at: new Date().toISOString(),
      by_category: {},
      summary: { total: 0, reachable: 0, unreachable: 0 },
    };
    const out = writeReachability(root, report);
    expect(out).toBe(path.join(root, "reachability.json"));
    const round = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(round.schema_version).toBe("1.0");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
