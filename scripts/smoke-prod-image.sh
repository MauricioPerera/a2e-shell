#!/usr/bin/env bash
#
# Pre-release smoke test against a freshly-built production Docker image.
#
# Why: vitest runs from src/, so it never exercises the compiled + pruned
# production layout. v1.3.0 shipped with two separate ENOENT-family bugs
# (peggy as devDep, grammar.pegjs not copied to dist/) that only surfaced
# AFTER prod deploy. This script closes that gap by running the same three
# code paths against a real container before tagging.
#
# Usage:
#   ./scripts/smoke-prod-image.sh [IMAGE_TAG]
#
# If IMAGE_TAG is omitted, builds as "a2e-shell:smoke-$(date +%s)".
# Ephemeral: uses a random port and random auth token; removes the container
# and image on exit (including on failure).
#
# Exit codes:
#   0  all smoke tests passed
#   1  build failed
#   2  container failed to start or /healthz never came up
#   3  unrestricted smoke failed
#   4  bounded smoke failed (the v1.3.0 regression path)
#   5  stdio MCP smoke failed

set -euo pipefail

IMAGE_TAG="${1:-a2e-shell:smoke-$(date +%s)}"
CONTAINER_NAME="a2e-smoke-$(openssl rand -hex 4)"
PORT=$(( 20000 + RANDOM % 10000 ))
AUTH_TOKEN=$(openssl rand -hex 32)
TIMEOUT_HEALTH=30

# Sessions live INSIDE the container (ephemeral, in-image /sessions dir that
# the Dockerfile creates with correct ownership for uid 10001 `a2e`). A host-
# mount would require matching uid on the host, which varies by CI runner.

cleanup() {
  local exit_code=$?
  echo ""
  echo "=== cleanup ==="
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  # Remove the image only if we built it in this run (tag starts with smoke-).
  if [[ "$IMAGE_TAG" == a2e-shell:smoke-* ]]; then
    docker rmi "$IMAGE_TAG" >/dev/null 2>&1 || true
  fi
  if [[ $exit_code -eq 0 ]]; then
    echo "smoke PASSED"
  else
    echo "smoke FAILED (exit $exit_code)"
  fi
  exit $exit_code
}
trap cleanup EXIT

echo "=== build ==="
echo "image:     $IMAGE_TAG"
echo "container: $CONTAINER_NAME"
echo "port:      $PORT"
echo ""

docker build -t "$IMAGE_TAG" . || exit 1

echo ""
echo "=== run ==="
docker run -d \
  --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${PORT}:8080" \
  -e A2E_PORT=8080 \
  -e A2E_SESSIONS_DIR=/sessions \
  -e "A2E_AUTH_TOKENS=$AUTH_TOKEN" \
  -e A2E_LOG_LEVEL=info \
  -e NODE_ENV=production \
  "$IMAGE_TAG" >/dev/null

# Wait for /healthz
echo -n "waiting for /healthz "
for i in $(seq 1 $TIMEOUT_HEALTH); do
  if curl -sS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo " ok (after ${i}s)"
    break
  fi
  echo -n "."
  sleep 1
  if [[ $i -eq $TIMEOUT_HEALTH ]]; then
    echo " timeout"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -20
    exit 2
  fi
done

BASE="http://127.0.0.1:${PORT}"
AUTH="-H authorization:Bearer\ $AUTH_TOKEN"

# Helper: fail early with context.
assert_ok() {
  local label="$1"; local body="$2"; local code="$3"
  if [[ -z "$body" ]] || echo "$body" | grep -q '"error"'; then
    echo "FAIL [$label]: $body"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -15
    exit "$code"
  fi
  echo "OK   [$label]"
}

# ---------------------------------------------------------------------------
# Test 1: unrestricted exec path (v1.0 surface)
# ---------------------------------------------------------------------------
echo ""
echo "=== unrestricted ==="
SID=$(curl -sS -X POST "$BASE/sessions" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"binaries_allowlist":["echo"]}}' | jq -r .session_id)
assert_ok "create" "$SID" 3

