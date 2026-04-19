/**
 * Credential redactor. Runs on ALL subprocess stdout/stderr BEFORE the formatter.
 *
 * Given a list of env var NAMES, reads their values from the runtime env at
 * session creation, filters out values shorter than MIN_SECRET_LEN (to avoid
 * redacting trivial literals like "true" or "1"), and builds a replacement
 * table. Longer secrets are replaced first so they're not accidentally split
 * by shorter-prefix matches.
 */

export interface Redactor {
  readonly keys: readonly string[];
  readonly secrets: readonly string[];
  redact(buf: Uint8Array): Uint8Array;
}

export const MIN_SECRET_LEN = 8;
export const REPLACEMENT = "[REDACTED]";

export function buildRedactor(
  keysFromEnv: readonly string[],
  processEnv: Readonly<Record<string, string | undefined>>,
): Redactor {
  const secrets: string[] = [];
  const seen = new Set<string>();
  for (const k of keysFromEnv) {
    const v = processEnv[k];
    if (!v) continue;
    if (v.length < MIN_SECRET_LEN) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    secrets.push(v);
  }
  secrets.sort((a, b) => b.length - a.length);

  const redact = secrets.length === 0
    ? (buf: Uint8Array) => buf
    : buildScrubber(secrets);

  return {
    keys: Object.freeze([...keysFromEnv]),
    secrets: Object.freeze([...secrets]),
    redact,
  };
}

function buildScrubber(secrets: readonly string[]): (buf: Uint8Array) => Uint8Array {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  return (buf: Uint8Array) => {
    if (buf.length === 0) return buf;
    let text = decoder.decode(buf);
    for (const s of secrets) {
      if (text.includes(s)) {
        text = splitReplace(text, s, REPLACEMENT);
      }
    }
    return encoder.encode(text);
  };
}

/** Non-regex split-based replacement to avoid regex-escape hazards. */
function splitReplace(hay: string, needle: string, rep: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < hay.length) {
    const j = hay.indexOf(needle, i);
    if (j < 0) {
      parts.push(hay.slice(i));
      break;
    }
    parts.push(hay.slice(i, j));
    parts.push(rep);
    i = j + needle.length;
  }
  return parts.join("");
}
