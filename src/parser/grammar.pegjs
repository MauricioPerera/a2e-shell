// ============================================================
// a2e-shell bounded grammar — peggy source.
//
// Source of truth: docs/GRAMMAR.ebnf  (human-auditable EBNF)
// This file is compiled at runtime by src/parser/parse.ts.
//
// Conventions:
//   - Rule names are PascalCase.
//   - Semantic actions return AST nodes from src/parser/ast.ts.
//   - Errors tagged with a prefix are re-coded by parse.ts:
//       "INTERP_REJECTED:<detail>"    → A2EError INTERPOLATION_REJECTED
//       "SCOPE_RESERVED:<detail>"     → A2EError SCOPE_MISS  (R5: $_ assign)
//       "BLOCK_DEPTH:<detail>"        → A2EError PARSE_ERROR (R7)
//       anything else                 → A2EError PARSE_ERROR
//
// Limits enforced here:
//   R1  one stmt per line (except blocks)
//   R2  ${} body must match path regex
//   R5  $_ cannot be assignment target
//   R6  block cannot be rhs of assignment
//   R7  MAX_BLOCK_DEPTH=4
// ============================================================

{{
function leftAssoc(kind, head, tail) {
  return tail.reduce((acc, item) => ({ kind, left: acc, right: item }), head);
}
}}

// --- program ---------------------------------------------------------------

Program
  = __ stmts:(Stmt __)* __ { return { kind: "program", stmts: stmts.map(s => s[0]) }; }

Stmt
  = Assignment / Command

Assignment
  // `$_` rejection is enforced post-parse in parse.ts so that "$_" still
  // tokenises as a valid variable name elsewhere (e.g. `show $_`).
  = "$" name:(Ident / "_") _ "=" _ rhs:NonBlockCommand {
      return { kind: "assignment", target: name, rhs };
    }

NonBlockCommand "verb or meta"
  = VerbCall / MetaCall

Command "verb, meta, or block"
  = VerbCall / MetaCall / Block

// --- verbs -----------------------------------------------------------------

VerbCall
  = CallCmd
  / FilterCmd
  / TransformCmd
  / SaveCmd
  / WaitCmd
  / MergeCmd

// call GET "url" [--header ...]*  |  call <binary> [args...]
CallCmd
  = "call" SP c:(HttpCall / CliCall) { return c; }

HttpCall
  = method:HttpMethod SP url:Value opts:(SP @HttpOption)* {
      return { kind: "call-http", method, url, options: opts };
    }

HttpMethod
  = "GET" / "POST" / "PUT" / "PATCH" / "DELETE" / "HEAD"

HttpOption
  = "--header" SP v:Value { return { kind: "header", value: v }; }
  / "--body" SP v:Value { return { kind: "body", value: v }; }
  / "--query" SP v:Value { return { kind: "query", value: v }; }
  / "--timeout" SP d:Duration { return { kind: "timeout", duration: d }; }

CliCall
  = binary:Ident args:(SP @CliArg)* { return { kind: "call-cli", binary, args }; }

CliArg
  = LongFlag / ShortFlag / v:Value { return { kind: "arg", value: v }; }

LongFlag
  = "--" name:Ident v:("=" @Value / SP @Value)? { return { kind: "lflag", name, value: v ?? null }; }

ShortFlag
  = "-" letter:Letter v:(SP @Value)? { return { kind: "sflag", letter, value: v ?? null }; }

// filter <value> where <predicate>
FilterCmd
  = "filter" SP target:Value SP "where" SP pred:Predicate {
      return { kind: "filter", target, predicate: pred };
    }

// transform <value> <op>
TransformCmd
  = "transform" SP target:Value SP op:TransformOp {
      return { kind: "transform", target, op };
    }

TransformOp
  = "pick"   SP f:FieldList      { return { kind: "pick",   fields: f }; }
  / "omit"   SP f:FieldList      { return { kind: "omit",   fields: f }; }
  / "rename" SP pairs:RenameList { return { kind: "rename", pairs }; }
  / "set"    SP pairs:SetList    { return { kind: "set",    pairs }; }
  / "map"    SP tpl:Object       { return { kind: "map",    template: tpl }; }

FieldList  = head:Ident tail:("," _ @Ident)* { return [head, ...tail]; }
RenameList = head:RenamePair tail:("," _ @RenamePair)* { return [head, ...tail]; }
RenamePair = from:Ident "=" to:Ident { return { from, to }; }
SetList    = head:SetPair tail:("," _ @SetPair)* { return [head, ...tail]; }
SetPair    = field:Ident "=" v:Value { return { field, value: v }; }

