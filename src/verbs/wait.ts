/**
 * `wait <duration>` — blocks for the given duration.
 *
 * Exec-time cap: MAX_WAIT_MS (1 hour). Longer requests return CAPABILITY_DENIED
 * before sleeping.
 */

import type { WaitCmd } from "../parser/ast.js";
import { A2EError } from "../errors.js";

const MAX_WAIT_MS = 60 * 60 * 1000;

export async function runWait(cmd: WaitCmd): Promise<null> {
  if (cmd.duration.ms > MAX_WAIT_MS) {
    throw new A2EError(
      "CAPABILITY_DENIED",
      `wait duration ${cmd.duration.ms}ms exceeds MAX_WAIT_MS=${MAX_WAIT_MS}`,
    );
  }
  await new Promise<void>((resolve) => setTimeout(resolve, cmd.duration.ms));
  return null;
}
