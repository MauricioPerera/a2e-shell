/**
 * Canonical output formatter. ALL exec responses pass through here.
 * Contract: produces { status_line, shape, preview, binding }.
 * The redactor MUST run before this module; this module does not scrub.
 */

import type { ExecResponse } from "./protocol.js";
import type { ErrorCode } from "../errors.js";

export interface FormatInput {
  readonly exit_code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly bind_as?: string;
  readonly preview_bytes_limit: number;
  readonly stderr_bytes_limit: number;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
  readonly truncated?: boolean;
}

const MAX_SAMPLE_BYTES_FOR_SHAPE = 65_536;

/**
 * Classify stdout shape.
 * Returns null only when stdout is empty AND the result is not an error.
 */
export function detectShape(stdout: Uint8Array): string | null {
  if (stdout.length === 0) return null;
  const sample = stdout.length > MAX_SAMPLE_BYTES_FOR_SHAPE
    ? stdout.subarray(0, MAX_SAMPLE_BYTES_FOR_SHAPE)
    : stdout;

  if (hasNullByte(sample)) {
    return `binary[${stdout.length}b]`;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(sample);

  const trimmed = text.trim();
  if (trimmed.length > 0) {
    const parsed = tryParseJson(trimmed);
    if (parsed.ok && stdout.length <= MAX_SAMPLE_BYTES_FOR_SHAPE) {
      return jsonShape(parsed.value);
    }
  }

  const jsonlCount = countJsonLines(text);
  if (jsonlCount.total >= 2 && jsonlCount.valid === jsonlCount.total) {
    return `jsonl[${jsonlCount.total}]`;
  }

  return `text[${stdout.length}b]`;
}

function hasNullByte(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function tryParseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function jsonShape(v: unknown): string {
  if (v === null) return "json<null>";
  if (Array.isArray(v)) {
    const inner = v.length === 0 ? "unknown" : jsonInnerType(v[0]);
    return `json<Array<${inner}>>[${v.length}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    return `json<Object>[${keys.length}]`;
  }
  return `json<${typeof v}>`;
}

function jsonInnerType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "Array";
  if (typeof v === "object") return "Object";
  return typeof v;
}

function countJsonLines(text: string): { valid: number; total: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let valid = 0;
  for (const ln of lines) {
    try {
      JSON.parse(ln);
      valid++;
    } catch {
      /* not json */
    }
  }
  return { valid, total: lines.length };
}

export function format(input: FormatInput): ExecResponse {
  if (input.errorCode) {
    return {
      status_line: `[error: ${input.errorCode}]`,
      shape: null,
      preview: null,
      binding: null,
      stderr: null,
      truncated: false,
      error: {
        code: input.errorCode,
        message: input.errorMessage ?? input.errorCode,
      },
    };
  }

  if (input.exit_code === null) {
    // Intercept success path (cd / export / unset).
    return {
      status_line: "[exit 0]",
      shape: null,
      preview: null,
      binding: null,
      stderr: null,
      truncated: false,
    };
  }

  const shape = detectShape(input.stdout);
  const preview = buildPreview(input.stdout, shape, input.preview_bytes_limit);
  const binding = input.bind_as ? `$${input.bind_as}` : null;
  const stderr = buildStderr(input.stderr, input.stderr_bytes_limit);

  return {
    status_line: `[exit ${input.exit_code}]`,
    shape,
    preview,
    binding,
    stderr,
    truncated: input.truncated === true,
  };
}

function buildStderr(stderr: Uint8Array, limit: number): string | null {
  if (stderr.length === 0) return null;
  const slice = stderr.length > limit ? stderr.subarray(0, limit) : stderr;
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

function buildPreview(
  stdout: Uint8Array,
  shape: string | null,
  limit: number,
): unknown {
  if (stdout.length === 0) return null;
  const slice = stdout.length > limit ? stdout.subarray(0, limit) : stdout;

  if (shape && shape.startsWith("binary")) {
    return `<${stdout.length} bytes of binary data>`;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);

  if (shape && shape.startsWith("json<")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}
