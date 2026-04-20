/**
 * Canonical response builder for the bounded-verb shell.
 *
 * Every verb/meta execution funnels through canonicalOk() or canonicalErr().
 * The shape of the response is fixed (RFC §2.2):
 *
 *   { status_line, shape, preview, binding, stderr, truncated, error }
 *
 * Preview is truncated to PREVIEW_MAX_BYTES with a "…+Nmore" marker appended
 * when truncation occurs. `shape.bytes` always reports the pre-truncation size.
 */

import type { RuntimeValue } from "./session.js";

export const PREVIEW_MAX_BYTES = 512;

export type ShapeKind = "scalar" | "record" | "list" | "table" | "bytes" | "void";

export interface Shape {
  kind: ShapeKind;
  /** Present for list/table. */
  rows?: number;
  /** Present for table. */
  cols?: number;
  /** Keys of record, or sampled keys of table/list items. */
  keys?: string[];
  /** Serialised-size upper bound. For bytes: raw byte length. */
  bytes: number;
}

export interface CanonicalOk {
  status_line: string;
  shape: Shape;
  preview: string;
  binding: string | null;
  stderr: "";
  truncated: boolean;
  error: null;
}

export interface CanonicalErr {
  status_line: string;
  shape: null;
  preview: null;
  binding: null;
  stderr: string;
  truncated: false;
  error: { code: string; message: string };
}

export type CanonicalResponse = CanonicalOk | CanonicalErr;

// --- shape inference --------------------------------------------------------

export function inferShape(value: RuntimeValue): Shape {
  if (value === null) return { kind: "scalar", bytes: 4 };
  if (Buffer.isBuffer(value)) return { kind: "bytes", bytes: value.length };
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    return { kind: "scalar", bytes };
  }
  if (Array.isArray(value)) {
    const rows = value.length;
    const sample = value[0];
    // Heuristic: table if every item is a plain record with same key set.
    if (
      rows > 0 &&
      isPlainRecord(sample) &&
      value.every((v) => isPlainRecord(v))
    ) {
      const keys = Object.keys(sample as Record<string, RuntimeValue>);
      const homogeneous = value.every((v) => sameKeys(keys, v as Record<string, RuntimeValue>));
      if (homogeneous) {
        const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        return { kind: "table", rows, cols: keys.length, keys, bytes };
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    // Fall back to list; if items are records, sample keys of the first one.
    const keys = isPlainRecord(sample)
      ? Object.keys(sample as Record<string, RuntimeValue>)
      : undefined;
    return keys !== undefined
      ? { kind: "list", rows, keys, bytes }
      : { kind: "list", rows, bytes };
  }
  // Plain record.
  const rec = value as Record<string, RuntimeValue>;
  const keys = Object.keys(rec);
  const bytes = Buffer.byteLength(JSON.stringify(rec), "utf8");
  return { kind: "record", keys, bytes };
}

function isPlainRecord(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !Buffer.isBuffer(v)
  );
}

function sameKeys(ref: string[], other: Record<string, RuntimeValue>): boolean {
  const otherKeys = Object.keys(other);
  if (otherKeys.length !== ref.length) return false;
  for (const k of ref) if (!(k in other)) return false;
  return true;
}

// --- preview ----------------------------------------------------------------

export function buildPreview(value: RuntimeValue, shape: Shape): { preview: string; truncated: boolean } {
  if (shape.kind === "bytes") {
    // Always render bytes as hex + ellipsis to keep it LLM-safe.
    const buf = value as Buffer;
    const head = buf.subarray(0, Math.min(PREVIEW_MAX_BYTES, buf.length)).toString("hex");
    return { preview: head, truncated: buf.length > PREVIEW_MAX_BYTES };
  }
  const full = JSON.stringify(value);
  if (full === undefined) {
    return { preview: "", truncated: false };
  }
  if (Buffer.byteLength(full, "utf8") <= PREVIEW_MAX_BYTES) {
    return { preview: full, truncated: false };
  }
  // Truncate by rows for list/table, by bytes for everything else.
  if ((shape.kind === "list" || shape.kind === "table") && Array.isArray(value) && value.length > 0) {
    // Binary search-ish: start with 3 rows, expand if under budget.
    let keep = Math.min(value.length, 3);
    while (keep > 0) {
      const preview = JSON.stringify(value.slice(0, keep)).replace(/\]$/, `, ...+${value.length - keep}more]`);
      if (Buffer.byteLength(preview, "utf8") <= PREVIEW_MAX_BYTES) {
        return { preview, truncated: true };
      }
      keep -= 1;
    }
    return { preview: `[...+${value.length}more]`, truncated: true };
  }
  // Byte-level truncation for scalars / records.
  const buf = Buffer.from(full, "utf8");
  const head = buf.subarray(0, PREVIEW_MAX_BYTES).toString("utf8");
  return { preview: head + "…", truncated: true };
}

// --- response builders ------------------------------------------------------

function describeShape(shape: Shape): string {
  switch (shape.kind) {
    case "scalar": return `scalar[${shape.bytes}B]`;
    case "record": return `record[${shape.keys?.length ?? 0}keys]`;
    case "list":   return `list[${shape.rows}]`;
    case "table":  return `table[${shape.rows}x${shape.cols}]`;
    case "bytes":  return `bytes[${shape.bytes}B]`;
    case "void":   return `void`;
  }
}

export function canonicalOk(params: {
  verb: string;
  value: RuntimeValue;
  binding: string | null;
  durationMs: number;
}): CanonicalOk {
  const shape = inferShape(params.value);
  const { preview, truncated } = buildPreview(params.value, shape);
  return {
    status_line: `OK | ${params.verb} → ${describeShape(shape)} in ${params.durationMs}ms`,
    shape,
    preview,
    binding: params.binding,
    stderr: "",
    truncated,
    error: null,
  };
}

export function canonicalVoid(params: {
  verb: string;
  durationMs: number;
  note?: string;
}): CanonicalOk {
  return {
    status_line: `OK | ${params.verb} → void in ${params.durationMs}ms`,
    shape: { kind: "void", bytes: 0 },
    preview: params.note ?? "",
    binding: null,
    stderr: "",
    truncated: false,
    error: null,
  };
}

export function canonicalErr(params: {
  code: string;
  message: string;
  stderr?: string;
}): CanonicalErr {
  return {
    status_line: `ERR | ${params.code}`,
    shape: null,
    preview: null,
    binding: null,
    stderr: params.stderr ?? "",
    truncated: false,
    error: { code: params.code, message: params.message },
  };
}