OUT=$(curl -sS -X POST "$BASE/sessions/$SID/exec" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"echo smoke-ok"}')
echo "$OUT" | jq -c '{status_line, preview}'
echo "$OUT" | grep -q "smoke-ok" || { echo "FAIL [unrestricted exec]"; exit 3; }

curl -sS -X DELETE "$BASE/sessions/$SID" -H "authorization: Bearer $AUTH_TOKEN" -o /dev/null

# ---------------------------------------------------------------------------
# Test 2: bounded mode — THE v1.3.0 REGRESSION PATH
# ---------------------------------------------------------------------------
# This is the exact code path that crashed with ERR_MODULE_NOT_FOUND (peggy)
# and ENOENT (grammar.pegjs). If either bug resurfaces, this test catches it
# before tagging.
echo ""
echo "=== bounded ==="
SID=$(curl -sS -X POST "$BASE/sessions" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"mode":"bounded"}' | jq -r .session_id)
assert_ok "create-bounded" "$SID" 4

OUT=$(curl -sS -X POST "$BASE/sessions/$SID/exec" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"save [1,2,3] as nums"}')
echo "$OUT" | jq -c '{status_line, binding, shape}'
echo "$OUT" | grep -q '"status_line":"OK | save' || { echo "FAIL [bounded save]: $OUT"; docker logs "$CONTAINER_NAME" 2>&1 | tail -20; exit 4; }

OUT=$(curl -sS -X POST "$BASE/sessions/$SID/exec" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"describe $nums"}')
echo "$OUT" | jq -c '{status_line, preview}'
echo "$OUT" | grep -q '"kind":"list"' || { echo "FAIL [bounded describe]: $OUT"; exit 4; }

curl -sS -X DELETE "$BASE/sessions/$SID" -H "authorization: Bearer $AUTH_TOKEN" -o /dev/null

# ---------------------------------------------------------------------------
# Test 3: stdio MCP transport — v1.3 new surface
# ---------------------------------------------------------------------------
echo ""
echo "=== stdio MCP ==="
# Tiny inline MCP server: initialize + tools/list + tools/call echo
read -r -d '' MCP_SCRIPT <<'JS' || true
const rl=require("readline").createInterface({input:process.stdin});
rl.on("line",l=>{try{const r=JSON.parse(l);
if(r.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:"2025-06-18",serverInfo:{name:"smoke",version:"0"},capabilities:{tools:{}}}})+"\n");
else if(r.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{tools:[{name:"ping",inputSchema:{type:"object"}}]}})+"\n");
else if(r.method==="resources/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{resources:[]}})+"\n");
else if(r.method==="prompts/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{prompts:[]}})+"\n");
else if(r.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{content:[{type:"text",text:"pong"}],isError:false}})+"\n");
}catch(e){}});
JS

SID=$(curl -sS -X POST "$BASE/sessions" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg script "$MCP_SCRIPT" '{
    capabilities: { binaries_allowlist: ["node"] },
    mcp_servers: [{
      id: "smoke",
      transport: "stdio",
      command: "node",
      args: ["-e", $script]
    }]
  }')" | jq -r .session_id)
assert_ok "create-stdio-mcp" "$SID" 5

OUT=$(curl -sS -X POST "$BASE/sessions/$SID/exec" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"/bin/mcp-invoke smoke ping {}"}')
echo "$OUT" | jq -c '{status_line, preview}'
echo "$OUT" | grep -q "pong" || { echo "FAIL [stdio MCP]: $OUT"; docker logs "$CONTAINER_NAME" 2>&1 | tail -20; exit 5; }

curl -sS -X DELETE "$BASE/sessions/$SID" -H "authorization: Bearer $AUTH_TOKEN" -o /dev/null

echo ""
echo "=== all smoke tests passed ==="
