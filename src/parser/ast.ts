/**
 * AST types for the bounded-verb shell grammar.
 *
 * Kept data-only: no behavior, no methods. Every node has a `kind`
 * discriminator so downstream code (dispatcher, validator) can switch
 * exhaustively.
 *
 * Invariants (enforced by the parser, not the types):
 *   - An `InterpString` may only contain `Interp` segments whose `path`
 *     matches GRAMMAR.ebnf R2 (variable + optional .ident / [index] chain).
 *   - A `Block` body's depth is capped at MAX_BLOCK_DEPTH (R7).
 *   - `$_` cannot appear as an `Assignment.target` (R5).
 */

// --- literals & values ------------------------------------------------------

export type StringLit   = { kind: "string";   value: string };
export type NumberLit   = { kind: "number";   value: number };
export type BoolLit     = { kind: "bool";     value: boolean };
export type NullLit     = { kind: "null" };
export type DurationLit = { kind: "duration"; ms: number };
export type ListLit     = { kind: "list";     items: Value[] };
export type ObjectLit   = { kind: "object";   pairs: Array<{ key: string; value: Value }> };

export type VarRef      = { kind: "var";      name: string };
export type PathRef     = { kind: "path";     root: string; steps: PathStep[] };
export type PathStep    = { kind: "field"; name: string } | { kind: "index"; index: number };

export type Interp      = { kind: "interp"; path: PathRef };
export type InterpSeg   = { kind: "literal"; text: string } | Interp;
export type InterpStr   = { kind: "interpString"; segments: InterpSeg[] };

export type Literal     = StringLit | NumberLit | BoolLit | NullLit | DurationLit | ListLit | ObjectLit;
export type Value       = Literal | VarRef | PathRef | InterpStr;

// --- predicates (filter where, if <cond>) -----------------------------------

export type Comparator  = "==" | "!=" | ">" | ">=" | "<" | "<=";

export type PredAtom =
  | { kind: "cmp";        left: Operand; op: Comparator; right: Operand }
  | { kind: "in";         left: Operand; list: ListLit }
  | { kind: "matches";    left: Operand; regex: string }
  | { kind: "exists";     left: Operand };

export type Predicate =
  | PredAtom
  | { kind: "not"; inner: Predicate }
  | { kind: "and"; left: Predicate; right: Predicate }
  | { kind: "or";  left: Predicate; right: Predicate };

export type Operand = PathRef | Value;

// --- verbs ------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type HttpOption =
  | { kind: "header";  value: Value }     // "Name: value"
  | { kind: "body";    value: Value }
  | { kind: "query";   value: Value }     // "k=v&k2=v2"
  | { kind: "timeout"; duration: DurationLit };

export type HttpCall = {
  kind: "call-http";
  method: HttpMethod;
  url: Value;                             // string | interpString
  options: HttpOption[];
};

export type CliArg =
  | { kind: "arg";     value: Value }
  | { kind: "lflag";   name: string; value: Value | null }     // --name[=v|SP v]
  | { kind: "sflag";   letter: string; value: Value | null };  // -n [v]

export type CliCall = {
  kind: "call-cli";
  binary: string;                         // validated against allowlist at exec time
  args: CliArg[];
};

export type TransformOp =
  | { kind: "pick";   fields: string[] }
  | { kind: "omit";   fields: string[] }
  | { kind: "rename"; pairs: Array<{ from: string; to: string }> }
  | { kind: "set";    pairs: Array<{ field: string; value: Value }> }
  | { kind: "map";    template: ObjectLit };

export type MergeStrategy = "inner" | "left" | "right" | "outer";

export type FilterCmd    = { kind: "filter";    target: Value; predicate: Predicate };
export type TransformCmd = { kind: "transform"; target: Value; op: TransformOp };
// `as: Value` (not string) so interpolated names work: `save $x as "stats_${$repo.name}"`.
// The dispatcher evaluates cmd.as to a string at exec time.
export type SaveCmd      = { kind: "save";      target: Value; as: Value;    ttl: DurationLit | null; overwrite: boolean };
export type WaitCmd      = { kind: "wait";      duration: DurationLit };
export type MergeCmd     = {
  kind: "merge";
  left: Value;
  right: Value;
  byPath: PathRef;                        // `by .field.subfield`
  strategy: MergeStrategy;
};

export type VerbCall =
  | HttpCall | CliCall
  | FilterCmd | TransformCmd | SaveCmd | WaitCmd | MergeCmd;

// --- blocks -----------------------------------------------------------------

export type IfBlock = {
  kind: "if";
  predicate: Predicate;
  thenBody: Stmt[];
  elseBody: Stmt[] | null;
};

export type ForeachBlock = {
  kind: "foreach";
  itemVar: string;                        // bare name (no $); parser strips the $
  list: Value;
  parallel: number | null;                // --parallel=N
  onError: "abort" | "continue";          // default "abort"
  body: Stmt[];
};

export type Block = IfBlock | ForeachBlock;

// --- meta -------------------------------------------------------------------

export type MetaCall =
  | { kind: "describe"; target: Value }
  | { kind: "head";     target: Value; n: number }       // default 5
  | { kind: "show";     target: Value }
  | { kind: "env" }
  | { kind: "history";  n: number }                      // default 10
  | { kind: "help";     topic: string | null };

// --- statements -------------------------------------------------------------

export type Command    = VerbCall | Block | MetaCall;
export type Assignment = { kind: "assignment"; target: string; rhs: Exclude<Command, Block> };
export type Stmt       = Assignment | Command;

export type Program    = { kind: "program"; stmts: Stmt[] };

// --- exhaustive-check helper ------------------------------------------------

/**
 * Standard TS exhaustiveness helper. Use in `default:` of a switch over
 * discriminated union to force a compile error if a new variant is added
 * and not handled.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled AST variant: ${JSON.stringify(x)}`);
}
