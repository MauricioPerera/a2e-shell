/**
 * State-mutating shell builtins are intercepted before spawn.
 *
 * A command counts as "pure intercept" iff the ENTIRE command (trimmed) matches
 * one of these forms — no pipes, no `&&`, no `;`, no `&`, no newline:
 *
 *   cd <path>
 *   export <KEY>=<value>
 *   unset <KEY> [<KEY> ...]
 *
 * Compound commands like `cd /tmp && ls` are NOT intercepted — they reach spawn
 * and their cwd change dies with the subprocess. This is intentional: the LLM
 * learns to issue `cd` as a separate turn when it wants persistence.
 *
 * Quoted / complex values for `export` are not intercepted in v1; use a simple
 * `KEY=VALUE` form. The LLM can always fall back to per-exec env via a future
 * extension.
 */

const COMPOUND = /[|;&\n]|&&|\|\||`|\$\(/;

const CD_RE = /^cd\s+(\S+)$/;
const EXPORT_RE = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(\S*)$/;
const UNSET_RE = /^unset((?:\s+[A-Za-z_][A-Za-z0-9_]*)+)$/;

export type Mutation =
  | { type: "cd"; path: string }
  | { type: "export"; key: string; value: string }
  | { type: "unset"; keys: readonly string[] };

export type InterceptResult =
  | { kind: "intercept"; mutation: Mutation }
  | { kind: "spawn" };

export function classify(command: string): InterceptResult {
  const c = command.trim();
  if (COMPOUND.test(c)) return { kind: "spawn" };

  const cd = CD_RE.exec(c);
  if (cd) return { kind: "intercept", mutation: { type: "cd", path: cd[1]! } };

  const ex = EXPORT_RE.exec(c);
  if (ex) {
    return {
      kind: "intercept",
      mutation: { type: "export", key: ex[1]!, value: ex[2]! },
    };
  }

  const un = UNSET_RE.exec(c);
  if (un) {
    const keys = un[1]!.trim().split(/\s+/);
    return { kind: "intercept", mutation: { type: "unset", keys } };
  }

  return { kind: "spawn" };
}
