# RFC 003 — `npm:` command sugar for MCP stdio servers

**Status**: accepted, target v1.4
**Depends on**: RFC 002 (stdio transport)
**Ships in**: v1.4.0

## Motivation

Most production MCP servers distribute as npm packages (`@modelcontextprotocol/server-filesystem`, `@modelcontextprotocol/server-github`, ...). Today operators must either:

- install the package globally and add its bin to the binary allowlist, or
- write `command: "npx"`, `args: ["-y", "@modelcontextprotocol/server-filesystem@1.2.3"]` manually.

Both work. The second is verbose, easy to get wrong (forget `-y`, forget version pin), and leaks transport mechanism into the session spec. This RFC adds a `command: "npm:<pkg>@<ver>"` shorthand that the runtime expands at connect time.

## Non-goals

- No `pypi:`, `go:`, `cargo:` siblings yet. Revisit when demand appears.
- No offline bundling. First connect pulls from the registry.
- No integrity hashes (`#sha512-...`). Future extension; out of scope for v1.4.
- No auto-install of `npx`. Operator must add it to the binary allowlist.

## Surface

### Spec

```jsonc
{
  "id": "fs",
  "transport": "stdio",
  "command": "npm:@modelcontextprotocol/server-filesystem@1.2.3",
  "args": ["/home/user/allowed/path"],
  "env": {},
  "timeout_ms": 30000,
  "rate_limit_rpm": 600
}
```

### Expansion

The runtime rewrites the spawn tuple before `connectStdioMcpServer`:

```
command -> <policy.binary_paths["npx"]>
args    -> ["-y", "@modelcontextprotocol/server-filesystem@1.2.3", ...spec.args]
```

Everything else (env overlay, cwd, timeout, rate limit, lifecycle) is unchanged.

## Grammar

```
npm-command := "npm:" package "@" version
package     := scoped-package | unscoped-package
scoped-package   := "@" ident "/" ident
unscoped-package := ident
ident       := [A-Za-z0-9][A-Za-z0-9._-]{0,213}
version     := digit+ "." digit+ "." digit+ ("-" prerelease)? ("+" build)?
prerelease  := [0-9A-Za-z.-]+
build       := [0-9A-Za-z.-]+
```

Examples that parse:

- `npm:@modelcontextprotocol/server-filesystem@1.2.3`
- `npm:mcp-server-git@0.6.2`
- `npm:@scope/name@1.0.0-rc.1`
- `npm:@scope/name@2.0.0+build.42`

Examples that **reject** (with `PARSE_ERROR`):

- `npm:@scope/name` — no version pin
- `npm:@scope/name@latest` — tag, not semver
- `npm:@scope/name@^1.0.0` — range, not exact
- `npm:@scope/name@~1.0.0` — range
- `npm:@scope/name@1.0` — not semver (missing patch)
- `npm:` — empty

Rationale: every accepted input pins exactly one immutable artifact on the npm registry. Tags and ranges reintroduce the drift the rest of the v1.x line is trying to eliminate.

## Resolution flow

1. Session create receives `mcp_servers` with one or more stdio specs.
2. For each spec, `connect.ts` detects `command` starting with `npm:` and calls the new `resolveNpmCommand(command, policy)`.
3. The resolver:
   - Validates the grammar above. Rejects with `PARSE_ERROR` (400) on any failure. Error message names the offending field; no package name leakage beyond what the operator already put in the spec.
   - Looks up `npx` in `policy.binary_paths`. If missing, throws `CAPABILITY_DENIED` (403) with message `"mcp 'npm:' sugar requires 'npx' in binaries_allowlist"`.
   - Returns `{ resolvedCommand: <npx-path>, prependArgs: ["-y", "<pkg>@<ver>"] }`.
4. `connect.ts` passes both through to `connectStdioMcpServer` which concatenates `prependArgs + spec.args`.

## Threat model

| # | Threat | Mitigation in v1.4 | Residual risk |
|---|--------|--------------------|---------------|
| T1 | Unpinned package (`npm:pkg`) → drifts when maintainer publishes a new version | Reject at parse | None |
| T2 | Tag/range pin (`@latest`, `^1.0.0`) → same drift under different syntax | Reject at parse | None |
| T3 | Typosquatting (`@modelcontextprotocoI/server-filesystem` — capital I) | Not solvable here. Operator must audit the package name they pin. | Operator-owned |
| T4 | Malicious post-install script in the pinned package | `npx -y` runs the bin but npm runs lifecycle scripts on install. We do not pass `--ignore-scripts` because many legit packages need prepare scripts. | Operator-owned: pin known packages only |
| T5 | Registry compromise / typo-squat resurrection of a removed version | npm immutability policy (published versions can't be re-published with different content) mitigates at the registry level | Operator-owned; consider vendoring for high-assurance deployments |
| T6 | Network egress at connect time (first `npx` downloads) | Documented. Connect slower on first run; subsequent runs hit npm cache | Accepted |
| T7 | `npx` not in allowlist → silent spawn failure | Explicit `CAPABILITY_DENIED` before spawn | None |
| T8 | Package name contains shell metacharacters | All spawns use `shell: false`. Args passed as array. Package name characters allowed by grammar are subset of npm's own rules. | None |
| T9 | Resource exhaustion (gigabyte package) | Out of scope for the resolver; covered by existing subprocess lifecycle (SIGTERM 2s → SIGKILL 5s on EOF) | Operator-owned (cap subprocess memory via OS) |
| T10 | Prepending `npx` args lets a caller smuggle flags via `spec.args[0] = "--some-npx-flag"` | `-y <pkg>@<ver>` comes first; anything after is interpreted by the downloaded bin, not npx | None |

## Backward compatibility

- Existing `transport: "stdio"` specs with non-`npm:` commands are unchanged.
- HTTP/SSE specs are untouched.
- No change to any response schema. Server discovery (`tools/list` etc.) is unchanged because it runs after spawn.

## Error codes

| Code | HTTP | Trigger |
|------|------|---------|
| `PARSE_ERROR` | 400 | grammar reject (bad name, missing version, tag, range) |
| `CAPABILITY_DENIED` | 403 | `npx` not in binary allowlist |
| `MCP_SERVER_UNREACHABLE` | 503 | spawn fails, npm download fails, server exits before handshake |

All three are existing codes — no new error surface.

## Telemetry

Resolver logs at `info` on successful expansion:

```
event: "mcp.stdio.npm_sugar_resolved"
server_id: "<spec.id>"
package: "<@scope/name>"
version: "<x.y.z>"
```

No package name is hashed or redacted — operators put it in the spec and already see it in their config. The package identifier is the one piece of data the operator most needs for audit.

## Test plan

Unit tests on the resolver (no network, no subprocess):

- accept: scoped + unscoped + prerelease + build metadata
- reject: bare, tag, range, malformed semver, empty, too-long name
- `CAPABILITY_DENIED` when `policy.binary_paths["npx"]` missing
- arg concatenation order: `[-y, pkg@ver, ...spec.args]`

Integration test (skipped unless `A2E_INTEGRATION_NPM=1`):

- spawn `npm:@modelcontextprotocol/server-everything@0.6.2` (official test server), complete handshake, list tools, disconnect. Gated because it hits the registry.

## Deprecation / evolution

- v1.5+ may add `npm:pkg@ver#sha512-...` integrity suffix — opt-in stricter form.
- v1.5+ may add `A2E_MCP_NPM_REGISTRY` env var to point at a private mirror. Trivial once the registry URL is a parameter.
- Removing the sugar is easy: strip the resolver and the spec becomes invalid — existing operators can always fall back to the raw `npx` command.
