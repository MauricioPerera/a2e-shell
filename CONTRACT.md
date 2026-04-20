# CONTRACT.md — a2e-shell

> **Status**: this document is the **v1.0 baseline contract** — the acceptance spec the project was built against for the initial release. Subsequent releases are additive:
>
> - **v1.1** — MCP gateway (inbound). Session spec gains `mcp_servers` array; the agent can invoke MCP tools/resources/prompts through the same canonical response pipeline as bash exec. Spec: [`docs/rfcs/001-mcp-gateway.md`](docs/rfcs/001-mcp-gateway.md).
> - **v1.2** — Bounded-verb shell. `mode: "bounded"` sessions execute a closed-grammar DSL (8 verbs + 6 meta) instead of bash. Spec: [`docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md`](docs/rfcs/RFC-bounded-verb-shell-CONTRACT.md).
> - **v1.3** — MCP stdio transport + `Mcp-Session-Id` threading + per-server rate limits. Spec: [`docs/rfcs/002-mcp-stdio-and-breadth.md`](docs/rfcs/002-mcp-stdio-and-breadth.md).
>
> For the **live, current API surface** see [`docs/API.md`](docs/API.md); for release-by-release history see [`CHANGELOG.md`](CHANGELOG.md); for forward planning see [`docs/ROADMAP.md`](docs/ROADMAP.md). Sections below that reference v1-only behavior (e.g. "mode=bounded reserved for v2") are historical — the current behavior lives in the docs above.

## 1. Objetivo

Servidor HTTP que expone una shell real del sistema operativo como **tool primitiva** a cualquier agente LLM. Ofrece sesiones persistentes, output canónico tokenizado y capability scoping por allowlist. La superficie de capacidades se amplía instalando CLIs de terceros (`gh`, `aws`, `kubectl`, `jq`, `curl`, `git`, ...) en la imagen de despliegue — el agente los invoca como shell real, sin wrappers.

Éxito binario: un agente arbitrario (Claude, GPT-4, Llama) completa una sesión canónica de 10 comandos que mezcla HTTP + 3 CLIs distintos consumiendo ≤10% de los tokens equivalentes en A2E-JSON, con 0 leakage de credenciales al transcript.

## 2. Inputs y Outputs

### 2.0 Transporte

HTTP/1.1 request-response. `Content-Type: application/json`. Auth: `Authorization: Bearer <token>`.

| Método | Ruta | Propósito |
|---|---|---|
| POST | `/sessions` | Crear sesión |
| POST | `/sessions/:id/exec` | Ejecutar comando (tool primitiva) |
| PATCH | `/sessions/:id/cwd` | Set cwd de sesión |
| PATCH | `/sessions/:id/env` | Set/unset env var de sesión |
| GET | `/sessions/:id/state` | bindings + cwd + env keys + history_size |
| GET | `/sessions/:id/transcript` | JSONL completo |
| POST | `/sessions/:id/replay` | Replay determinista |
| DELETE | `/sessions/:id` | Terminar sesión |

Códigos: `200` exec ok, `201` sesión creada, `400` payload mal formado, `401` auth, `403` capability denegada, `404` sesión, `409` sesión terminada/en replay, `413` payload, `429` quota, `500` interno.

### 2.1 `POST /sessions`

```ts
// Input
{
  mode?: "unrestricted" | "bounded",    // default: "unrestricted" (v2: bounded)
  capabilities?: {
    binaries_allowlist?: string[],
    http_domains_allowlist?: string[],
    max_exec_timeout_ms?: number,
    max_response_bytes?: number,
    max_session_ttl_s?: number
  },
  initial_cwd?: string,                 // default: dir aislado de sesión
  initial_env?: Record<string,string>   // overlay sobre env del runtime
}
// Output
{ session_id: string, mode: string, cwd: string, expires_at: string }
```

### 2.2 `POST /sessions/:id/exec`

```ts
// Input
{
  command: string,                      // comando shell, bash-compatible
  bind_as?: string,                     // captura stdout como $<name>
  stdin?: string,                       // literal o "${$var}"
  timeout_ms?: number,                  // cap por capabilities.max_exec_timeout_ms
  idempotency_key?: string
}
// Output
{
  status_line: string,                  // "[exit 0]", "[exit 2]", "[error: <code>]"
  shape: string | null,                 // "text[412B]", "json<Array<Order>>[95]", "jsonl[142]"
  preview: unknown,                     // primeros DEFAULT_PREVIEW_BYTES del stdout
  binding: string | null,               // "$<name>" si bind_as
  error?: { code: ErrorCode, message: string }
}
```

Error codes: `PARSE_ERROR | CAPABILITY_DENIED | CLI_MISSING | INTERPOLATION_REJECTED | SCOPE_MISS | TIMEOUT | SIZE_LIMIT | UPSTREAM_ERROR | INTERNAL`.

