Tool: `exec(command, bind_as?, stdin?, timeout_ms?)`. Bash in a persistent session. `cd`/`export`/`unset` persist; aliases/functions don't. Set header `accept: text/event-stream` to stream output progressively (events: start/stdout/stderr/done). Sessions created with `mode:"bounded"` execute a closed-grammar DSL (8 verbs + 6 meta) instead of bash — see `docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md` and `src/parser/grammar.pegjs`.

## Response
`status_line` `[exit N]`|`[error: CODE]` · `shape` `json<T>[N]`|`jsonl[N]`|`text[Nb]`|`binary[Nb]`|null · `preview` first 2KB of stdout · `stderr` tail or null · `truncated` true if stdout was cut · `binding` `$name` if `bind_as`.

## Bindings
`bind_as:"x"` stores full stdout as `$x`. Interpolate only as bare `${$x}` — no `.field`, `[i]`, ops, concat. Project by binding then `jq`.

## CLIs
`curl jq gh aws kubectl git grep sed awk rg head tail wc cut sort uniq xargs`

## Patterns
```
exec("curl -sS https://api/x", bind_as:"r")
exec("echo ${$r} | jq 'keys'")
exec("echo ${$r} | jq '[.items[]|select(.active)]|map(.id)'", bind_as:"ids")
exec("echo ${$ids} | jq -r '.[]' | xargs -I{} gh api /users/{}")
```

## Rules
- Check `status_line` first; on non-zero, read `stderr`.
- `truncated:true` → narrow with `head`/`jq`.
- Unknown shape → `jq 'keys'`/`length` or `head -c N`.
- Never cat large data.
- `INTERPOLATION_REJECTED` → bare `${$var}`, project in command.
- `CAPABILITY_DENIED` → stop.
- `SCOPE_MISS` → rebind.
- `SIZE_LIMIT` → narrow upstream.
- `TIMEOUT` → split work.

## Catalog (if `$A2E_CATALOG_INDEX` set)
List: `cat $A2E_CATALOG_INDEX/manifest.json | jq .categories`.
Browse: `cat $A2E_CATALOG_INDEX/<cat>.json | jq .entries`.
Content: `$A2E_CATALOG_CONTENT/<entry.path>`.
Reachable? `jq .by_category.skills.<name>.reachable < $A2E_CATALOG_REACHABILITY`.
