# CONTRACT.md — a2e-shell (bounded-verb layer)

> RFC status. **Ampliación** del `CONTRACT.md` raíz. No reemplaza la shell real HTTP existente: añade por encima un **DSL cerrado de 8 verbos** que el LLM usa como superficie primaria. La shell real subyacente queda disponible como fallback vía el verbo `call`. Mismo proyecto `a2e-shell`, misma imagen, misma API HTTP; nuevo parser + nuevos verbos + nuevo canonical builder.
>
> Relación con el `CONTRACT.md` raíz:
> - La API HTTP de sesiones (`POST /sessions`, `POST /sessions/:id/exec`, ...) se preserva tal cual.
> - El campo `command` del exec request deja de aceptar bash arbitrario y pasa a aceptar **solo** líneas conformes a la EBNF del §2.3.
> - Los CLIs instalados (gh, aws, jq, curl, ...) siguen siendo la superficie de capacidades; se invocan vía `call` en lugar de ejecutarse directamente.
> - Breaking change: requiere bump mayor. Flag de transición `SHELL_MODE=bounded|raw|both` durante el período de deprecación.

## 1. Objetivo

Shell no-Turing de 8 verbos + meta-comandos, consumida por un LLM como único usuario, que reemplaza el protocolo A2E declarativo JSON. Un comando por turno, canonical response truncada, encadenamiento hasta completar workflow. El transcript append-only **es** el artefacto replayable — no existe formato JSON paralelo.

Éxito binario: un agente LLM arbitrario (Claude, GPT-4, Gemma, Llama) completa las 12 golden traces de `tests/golden/` con cobertura semántica 100% de los 8 verbos A2E-JSON y ≤20% de los tokens que consumiría la versión JSON equivalente.

## 2. Inputs y Outputs

### 2.1 Protocolo turno LLM↔runtime

Prompt del runtime al LLM (orden fijo, sin prosa extra):

```
SYSTEM:      <static system prompt, ≤300 tokens>
STATE:       <vars vivas: [{name, type, shape}, ...]>
HISTORY:     <últimos N=10 comandos + status_line>
LAST_OUTPUT: <canonical response completa del turno previo>
GOAL:        <objetivo del workflow, puesto por el orquestador>
```

Respuesta aceptada del LLM: **exactamente una línea** ajustada a la EBNF del §2.3. Prosa, múltiples comandos, JSON, markdown, fences → rechazo `E_GRAMMAR` con hint, sin side effect.

### 2.2 Canonical response (output de todo comando)

```
{
  status_line: string,     // "OK | <verb> → <type>[<shape>] in <ms>ms" | "ERR | <code>"
  shape:       Shape,      // {kind:"scalar"|"record"|"list"|"table"|"bytes", rows?, cols?, keys?, bytes}
  preview:     string,     // ≤512 bytes, marcador "…+Nmore" si truncado
  binding:     string|null,// "$x" si hubo asignación; null en otro caso
  stderr:      string,     // vacío si ok
  truncated:   boolean,
  error:       ErrorCode|null
}
```

### 2.3 EBNF (gramática cerrada, compilada por peggy)

```ebnf
line       = meta | stmt ;
stmt       = [ assign ] , verb , args , [ pipe ] ;
assign     = ident , "=" ;
verb       = "call" | "filter" | "transform" | "if" | "foreach"
           | "save" | "wait" | "merge" ;
meta       = ("describe"|"head"|"env"|"history"|"show"|"help") , [ args ] ;
pipe       = "|>" , verb , args ;                       (* encadenamiento opcional *)
args       = { arg } ;
arg        = var | string | number | json_lit | kwarg | block ;
kwarg      = ident , ":" , arg ;
var        = "$" , ident ;
string     = '"' , { str_char | interp } , '"' ;
interp     = "${" , ident , "}" ;                       (* solo vars nombradas *)
json_lit   = "{" , ... , "}" | "[" , ... , "]" ;        (* JSON estricto *)
block      = "do" , { stmt , ";" } , "end" ;            (* cuerpo de if/foreach *)
ident      = letter , { letter | digit | "_" } ;
```