### 2.3 Detección de shape

El formatter inspecciona el stdout y clasifica:
- JSON válido → `json<type>[count]` (type inferido del primer elemento si es array)
- Cada línea JSON válida → `jsonl[N lines]`
- Binary (null bytes) → `binary[N bytes]`
- Resto → `text[N bytes]`

## 3. Stack

- Runtime: Node.js 22 LTS + TypeScript 5.x (`strict: true`)
- HTTP server: Hono 4.x + `@hono/node-server`
- Subprocess: `node:child_process.spawn` con argv-array (nunca `shell:true` con concatenación), env recortado, cwd explícito
- Base imagen: Debian-slim + set base de CLIs (`curl`, `jq`, `gh`, `aws-cli`, `kubectl`, `git`, `grep`, `sed`, `awk`, `ripgrep`). Extensible vía `Dockerfile` del deployer
- HTTP client: `fetch` nativo (Undici)
- Validación: zod (request/response/state)
- Testing: vitest + cliente Hono vía `app.request`
- Persistencia: JSONL en `./sessions/<id>/transcript.jsonl` + `state.json`
- NO usar: axios, express, fastify, lodash, ts-node, eval, vm, isolated-vm, cliente/servidor MCP propio

## 4. Patrones de proyecto

Proyecto nuevo. Establecer:

- Rutas HTTP en `src/http/routes/*.ts`, una función por endpoint
- Session state (cwd, env_overlay, bindings, transcript) en `src/session/state.ts`
- Ejecutor stateless en `src/exec/run.ts` — cada exec es un `spawn` nuevo con `cwd=session.cwd`, `env=base_env + capabilities.env + session.env_overlay`, PATH construido desde allowlist
- Interpolación en `src/exec/interpolate.ts` — regex `^\$\{\$[a-zA-Z_][a-zA-Z0-9_]*\}$` por token. Rechaza operadores, espacios internos, paths complejos en v1
- Formatter en `src/io/format.ts` — `{status_line, shape, preview, binding}`
- Redactor de credenciales en `src/credentials/redactor.ts` — corre ANTES del formatter
- Capabilities en `src/capabilities/policy.ts`
- Interceptor de `cd`, `export`, `unset` al inicio del comando en `src/exec/state-intercept.ts` — actualiza session state sin spawn

## 5. Artefactos a producir

1. `src/http/server.ts` + `src/http/routes/*.ts` — Hono app con los 8 endpoints. Middleware: auth, body limit, rate limit por session_id, request id. Máx 400 líneas combinadas.

2. `src/session/state.ts` — clase Session: cwd, env_overlay, bindings, transcript append-only, replay. Máx 250 líneas.

3. `src/exec/run.ts` — ejecutor stateless. Input: session + command + stdin + timeout. Output: raw {stdout, stderr, exit_code, duration_ms}. Máx 200 líneas.

4. `src/exec/interpolate.ts` — resolución de `${$var}`, rechazo estricto. Máx 120 líneas.

5. `src/exec/state-intercept.ts` — detecta `cd <path>`, `export X=Y`, `unset X` al inicio. Actualiza session state. Comando compuesto (`cd /x && cmd`) → ejecuta en subprocess con cwd override para ESE comando; persistencia de cwd solo si el comando es `cd` puro. Máx 180 líneas.

6. `src/io/format.ts` — shape detection + preview truncation. Máx 200 líneas.

7. `src/capabilities/policy.ts` — allowlist de binarios (construye PATH per-session), allowlist de dominios HTTP (si v1 lo impone — ver §7), quotas. Máx 250 líneas.

8. `src/session/transcript.ts` — JSONL append-only + replay. Máx 200 líneas.

9. `src/credentials/redactor.ts` — scan de stdout/stderr contra valores de env de credenciales, redacta a `[REDACTED]`. Corre en TODA salida antes de formatear. Máx 150 líneas.

10. `docs/LLM-PROMPT.md` — system prompt destinado al LLM. ≤400 tokens (tiktoken `cl100k_base`). Enseña: tool primitiva `exec`, bindings `$x`, interpolación `${$x}`, meta-info de shape/preview, cuándo usar `bind_as` + `cat/jq/head` para inspección detallada, lista de CLIs instaladas.

11. `tests/` — `http.test.ts`, `exec.test.ts`, `session.test.ts`, `replay.test.ts`, `interpolate.test.ts`, `redactor.test.ts`, `state-intercept.test.ts`, `integration/third-party-cli.test.ts` (ejerce `gh`, `jq`, `curl` end-to-end), `benchmarks/tokens.ts` (100 tareas comparadas contra A2E-JSON).

12. `Dockerfile` — imagen base publicable con set base de CLIs. Documenta cómo extender.

13. `docs/BOUNDED-MODE.md` (apéndice, v2) — describe cómo `GRAMMAR.ebnf` se aplica como validador encima del ejecutor cuando `mode: "bounded"`. No implementado en v1.

