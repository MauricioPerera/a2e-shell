#!/usr/bin/env node
/**
 * Fake `npx` for integration tests of the RFC 003 `npm:` sugar.
 *
 * The real `npx` downloads from the registry, which we don't want in CI.
 * This shim mimics just enough of its contract:
 *
 *   1. argv must be `-y <pkg>@<ver> [...rest]` — otherwise exit non-zero.
 *   2. Re-exec Node on the path in FAKE_NPX_TARGET with [...rest] so the
 *      downstream MCP stdio fixture gets the correct user-supplied args.
 *   3. stdio is forwarded end-to-end (stdin, stdout, stderr all inherit)
 *      so the framing tests from the a2e-shell client still work.
 *
 * The shim logs a line to stderr describing what it saw — tests that want
 * to assert the exact args the resolver produced can capture that line.
 */

import { spawn } from "node:child_process";

const [, , flag, spec, ...rest] = process.argv;

if (flag !== "-y") {
  process.stderr.write(`fake-npx: expected flag '-y', got '${flag}'\n`);
  process.exit(101);
}
if (!spec || !spec.includes("@") || spec.length < 3) {
  process.stderr.write(`fake-npx: expected '<pkg>@<ver>', got '${spec}'\n`);
  process.exit(102);
}

const target = process.env.FAKE_NPX_TARGET;
if (!target) {
  process.stderr.write("fake-npx: FAKE_NPX_TARGET env var not set\n");
  process.exit(103);
}

process.stderr.write(`fake-npx: flag=${flag} spec=${spec} rest=${rest.join(",")}\n`);

const child = spawn(process.execPath, [target, ...rest], {
  stdio: ["inherit", "inherit", "inherit"],
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
