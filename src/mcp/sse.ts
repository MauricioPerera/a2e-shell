/**
 * Minimal Server-Sent Events parser for MCP responses that use
 * `Content-Type: text/event-stream`.
 *
 * Per MCP Streamable HTTP (spec 2025-06-18), a server MAY respond to a
 * POSTed JSON-RPC request with an event stream instead of a single JSON
 * object. Each event body is a JSON-RPC message — either the response
 * matching our request id, or a notification emitted while the tool
 * call is in flight (progress, logging, etc.).
 *
 * This parser:
 *   - iterates the response's ReadableStream (async)
 *   - splits on `\n` to assemble events (terminated by a blank line)
 *   - extracts the `data:` payload of each event
 *   - yields JSON-parsed messages in order
 *
 * Intentionally NOT implemented:
 *   - Multi-line data (data: a\ndata: b)   — MCP uses single-line JSON
 *   - Event types (event: foo)              — not used by MCP streams
 *   - Reconnection ids                      — handled at higher level
 *   - Retry semantics                        — handled at higher level
 *
 * The parser is a stateful generator: pass each chunk of bytes and it
 * yields messages. Use with the body's async iterator for a clean pump.
 */

export interface SseMessage {
  /** The raw string from the `data:` field. */
  readonly data: string;
}

/**
 * Consumes a ReadableStream<Uint8Array> of SSE bytes and yields parsed
 * messages as JSON objects. Throws if any event's data is not valid JSON.
 *
 * Exits normally when the stream ends.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line (\n\n or \r\n\r\n).
      // Process complete events from the buffer.
      let sep: number;
      while ((sep = findEventBoundary(buffer)) >= 0) {
        const eventText = buffer.slice(0, sep);
        const boundaryLen = buffer.startsWith("\r\n\r\n", sep) ? 4 : 2;
        buffer = buffer.slice(sep + boundaryLen);
        const message = extractDataField(eventText);
        if (message === null) continue; // comment-only / malformed event
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          continue; // ignore non-JSON events (e.g. keepalives)
        }
        yield parsed;
      }
    }
    // Flush any final partial event (servers that don't terminate with \n\n).
    const tail = buffer.trim();
    if (tail.length > 0) {
      const message = extractDataField(tail);
      if (message !== null) {
        try {
          yield JSON.parse(message);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(s: string): number {
  // Accept both CRLF-CRLF and LF-LF per the SSE spec tolerance. Return the
  // start index of the boundary (the first `\n` of the pair).
  const lfLf = s.indexOf("\n\n");
  const crLfCrLf = s.indexOf("\r\n\r\n");
  if (lfLf < 0 && crLfCrLf < 0) return -1;
  if (lfLf < 0) return crLfCrLf;
  if (crLfCrLf < 0) return lfLf;
  return Math.min(lfLf, crLfCrLf);
}

/**
 * From an event body (lines terminated by \n or \r\n), extract the
 * concatenation of `data:` field values. Returns null if no data field
 * was present.
 */
function extractDataField(eventText: string): string | null {
  const lines = eventText.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("data:")) {
      const v = line.slice(5);
      // Spec: strip a single leading space if present.
      dataParts.push(v.startsWith(" ") ? v.slice(1) : v);
    }
    // Other fields (event, id, retry) are intentionally ignored.
  }
  if (dataParts.length === 0) return null;
  return dataParts.join("\n");
}
