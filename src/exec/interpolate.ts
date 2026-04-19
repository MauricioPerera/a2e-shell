/**
 * Strict interpolation resolver.
 *
 * Grammar (v1):
 *   token       := "${$" identifier "}"
 *   identifier  := [a-zA-Z_][a-zA-Z0-9_]*
 *
 * Anything else inside `${ ... }` (dots, brackets, operators, spaces, nested
 * braces, concatenation with other tokens inside the braces) MUST be rejected
 * with INTERPOLATION_REJECTED. The resolver does NOT run in a loop; one pass.
 */

import { A2EError } from "../errors.js";

export interface Binding {
  readonly value: string;
  readonly shape: string;
  readonly size_bytes: number;
}

export type Bindings = ReadonlyMap<string, Binding>;

export const INTERPOLATION_TOKEN_STRICT = /^\$\{\$[a-zA-Z_][a-zA-Z0-9_]*\}$/;
export const INTERPOLATION_GENERIC = /\$\{[^}]*\}/g;

const STRICT_NAME = /^\$\{\$([a-zA-Z_][a-zA-Z0-9_]*)\}$/;

/**
 * Resolve all ${$name} tokens against the bindings map.
 * - Any `${...}` that is not strictly `${$ident}` → INTERPOLATION_REJECTED.
 * - Valid token referencing an unknown binding → SCOPE_MISS.
 * Unicode-safe (string-level replace, not byte-level).
 */
export function interpolate(command: string, bindings: Bindings): string {
  const matches = command.match(INTERPOLATION_GENERIC);
  if (matches) {
    for (const m of matches) {
      if (!INTERPOLATION_TOKEN_STRICT.test(m)) {
        throw new A2EError(
          "INTERPOLATION_REJECTED",
          `interpolation accepts only bare '\${$var}'; got '${m}'`,
        );
      }
    }
  }
  return command.replace(INTERPOLATION_GENERIC, (tok) => {
    const m = STRICT_NAME.exec(tok);
    if (!m) {
      throw new A2EError(
        "INTERPOLATION_REJECTED",
        `interpolation accepts only bare '\${$var}'; got '${tok}'`,
      );
    }
    const name = m[1]!;
    const b = bindings.get(name);
    if (!b) {
      throw new A2EError("SCOPE_MISS", `binding '$${name}' not defined`);
    }
    return b.value;
  });
}
