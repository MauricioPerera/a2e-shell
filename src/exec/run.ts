/**
 * Stateless subprocess executor.
 *
 * Contract:
 *   - Receives an already-interpolated command (no ${...} left).
 *   - Spawns: `bash -c <command>` with argv-array form. Never `shell: true`.
 *   - Inherits cwd + env from caller (session + policy PATH).
 *   - Enforces: timeout_ms (SIGKILL), max_response_bytes (streaming truncation).
 *   - Returns raw bytes. Redactor and formatter run AFTER.
 */

import { spawn } from "node:child_process";

export interface RunInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
}

export interface RunResult {
  readonly exit_code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly duration_ms: number;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

const BASH_PATH = process.env.A2E_BASH_PATH ?? "bash";

export async function run(input: RunInput): Promise<RunResult> {
  const start = Date.now();
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(BASH_PATH, ["-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeout_ms);

    child.stdout.on("data", (chunk: Buffer) => {
      const space = input.max_response_bytes - stdoutLen;
      if (space <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= space) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, space));
        stdoutLen += space;
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const space = input.max_response_bytes - stderrLen;
      if (space <= 0) return;
      if (chunk.length <= space) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, space));
        stderrLen += space;
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exit_code = timedOut
        ? 124
        : (code ?? (signal ? 128 : -1));
      resolve({
        exit_code,
        stdout: Buffer.concat(stdoutChunks, stdoutLen),
        stderr: Buffer.concat(stderrChunks, stderrLen),
        duration_ms: Date.now() - start,
        truncated,
        timed_out: timedOut,
      });
    });

    // stdin writes can throw (EPIPE) if the subprocess exits before reading.
    // Swallow such errors — the exit code already signals the failure and the
    // 'close' event will resolve this promise with the captured output.
    child.stdin.on("error", () => {});
    try {
      if (input.stdin !== undefined) {
        child.stdin.write(input.stdin);
      }
      child.stdin.end();
    } catch {
      /* EPIPE or similar; ignore */
    }
  });
}