**Excluido activamente** (rechazo parser): backticks, `$(...)`, heredocs, `>`, `<`, `>>`, `&&`, `||`, `;` fuera de `block`, globs, expansión de brace, `eval`, `exec`, `source`, comentarios multilínea.

### 2.4 Semántica operacional (tabla)

| Verbo | Input | Output | Side effect |
|-------|-------|--------|-------------|
| `call` | `<cli> <args...>` o `http <method> <url> [body:<json>]` | bytes o JSON parsed | spawn CLI o fetch HTTP |
| `filter` | `$list jq:"<expr>"` | list | ninguno |
| `transform` | `$x jq:"<expr>"` | valor | ninguno |
| `if` | `<cond> do ... end [else do ... end]` | valor última stmt | ejecuta rama |
| `foreach` | `$item in $list do ... end` | list de resultados | N iteraciones |
| `save` | `$x to:<cli-sink>` | `{ok:true}` | escribe vía CLI (ej. `gh`, `curl`) |
| `wait` | `ms:<n>` o `until:<pred>` | `{}` | pausa |
| `merge` | `$a $b [strategy:deep|shallow|concat]` | valor merged | ninguno |

Toda ejecución canoniza su output vía `src/io/canonical.ts` antes de devolver al runtime.

### 2.5 Errores (cerrado)

`E_GRAMMAR | E_UNBOUND_VAR | E_TYPE | E_CAPABILITY | E_TIMEOUT | E_CLI_EXIT | E_INTERP | E_TRUNCATE_REQUIRED`

## 3. Stack Anclado

- Runtime: Node.js 22 LTS + TypeScript strict
- Parser: peggy 4.x (grammar compilada AOT)
- Sandbox: `node:child_process.spawn` con `shell:false`, cwd fijo, PATH recortado
- HTTP: `node:http` directo
- Tests: vitest
- Tokenizer para métricas: `gpt-tokenizer` (cl100k_base)
- Session store: in-process Map (sin persistencia en v0.1)
- **No usar**: `eval`, `Function`, `vm.runIn*`, `shell:true`, `execSync`, nearley, chevrotain, Express/Hono/Fastify, ORMs, axios

## 4. Patrones del Proyecto

Greenfield. Establecer desde commit 1:

- Un único builder de respuesta: `src/io/canonical.ts`. Toda salida pasa por él.
- Un verbo por archivo en `src/verbs/<verb>.ts`, interfaz `{ schema, run(ctx, args): Promise<Value> }`.
- Un meta por archivo en `src/meta/<name>.ts`, misma interfaz.
- Errores como clase `ShellError` en `src/errors.ts` con `{code, hint}`. Nunca `throw string`.
- Parser aislado: `src/parser/grammar.pegjs` + `src/parser/parse.ts` + AST tipado en `src/parser/ast.ts`.
- Capability resolution en `src/caps/resolve.ts`. Nunca lee secrets, nunca loggea env values.
- Interpolación en un único helper `src/runtime/interp.ts` con escape whitelist estricto.

## 5. Artefactos a Producir

1. `src/parser/grammar.pegjs` — EBNF §2.3 compilable. Máx 250 líneas.
2. `src/parser/parse.ts` — `parse(line): Result<AST, E_GRAMMAR>`. Máx 80 líneas.
3. `src/parser/ast.ts` — tipos AST. Máx 120 líneas.
4. `src/verbs/{call,filter,transform,if,foreach,save,wait,merge}.ts` — uno por verbo. Máx 150 líneas c/u. Sin parsing, sin logging de negocio.
5. `src/meta/{describe,head,env,history,show,help}.ts` — máx 80 líneas c/u.
6. `src/runtime/session.ts` — estado `{vars, last, transcript}`. Máx 200 líneas.
7. `src/runtime/execute.ts` — dispatcher AST→verbo, aplica interpolación. Máx 120 líneas.
8. `src/runtime/interp.ts` — interpolación `${}` con escape. Máx 80 líneas.
9. `src/io/canonical.ts` — builder + truncación a 512B preview. Máx 100 líneas.
10. `src/caps/resolve.ts` — chequeo CLI vía PATH + allowlist. Máx 60 líneas.
11. `src/errors.ts` — `ShellError` + `ErrorCode` enum. Máx 60 líneas.
12. `src/http/server.ts` — `POST /sessions`, `POST /sessions/:id/exec`, `DELETE /sessions/:id`. Máx 150 líneas.
13. `tests/grammar.test.ts` — parsea/rechaza ejemplos de cada verbo y meta.
14. `tests/verbs/*.test.ts` — uno por verbo. Happy path + ≥2 errores c/u.
15. `tests/golden/*.trace` — 12 sesiones canónicas (input LLM + canonical esperada byte-exacta).
16. `docs/GRAMMAR.ebnf` — EBNF humana auditable (copia formateada de §2.3).

