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
import * as fs from "node:fs";

export interface RunInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  /**
   * Optional streaming hooks. Called synchronously on every accepted chunk
   * (post-size-clipping), so the caller sees exactly the bytes that will end
   * up in the final buffer. Uncalled beyond the cap — `truncated` on the
   * final RunResult signals the caller that the stream was cut.
   */
  readonly onStdout?: (chunk: Uint8Array) => void;
  readonly onStderr?: (chunk: Uint8Array) => void;
}

export interface RunResult {
  readonly exit_code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly duration_ms: number;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/**
 * Resolve an absolute path to bash at module load. Using an absolute path on
 * spawn means the subprocess's PATH (built from the capability allowlist) is
 * irrelevant for finding bash itself — the shell that runs the LLM's command
 * is never gated by the allowlist, only the binaries the command invokes.
 */
const BASH_PATH = resolveBashPath();

function resolveBashPath(): string {
  const override = process.env.A2E_BASH_PATH;
  if (override) return override;
  const candidates = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch { /* try next */ }
  }
  // Fallback to bare name; spawn will use the parent process's PATH.
  return "bash";
}

/** Exposed so tests can verify resolution happened. */
export const RESOLVED_BASH_PATH = BASH_PATH;

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
      let accepted: Buffer;
      if (chunk.length <= space) {
        accepted = chunk;
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      } else {
        // Defensive copy: subarray shares memory with the source Buffer. If
        // any downstream consumer (redactor, formatter) were to mutate bytes,
        // the original pool could surface stale data. Buffer.from clones.
        accepted = Buffer.from(chunk.subarray(0, space));
        stdoutChunks.push(accepted);
        stdoutLen += space;
        truncated = true;
      }
      if (input.onStdout) input.onStdout(accepted);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const space = input.max_response_bytes - stderrLen;
      if (space <= 0) return;
      let accepted: Buffer;
      if (chunk.length <= space) {
        accepted = chunk;
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      } else {
        accepted = Buffer.from(chunk.subarray(0, space));
        stderrChunks.push(accepted);
        stderrLen += space;
      }
      if (input.onStderr) input.onStderr(accepted);
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