## 6. Criterios de aceptación

- [ ] `npm test` verde al 100%
- [ ] `npm run typecheck` sin errores, `strict: true`
- [ ] `npm run lint` sin warnings
- [ ] Los 8 endpoints responden con códigos correctos de §2.0
- [ ] `exec` con `cd /tmp` → siguiente `exec pwd` devuelve `/tmp` (intercept)
- [ ] `exec` con `export FOO=bar` → siguiente `exec echo $FOO` devuelve `bar` (intercept)
- [ ] `exec` con `bind_as: "users"` → `${$users}` interpolable en siguiente exec
- [ ] `${$no_existe}` → `SCOPE_MISS` sin spawn
- [ ] `${$var + 1}`, `${$var.field}`, `${cmd}` → `INTERPOLATION_REJECTED` sin spawn
- [ ] Comando que invoca binario fuera de `binaries_allowlist` → `CAPABILITY_DENIED` sin spawn
- [ ] Stdout > `max_response_bytes` → truncado en preview; `shape` refleja tamaño real
- [ ] Shape detection correcta para: JSON array, JSON object, JSONL, texto plano, binary
- [ ] Credenciales: ningún valor del env de runtime ni de `initial_env` aparece en transcript, logs, response ni stderr capturado
- [ ] Replay de transcript en 5 traces marcados `replay: deterministic` produce estado final idéntico
- [ ] `docs/LLM-PROMPT.md` ≤ 550 tokens (tiktoken `cl100k_base`) — raised from 400 to accommodate the catalog section; base (no-catalog) sections must stay ≤ 400
- [ ] Benchmark tokens ≤ 0.10 ratio vs A2E-JSON sobre 100 tareas
- [ ] `tests/integration/third-party-cli.test.ts`: secuencia `gh api /user | jq '.login'` con `bind_as` y `${$}` interpolación funciona end-to-end
- [ ] Auth inválido → `401` con body `{error: "UNAUTHORIZED", request_id}` sin detalles
- [ ] Stack traces jamás aparecen en respuestas HTTP
- [ ] `mode: "bounded"` en v1 → `400` con `NOT_IMPLEMENTED_V1` (reservado para v2)

## 7. Restricciones duras

- NO implementes eval, vm, Function(), ni ejecutor de código arbitrario en el HOST Node. El subprocess sí ejecuta bash real — ese es el modelo; el sandbox vive en PATH restringido + quotas + cwd aislado + redactor.
- NO uses `shell: true` con concatenación de strings. Si necesitas parsing de shell, spawn `bash -c "<command>"` con `<command>` como argv[2] ÚNICO string, nunca concatenado con datos del LLM fuera de `command`.
- NO concatenes valores de bindings en el string `command`. Toda composición es vía `${$var}` que el interpolador resuelve posicionalmente antes del spawn.
- NO expongas credenciales, tokens ni secretos al transcript, logs, output, binding, shape ni preview. Pipeline obligatorio: `env → subprocess → raw stdout → redactor → formatter → cliente`.
- NO uses el PATH del host. Cada subprocess recibe PATH construido desde `capabilities.binaries_allowlist` mapeado a rutas absolutas conocidas en la imagen.
- NO permitas interpolación con operadores, llamadas, paths complejos, concatenación. Solo `${$nombre}` por token. Cualquier otra forma → `INTERPOLATION_REJECTED`.
- NO dumpees stdout completo por defecto. `preview` siempre truncado a `DEFAULT_PREVIEW_BYTES` (default 2KB). Contenido completo solo vía `bind_as` + exec posterior (`cat ${$var} | head -c 4096`).
- NO implementes SSE, WebSocket, long-polling en v1. Request-response clásico.
- NO aceptes `Authorization` en query string ni body. Solo header.
- NO habilites CORS `Access-Control-Allow-Origin: *`. Default: sin CORS. Opt-in por env a orígenes explícitos.
- NO devuelvas stack traces, rutas absolutas del host, ni nombres de archivo fuente en respuestas HTTP. Errores: `{error: CODE, request_id}`.
- NO implementes cliente ni servidor MCP dentro del proyecto. El wrapping a2e-shell-as-MCP-server es proyecto separado, fuera de scope.
- NO mezcles `mode` dentro de una misma sesión. Se fija en la creación.
- NO añadas UI humana, dashboard web, CLI interactiva para humanos. Consumidor único: agente LLM sobre HTTP.
- NO cachees stdout ni respuestas HTTP del exec sin binding explícito. `bind_as` es el único mecanismo de persistencia entre comandos.
- Si un criterio de §6 no se cumple, DETENTE y reporta el bloqueo con trace. No implementes workarounds silenciosos.
- Si una decisión no está cubierta, DETENTE y pregunta al usuario humano. No improvises ontología (no añadas flags, endpoints ni semánticas no listadas).