## 6. Criterios de Aceptación

- [ ] `npm test` verde al 100%
- [ ] `npm run typecheck` sin errores
- [ ] `npm run lint` sin warnings
- [ ] 12/12 golden traces producen canonical response byte-exacta
- [ ] Cobertura verbos A2E-JSON = 100% (8/8 con contraparte semántica)
- [ ] Comando fuera de EBNF → `E_GRAMMAR` con `hint` no vacío y sesión intacta
- [ ] Referencia a `$x` no definida → `E_UNBOUND_VAR`, sesión intacta
- [ ] Interpolación de valor conteniendo `$(`, `` ` ``, `|`, `;`, `&`, `\n`, `\r` → `E_INTERP` antes de ejecutar
- [ ] `call` a CLI fuera de allowlist → `E_CAPABILITY` antes de `spawn`
- [ ] Preview > 512B → `truncated:true` + `shape.bytes` con total real; `show $x` entrega completo
- [ ] Ninguna env var con nombre match `/(_TOKEN|_SECRET|_KEY|AWS_|GCP_|AZURE_)$/i` aparece en ninguna canonical response (ni `preview`, ni `stderr`, ni `binding`, ni `status_line`)
- [ ] Parser rechaza: backticks, `$()`, heredocs, `>`/`<`, `&&`, `||`, `;` fuera de `block`, globs, brace expansion
- [ ] Tokens por golden trace ≤ 20% del equivalente A2E-JSON (medido con `gpt-tokenizer`)
- [ ] Tasa de rechazo sintáctico primer intento < 5% en las 12 golden traces (medido con al menos 2 modelos distintos)
- [ ] `EXEC_TIMEOUT_MS` (default 15000) excedido → SIGKILL + `E_TIMEOUT`

## 7. Restricciones Duras

- NO implementar `eval`, `exec`, `source`, expansión de comandos, subshells, redirecciones, pipes tipo bash, globbing, command substitution.
- NO agregar verbos fuera de los 8. Extensibilidad solo vía `call <cli>`.
- NO leer, loggear, ni serializar env vars cuyo nombre matchee la regex de §6. Si el LLM referencia una, responder `E_CAPABILITY` sin revelar existencia.
- NO serializar `process.env` completo en ninguna respuesta. `env` meta lista solo **nombres** inyectados explícitamente al scope de sesión.
- NO resolver credenciales en el runtime del LLM. Resolución en el borde (env, credential helpers, AWS/GCP profiles). El LLM nunca ve ni emite tokens.
- NO usar `shell:true` en ningún `spawn`. Argv siempre array.
- NO truncar silenciosamente: si hay truncación, `truncated:true` y `shape.bytes` reporta total real.
- NO emitir output fuera del canonical response. Ni `console.log`, ni stdout raw, ni streaming parcial sin envelope.
- NO modificar archivos fuera de `src/`, `tests/`, `docs/GRAMMAR.ebnf`.
- NO crear README, CHANGELOG, ni docs adicionales fuera de los listados en §5.
- NO añadir dependencias fuera del §3.
- NO commits. Dejar cambios en working directory.
- NO usar `any` en TypeScript. Si inevitable, `unknown` + narrowing.
- Si un criterio del §6 no se puede cumplir, **STOP y reportar el bloqueo**. No relajar la gramática, no ampliar allowlist, no implementar workarounds silenciosos.
