/**
 * Append-only JSONL transcript.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import * as crypto from "node:crypto";

export interface TranscriptEntry {
  readonly t: number;
  readonly at: string;
  readonly req: unknown;
  readonly res: unknown;
}

export interface Transcript {
  readonly path: string;
  append(entry: TranscriptEntry): Promise<void>;
  /** Write a pre-serialized, pre-redacted JSONL line. Caller owns correctness. */
  appendRaw(line: string): Promise<void>;
  read(): AsyncIterable<TranscriptEntry>;
  count(): Promise<number>;
  hashFinal(): Promise<string>;
}

export function openTranscript(filePath: string): Transcript {
  // Ensure file exists before we start appending.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "");
  }

  return {
    path: filePath,
    async append(entry: TranscriptEntry) {
      const line = JSON.stringify(entry) + "\n";
      await fsp.appendFile(filePath, line, "utf8");
    },
    async appendRaw(line: string) {
      await fsp.appendFile(filePath, line + "\n", "utf8");
    },
    read(): AsyncIterable<TranscriptEntry> {
      return {
        [Symbol.asyncIterator]: async function* () {
          const stream = fs.createReadStream(filePath, { encoding: "utf8" });
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          for await (const raw of rl) {
            if (!raw.trim()) continue;
            yield JSON.parse(raw) as TranscriptEntry;
          }
        },
      };
    },
    async count() {
      let n = 0;
      for await (const _ of this.read()) n++;
      return n;
    },
    async hashFinal() {
      const h = crypto.createHash("sha256");
      for await (const e of this.read()) {
        h.update(JSON.stringify(e.res));
      }
      return h.digest("hex");
    },
  };
}

