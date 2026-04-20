/**
 * `save <value> as <name> [--ttl <d>] [--overwrite]` — binds a value into
 * session scope under a non-$-prefixed name with optional TTL. The bound
 * value IS the input value (no copy, no transformation). A save with
 * overwrite=false on an existing name rejects.
 */

import type { SaveCmd } from "../parser/ast.js";
import { A2EError } from "../errors.js";
import {
  bind,
  lookup,
  makeBinding,
  type RuntimeValue,
  type Session,
} from "../runtime/session.js";

export function runSave(
  session: Session,
  cmd: SaveCmd,
  value: RuntimeValue,
  resolvedName: string,
): { name: string; value: RuntimeValue } {
  if (resolvedName === "_") {
    throw new A2EError("SCOPE_MISS", "'_' is reserved; save target cannot be '_'");
  }
  if (!cmd.overwrite && lookup(session, resolvedName) !== null) {
    throw new A2EError(
      "CONFLICT",
      `binding '${resolvedName}' already exists; pass --overwrite to replace`,
    );
  }
  bind(session, resolvedName, makeBinding(value, cmd.ttl?.ms ?? null));
  return { name: resolvedName, value };
}
