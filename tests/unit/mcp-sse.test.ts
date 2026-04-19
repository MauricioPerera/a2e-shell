import { describe, it, expect } from "vitest";
import { parseSseStream } from "../../src/mcp/sse.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseSseStream", () => {
  it("parses single event", async () => {
    const stream = makeStream('data: {"jsonrpc":"2.0","id":1,"result":42}\n\n');
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ jsonrpc: "2.0", id: 1, result: 42 });
  });

  it("parses multiple events", async () => {
    const stream = makeStream(
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":10}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":"done"}\n\n',
    );
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(2);
    expect((out[0] as { method: string }).method).toBe("notifications/progress");
    expect((out[1] as { result: string }).result).toBe("done");
  });

  it("tolerates CRLF line endings", async () => {
    const stream = makeStream('data: {"x":1}\r\n\r\ndata: {"x":2}\r\n\r\n');
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(2);
    expect((out[0] as { x: number }).x).toBe(1);
    expect((out[1] as { x: number }).x).toBe(2);
  });

  it("ignores comment lines and non-data fields", async () => {
    const stream = makeStream(
      ": heartbeat\n" +
      "event: message\n" +
      'data: {"jsonrpc":"2.0","id":1,"result":"ok"}\n' +
      "id: 42\n\n",
    );
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(1);
    expect((out[0] as { result: string }).result).toBe("ok");
  });

  it("skips events with invalid JSON", async () => {
    const stream = makeStream(
      'data: not-json\n\n' +
      'data: {"id":1,"jsonrpc":"2.0","result":42}\n\n',
    );
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(1);
    expect((out[0] as { result: number }).result).toBe(42);
  });

  it("handles trailing partial event without final blank line", async () => {
    const stream = makeStream('data: {"id":1,"jsonrpc":"2.0","result":99}');
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(1);
    expect((out[0] as { result: number }).result).toBe(99);
  });

  it("strips single leading space from data value", async () => {
    const stream = makeStream('data: {"a":1}\n\n');
    const out = await collect(parseSseStream(stream));
    expect(out).toHaveLength(1);
    expect((out[0] as { a: number }).a).toBe(1);
  });
});