// save <value> as <name> [--ttl <d>] [--overwrite]
SaveCmd
  = "save" SP target:Value SP "as" SP as:SaveName
    flags:(SP @SaveFlag)* {
      let ttl = null, overwrite = false;
      for (const f of flags) {
        if (f.kind === "ttl") ttl = f.duration;
        if (f.kind === "overwrite") overwrite = true;
      }
      return { kind: "save", target, as, ttl, overwrite };
    }

// save name: quoted string OR bare identifier (may include interpolation in quoted form).
SaveName
  = s:String { return s.value; }
  / IdentChars

SaveFlag
  = "--ttl" SP d:Duration { return { kind: "ttl", duration: d }; }
  / "--overwrite"         { return { kind: "overwrite" }; }

// wait <duration>
WaitCmd
  = "wait" SP d:Duration { return { kind: "wait", duration: d }; }

// merge <a> <b> by <path> [--strategy inner|left|right|outer]
MergeCmd
  = "merge" SP left:Value SP right:Value SP "by" SP byPath:FieldPath
    strat:(SP "--strategy" SP @MergeStrategy)? {
      return { kind: "merge", left, right, byPath, strategy: strat ?? "inner" };
    }

MergeStrategy = "inner" / "left" / "right" / "outer"

// --- meta ------------------------------------------------------------------

MetaCall
  = DescribeCmd / HeadCmd / ShowCmd / EnvCmd / HistoryCmd / HelpCmd

DescribeCmd = "describe" SP v:Value { return { kind: "describe", target: v }; }
HeadCmd     = "head" SP v:Value n:(SP @Integer)? { return { kind: "head", target: v, n: n ?? 5 }; }
ShowCmd     = "show" SP v:Value { return { kind: "show", target: v }; }
EnvCmd      = "env" { return { kind: "env" }; }
HistoryCmd  = "history" n:(SP @Integer)? { return { kind: "history", n: n ?? 10 }; }
HelpCmd     = "help" t:(SP @Ident)? { return { kind: "help", topic: t ?? null }; }

// --- blocks ----------------------------------------------------------------

Block = IfBlock / ForeachBlock

IfBlock
  = "if" SP p:Predicate SP "do" NL
    thenBody:BlockBody
    elseBody:("else" NL @BlockBody)?
    "end" {
      return { kind: "if", predicate: p, thenBody, elseBody: elseBody ?? null };
    }

ForeachBlock
  = "foreach" SP "$" item:Ident SP "in" SP list:Value
    flags:(SP @ForeachFlag)*
    SP "do" NL
    body:BlockBody
    "end" {
      let parallel = null, onError = "abort";
      for (const f of flags) {
        if (f.kind === "parallel") parallel = f.n;
        if (f.kind === "onError") onError = f.mode;
      }
      return { kind: "foreach", itemVar: item, list, parallel, onError, body };
    }

ForeachFlag
  = "--parallel=" n:Integer { return { kind: "parallel", n }; }
  / "--on-error=" m:("abort" / "continue") { return { kind: "onError", mode: m }; }

// Zero or more stmts inside a `do ... end` body. `__` eats leading/trailing
// whitespace + newlines between stmts; Stmt itself does not need to carry a
// trailing NL. Leaves position at the first char that isn't WS/NL/Stmt — the
// caller expects "end" there.
BlockBody
  = __ stmts:(@Stmt __)* { return stmts; }

// --- predicates ------------------------------------------------------------

Predicate = PredOr

PredOr
  = head:PredAnd tail:(_ "or" _ @PredAnd)* { return leftAssoc("or", head, tail); }

PredAnd
  = head:PredNot tail:(_ "and" _ @PredNot)* { return leftAssoc("and", head, tail); }

PredNot
  = "not" _ inner:PredAtom { return { kind: "not", inner }; }
  / PredAtom

PredAtom
  = "(" _ p:Predicate _ ")" { return p; }
  / Comparison
  / Membership
  / MatchPred
  / Existence

Comparison
  = l:Operand _ op:Comparator _ r:Operand { return { kind: "cmp", left: l, op, right: r }; }

Comparator = "==" / "!=" / ">=" / "<=" / ">" / "<"

Membership
  = l:Operand SP "in" SP list:List { return { kind: "in", left: l, list }; }

MatchPred
  = l:Operand SP "matches" SP s:String { return { kind: "matches", left: l, regex: s.value }; }

Existence
  = l:Operand SP "exists" { return { kind: "exists", left: l }; }

Operand
  = FieldPath / PathRef / Value

// --- values & literals -----------------------------------------------------

Value
  = Duration             // must come before Number (e.g. 30s)
  / InterpString
  / String
  / List
  / Object
  / Boolean
  / Null
  / Number
  / PathRef
  / Var

Literal
  = Duration / String / Number / Boolean / Null / List / Object

