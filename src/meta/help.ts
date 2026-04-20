/**
 * `help [topic]` — static help text. With no topic, a one-line index;
 * with a topic, the signature + error codes for that verb/meta.
 *
 * Stored inline to keep the module zero-I/O. If the help text grows, move
 * to a JSON resource and load at build time.
 */

const INDEX = [
  "Bounded-verb shell. 8 verbs + 6 meta. One cmd per line.",
  "Verbs:  call filter transform if foreach save wait merge",
  "Meta:   describe head env history show help",
  "See 'help <verb>' for signature + errors.",
].join("\n");

const TOPICS: Record<string, string> = {
  call: [
    "call <method> <url> [--header s] [--body v] [--query s] [--timeout d]",
    "call <binary> [args...]",
    "  HTTP: method ∈ {GET,POST,PUT,PATCH,DELETE,HEAD}",
    "  CLI: binary must be in allowlist; returns stdout canonicalized",
    "  errors: CAPABILITY_DENIED, UPSTREAM_ERROR, TIMEOUT, PARSE_ERROR",
  ].join("\n"),
  filter: [
    "filter <list> where <predicate>",
    "  predicate: cmp | in | matches | exists [and|or|not]",
    "  errors: PARSE_ERROR (non-list target), SCOPE_MISS",
  ].join("\n"),
  transform: [
    "transform <value> <op>",
    "  ops: pick f,g | omit f,g | rename a=b,c=d | set f=v,g=w | map {k:v}",
    "  errors: PARSE_ERROR, SCOPE_MISS",
  ].join("\n"),
  save: [
    "save <value> as <name> [--ttl <d>] [--overwrite]",
    "  binds value into session scope; name must not be '_'",
    "  errors: CONFLICT (exists without --overwrite), SCOPE_MISS",
  ].join("\n"),
  wait: [
    "wait <duration>",
    "  duration: <n>ms|s|m|h|d",
    "  errors: CAPABILITY_DENIED (exceeds MAX_WAIT_MS)",
  ].join("\n"),
  merge: [
    "merge <a> <b> by <path> [--strategy inner|left|right|outer]",
    "  joins two lists of records by key-path; right fields win on overlap",
    "  errors: PARSE_ERROR (non-list, non-records), SCOPE_MISS",
  ].join("\n"),
  if: "if <predicate> do ... [else ...] end",
  foreach: "foreach $x in <list> [--parallel=N] [--on-error=abort|continue] do ... end",
  describe: "describe <value> — returns {kind, rows?, cols?, bytes, item_keys?}",
  head: "head <value> [N] — first N items (default 5)",
  show: "show <value> — full dump (only command without truncation)",
  env: "env — list bound variable names",
  history: "history [N] — last N transcript entries (default 10)",
  help: "help [topic]",
};

export function runHelp(topic: string | null): string {
  if (!topic) return INDEX;
  return TOPICS[topic] ?? `no help for '${topic}'. Try 'help' for index.`;
}
