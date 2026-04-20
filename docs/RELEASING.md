# Release playbook

How to cut an a2e-shell release without shipping a broken production image.

## Background

The vitest suite runs from `src/`, which means it never exercises the **compiled + pruned** production layout (`tsc` output + `npm prune --omit=dev`). Two kinds of bugs escape vitest and land in prod:

1. **Runtime dependencies miscategorized as `devDependencies`** — the test suite has every package; `npm prune --omit=dev` removes some that `dist/` imports at runtime.
2. **Non-TypeScript assets** — `.pegjs` grammars, `.json` fixtures, etc. `tsc` only compiles `.ts` files, so an asset referenced via `readFileSync(path.join(__dirname, "grammar.pegjs"))` disappears in the built output.

v1.3.0 shipped with one of each (peggy as devDep, grammar.pegjs not copied to `dist/`). Neither test nor lint caught them — the production Docker image crashed on the first bounded-mode exec. Hotfixed as v1.3.1 + v1.3.2.

The fix that prevents future recurrences is `scripts/smoke-prod-image.sh`, now gated by CI.

## Before you tag

Run these **in order**. The CI pipeline runs 1 and 2 automatically on every push; 3 runs on `push` to main and on `pull_request` via the `docker-smoke` job. 4 is manual.

### 1. Tests + typecheck (automated)

```bash
npm ci
npm run typecheck
npm test
```

Expected: 0 failures, 0 todo. Typecheck must be clean.

### 2. Linting (automated)

```bash
npm run lint
```

Expected: 0 warnings, 0 errors.

### 3. Production Docker smoke (automated via `docker-smoke` CI job)

```bash
bash scripts/smoke-prod-image.sh
```

Builds the production Docker image, runs it in an ephemeral container, and exercises three code paths:

| Path | What breaks without this |
|---|---|
| **Unrestricted exec** | Bash pipeline, allowlist enforcement, canonical response |
| **Bounded mode** | Parser (`peggy`), grammar asset (`grammar.pegjs`), dispatcher, canonical builder |
| **stdio MCP transport** | Subprocess spawn, line-framed JSON-RPC, lifecycle, binary allowlist |

If any of these fail, **DO NOT tag**. The v1.3.0 bugs would have tripped the bounded path immediately.

Exit codes:
- `0` — all passed
- `1` — Docker build failed
- `2` — container didn't come up (`/healthz` never responded)
- `3` — unrestricted exec failed
- `4` — bounded exec failed (the v1.3.0 regression path)
- `5` — stdio MCP failed

### 4. Benchmarks (manual, SLO-bounded)

```bash
# HTTP p95 latency SLO (also runs in CI under the `bench` job)
npm run bench:http

# Token-cost gate (bounded vs A2E-JSON)
npm run bench:bounded
```

Expected: all gates pass. If `bench:bounded` regresses past the per-regime thresholds in `tests/integration/token-budget.test.ts`, the release is blocked.

## Cutting the tag

Once all four are green:

```bash
# 1. Bump the version
vim package.json          # "version": "X.Y.Z"
vim CHANGELOG.md          # add [X.Y.Z] entry at the top

# 2. Confirm what's changing
git diff

# 3. Commit + tag + push
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: vX.Y.Z — <headline>"
git tag -a vX.Y.Z -m "vX.Y.Z — <headline>

<body>"
git push origin main vX.Y.Z

# 4. Create the GitHub release
gh release create vX.Y.Z \
  [--prerelease] \
  --title "vX.Y.Z — <headline>" \
  --notes "$(cat <<'EOF'
...CHANGELOG excerpt...
EOF
)"
```

For release candidates (`-rc.N` suffix): pass `--prerelease` to `gh release create`. For GA: omit it.

## After tagging (prod deploy)

On the production VPS:

```bash
cd /opt/a2e-shell/repo
git fetch --tags origin
git checkout vX.Y.Z
docker build -t a2e-shell:vX.Y.Z .

# Cutover, preserving the old container for 24h rollback
docker rename a2e-shell a2e-shell-<PREVIOUS>-prev
docker stop a2e-shell-<PREVIOUS>-prev

docker run -d \
  --name a2e-shell \
  --restart unless-stopped \
  -p 127.0.0.1:8090:8080 \
  -v /var/lib/a2e-shell/sessions:/sessions \
  -e A2E_PORT=8080 \
  -e A2E_SESSIONS_DIR=/sessions \
  -e A2E_AUTH_TOKENS="$A2E_AUTH_TOKEN" \
  -e A2E_MAX_REQUEST_BYTES=1048576 \
  -e A2E_RATE_LIMIT_PER_MINUTE=120 \
  -e A2E_RATE_LIMIT_CREATE_PER_MINUTE=20 \
  -e A2E_GRACE_PERIOD_MS=25000 \
  -e A2E_LOG_LEVEL=info \
  -e NODE_ENV=production \
  a2e-shell:vX.Y.Z

# Confirm
sleep 5
docker ps --filter name=a2e-shell
curl -sS https://a2e.ardf.dev/healthz
```

Run the same three smoke tests against the live endpoint (not just `/healthz`). If any fail, **roll back immediately**:

```bash
docker stop a2e-shell
docker start a2e-shell-<PREVIOUS>-prev
docker rename a2e-shell-<PREVIOUS>-prev a2e-shell
```

After 24h of clean operation, clean up the rollback container:

```bash
docker rm a2e-shell-<PREVIOUS>-prev
```

## Hotfix protocol

If a bug escapes to prod:

1. **Don't rush to revert the tag.** Git tags are load-bearing for consumers; rewriting them breaks existing clones/releases. Ship a **patch release** (`X.Y.Z+1`) instead.
2. Fix the bug on `main`. Include a CHANGELOG entry that explicitly names the impact and the affected prior versions.
3. Run the full release checklist again, including the Docker smoke.
4. Tag, push, redeploy.
5. The previous GitHub release note should be edited to add a banner pointing at the hotfix — consumers landing on it should know it's not the latest stable.

See v1.3.1 and v1.3.2 for a worked example.

## References

- `scripts/smoke-prod-image.sh` — the smoke test itself.
- `.github/workflows/ci.yml` — CI jobs (`verify`, `bench`, `docker-smoke`).
- `CHANGELOG.md` — historical release notes.
- `docs/ROADMAP.md` — forward planning; tells you what should land in the next minor.