// Bare variable reference (no field chain)
Var
  = "$" name:Ident { return { kind: "var", name }; }

// Path: $var (. ident | [int])+
PathRef
  = "$" root:Ident steps:(PathStep)+ { return { kind: "path", root, steps }; }

PathStep
  = "." name:Ident  { return { kind: "field", name }; }
  / "[" i:Integer "]" { return { kind: "index", index: i }; }

// Implicit field path (used in "where", "by", "if" when no $ root): .a.b[0]
FieldPath
  = steps:(PathStep)+ { return { kind: "path", root: "", steps }; }

String "string"
  = '"' chars:StringChar* '"' { return { kind: "string", value: chars.join("") }; }

StringChar
  = "\\\"" { return "\""; }
  / "\\\\" { return "\\"; }
  / "\\n"  { return "\n"; }
  / "\\t"  { return "\t"; }
  / "\\r"  { return "\r"; }
  / !["\\] c:. { return c; }

InterpString "interpolated-string"
  = '"' parts:InterpPart+ '"'
    &{ return parts.some(p => p.kind === "interp"); }  // must contain at least one ${...}
    { return { kind: "interpString", segments: parts }; }

InterpPart
  = "${" body:$(InterpBody) "}" {
      // InterpBody guarantees the shape: $<ident>(.<ident>|[<int>])*
      // We parse it into { root, steps } for the AST.
      const m = body.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_-]*|\[[0-9]+\])*)$/);
      if (!m) error("INTERP_REJECTED:" + body);
      const steps = [];
      const stepsRe = /\.([a-zA-Z_][a-zA-Z0-9_-]*)|\[([0-9]+)\]/g;
      let mm;
      while ((mm = stepsRe.exec(m[2])) !== null) {
        if (mm[1] !== undefined) steps.push({ kind: "field", name: mm[1] });
        else steps.push({ kind: "index", index: parseInt(mm[2], 10) });
      }
      return { kind: "interp", path: { kind: "path", root: m[1], steps } };
    }
  / "${" body:$([^}]+) "}" { error("INTERP_REJECTED:" + body); }
  / c:InterpStringChar { return { kind: "literal", text: c }; }

// Must match only strict path shape (R2). Any deviation (spaces, operators,
// quotes) fails this rule and the next alternative in InterpPart catches it.
InterpBody
  = "$" [a-zA-Z_] [a-zA-Z0-9_]* ( "." [a-zA-Z_] [a-zA-Z0-9_\-]* / "[" [0-9]+ "]" )*

InterpStringChar
  = "\\\"" { return "\""; }
  / "\\\\" { return "\\"; }
  / "\\n"  { return "\n"; }
  / "\\t"  { return "\t"; }
  / "\\r"  { return "\r"; }
  / !["\\$] c:. { return c; }
  / "$" !"{" { return "$"; }

Number "number"
  = neg:"-"? int:$([0-9]+) frac:("." $([0-9]+))? {
      const s = (neg ?? "") + int + (frac ? "." + frac[1] : "");
      return { kind: "number", value: parseFloat(s) };
    }

Boolean "boolean"
  = "true"  { return { kind: "bool", value: true }; }
  / "false" { return { kind: "bool", value: false }; }

Null "null"
  = "null" { return { kind: "null" }; }

List "list"
  = "[" _ "]" { return { kind: "list", items: [] }; }
  / "[" _ head:Value tail:(_ "," _ @Value)* _ "]" { return { kind: "list", items: [head, ...tail] }; }

Object "object"
  = "{" _ "}" { return { kind: "object", pairs: [] }; }
  / "{" _ head:ObjectPair tail:(_ "," _ @ObjectPair)* _ "}" { return { kind: "object", pairs: [head, ...tail] }; }

ObjectPair
  = key:ObjectKey _ ":" _ value:Value { return { key, value }; }

ObjectKey
  = '"' chars:StringChar* '"' { return chars.join(""); }
  / IdentChars

Duration "duration"
  = n:$([0-9]+) unit:("ms" / "s" / "m" / "h" / "d") {
      const v = parseInt(n, 10);
      const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
      return { kind: "duration", ms: v * mult };
    }

Integer
  = n:$([0-9]+) { return parseInt(n, 10); }

// --- terminals -------------------------------------------------------------

Ident "identifier"
  = head:Letter rest:IdentTail* { return head + rest.join(""); }

IdentChars
  = head:Letter rest:IdentTail* { return head + rest.join(""); }

IdentTail = Letter / Digit / "_" / "-"
Letter    = [a-zA-Z]
Digit     = [0-9]

// Whitespace
SP        = [ \t]+
_         = [ \t]*
NL        = "\r\n" / "\n"
__        = (SP / NL)*
