# Deployment templates

Reference manifests for running a2e-shell in production. Pick one:

| Target | Path | When |
|---|---|---|
| Kubernetes | `kubernetes/a2e-shell.yaml` | You already run k8s. Includes Deployment, Service, Ingress, HPA, PDB. |
| Docker Compose + Traefik | `docker-compose.yml` | Single-host VM, self-issued TLS via Let's Encrypt. |
| AWS (Terraform) | `terraform/aws/` | ECS Fargate + ALB + EFS. Drop-in module. |

## Things every deployment must get right

1. **Session affinity.** a2e-shell keeps session state (cwd, env, bindings, transcript, catalog worktree) on the worker's local disk. A session created on worker A cannot be served by worker B. Every response carries `X-Worker-Id`; the load balancer MUST route subsequent requests for the same session to the same worker. All three templates here configure affinity via a sticky cookie — which means **the client must propagate cookies** across its exec calls. Stateless clients need a different strategy (header-based hashing at an L7 LB, or pin one-session-per-worker-pod).

2. **Termination grace.** `A2E_GRACE_PERIOD_MS` must be strictly below the orchestrator's kill timeout:
   - Kubernetes: `terminationGracePeriodSeconds` = grace_period_ms / 1000 + 5s
   - Docker Compose: `stop_grace_period` ≥ grace_period_ms / 1000 + 5s
   - ECS: `stopTimeout` (default 30s) covers our default 25s
3. **Auth token secret.** Never put `A2E_AUTH_TOKENS` in a ConfigMap or tfvars file. Use a real secret store (Kubernetes Secret with restricted RBAC, AWS Secrets Manager, SOPS-encrypted file in git).

4. **Buffering off for SSE.** `POST /sessions/:id/exec` with `Accept: text/event-stream` emits incremental chunks. Proxies that buffer responses (default for most ingress controllers) will break streaming. Each template here disables buffering on the relevant path.

5. **TLS.** If you terminate TLS at the ingress/LB/traefik, leave `A2E_TLS_*` unset. If a2e-shell faces the network directly, set `A2E_TLS_CERT_PATH` + `A2E_TLS_KEY_PATH` (and optionally `A2E_TLS_CLIENT_CA_PATH` for mTLS) — see `docs/OPERATIONS.md` for details.

## Things these templates do NOT handle

- **Cross-worker session migration.** Sessions are local per process. Scaling out adds capacity for new sessions; in-flight sessions stay pinned. v0.3 added experimental `POST /sessions/:id/resume` from disk, but the disk is per-pod in these templates — resume works across task restarts on the same pod, not across pods.
- **Horizontal autoscaling on custom metrics.** The Kubernetes HPA here scales on CPU. For real workload-based scaling, wire Prometheus + KEDA and scale on `a2e_sessions_active`.
- **Catalog cache sharing.** If multiple workers bootstrap the same `repo_url`, they each mirror independently. That's the current design — cross-worker mirror sharing is out of v1.0 scope.
- **Backup.** The `emptyDir` / Docker volume / EFS used for sessions is not backed up. Transcripts older than your retention window are gone on pod loss. If audit is a requirement, ship transcripts out-of-band.

## Image

All templates assume the published image at `ghcr.io/mauricioperera/a2e-shell:<tag>`. Build locally with `docker build -t a2e-shell:dev .` from the repo root.
