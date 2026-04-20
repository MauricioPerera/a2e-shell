# a2e-shell — observability stack

Prometheus + Alertmanager + Grafana sidecar for scraping `a2e-shell`'s `/metrics` endpoint, visualizing traffic / latency / errors / rate limits / process health, and firing alerts when availability or performance regress.

## What's here

```
deploy/monitoring/
├── docker-compose.yml                  ← prometheus + alertmanager + grafana
├── prometheus.yml                      ← scrape config + alertmanager target + rule files
├── alert.rules.yml                     ← alerting rules (7 alerts, critical + warning)
├── alertmanager.yml                    ← routes + webhook receiver + inhibit rules
└── grafana/provisioning/
    ├── datasources/prometheus.yml      ← auto-connect Grafana to Prometheus
    └── dashboards/
        ├── dashboard-provider.yml      ← file-based dashboard provider
        └── a2e-shell-overview.json     ← the starter dashboard
```

Everything is declarative and version-controlled. Grafana dashboards are re-applied from this directory on every restart. Dashboards edited through the UI persist in the named volume but the JSON file is the source of truth.

## Quickstart

```bash
cd deploy/monitoring

# Optional: override the default admin password
export GRAFANA_PASSWORD="$(openssl rand -hex 16)"

docker compose up -d

# Wait for health
docker compose ps

# Prometheus targets page — both jobs should read "UP"
curl -sS http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health}'

# Grafana: open http://127.0.0.1:3000 and log in as admin / <GRAFANA_PASSWORD>
# The "a2e-shell — overview" dashboard loads as the default home page.
```

## What the dashboard shows

One screen, eight panels:

| Panel | Signal | Why it matters |
|---|---|---|
| HTTP requests/sec by route | Traffic volume breakdown | Detects traffic shifts and hot paths |
| Exec latency (p50/p95/p99) | `a2e_exec_duration_ms_bucket` histogram | Captures pipeline overhead; regressions show up before /healthz does |
| Errors by code (5m) | `a2e_errors_total` counter by code | Every error code a client sees, charted — `INTERNAL` spikes here are the bugs you missed in test |
| Rate limit hits | `a2e_rate_limit_hits_total` by bucket | Distinguishes "client is misbehaving" from "app is slow" |
| Active sessions | `a2e_sessions_active` gauge | Capacity check |
| Exec success rate | ok-outcome `a2e_exec_total` rate | One-liner health signal |
| Process RSS | `process_resident_memory_bytes` | Memory leak detector |
| Event loop lag | `nodejs_eventloop_lag_seconds` | CPU pressure — sustained >50ms means saturation |

## Alerts (7 rules shipped)

Defined in `alert.rules.yml`, evaluated every 30s by Prometheus:

| Alert | Severity | Fires when | Sustained |
|---|---|---|---|
| `A2eShellDown` | critical | `/metrics` scrape fails | 1m |
| `A2eShellInternalErrorsFiring` | critical | any `code="INTERNAL"` rate > 0 | 2m |
| `A2eShellHighErrorRate` | warning | error/request ratio > 25% | 5m |
| `A2eShellP95LatencyHigh` | warning | p95 exec > 1000ms | 5m |
| `A2eShellEventLoopLagHigh` | warning | Node event-loop lag > 200ms | 3m |
| `A2eShellHighMemory` | warning | process RSS > 800 MiB | 10m |
| `A2eShellSessionsHigh` | warning | active sessions > 500 | 10m |
| `A2eShellRateLimitSustained` | warning | rate-limit rejections > 1/sec | 10m |

Critical alerts get a shorter `group_wait` (10s) + `repeat_interval` (30m) so they don't sit in aggregation windows behind warnings. Inhibit rules mute every a2e-shell alert when `A2eShellDown` is firing — the service being down is upstream of latency/error-rate warnings.

### Routing to a real receiver

`alertmanager.yml` ships with a **placeholder webhook** at `http://127.0.0.1:5001/a2e-alerts` — this intentionally fails closed so alerts stay visible in the Alertmanager UI (http://127.0.0.1:9093) until the operator plugs in a real endpoint. To push notifications to Discord / Slack / Telegram / email, replace the `webhook_configs.url` in `alertmanager.yml` and `docker compose restart alertmanager`. Examples for each common receiver are in the [Alertmanager docs](https://prometheus.io/docs/alerting/latest/notification_examples/).

Alerts are queryable even without a configured receiver:

```bash
curl -sS http://127.0.0.1:9093/api/v2/alerts | jq
```

### Verifying alerts fire

Quick end-to-end test:

```bash
# 1. Stop a2e-shell briefly to trigger A2eShellDown (1m for: window)
docker stop a2e-shell
sleep 80
curl -sS http://127.0.0.1:9093/api/v2/alerts | jq '.[] | select(.status.state=="active") | .labels.alertname'
# Expected: ["A2eShellDown"]
docker start a2e-shell
```

## Networking

Prometheus reaches `a2e-shell` via the docker0 gateway (`172.17.0.1:8090`), aliased as `host.docker.internal` inside the container via `extra_hosts`. This works without the `a2e-shell` container joining a new network — no restart of the main app is required to add observability.

If you add more services (mcp-serve-catalog `/metrics` when it gains one, reverse-proxy stats, etc.), extend `prometheus.yml` with additional `- job_name` entries.

## Exposing Grafana externally

Default binding is `127.0.0.1:3000` — local access only. To expose externally, add an nginx vhost that proxies to `127.0.0.1:3000` and handles TLS. Sample nginx block:

```nginx
server {
  server_name grafana.ardf.dev;
  listen 443 ssl http2;
  # ... cert + standard TLS config ...

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Until then, SSH port-forward:

```bash
ssh -L 3000:127.0.0.1:3000 root@<vps>
# then open http://localhost:3000 in your browser
```

## Retention & disk

Prometheus is configured with 30-day retention (`--storage.tsdb.retention.time=30d`). Daily disk usage is small for this workload (~5 MB/day at current traffic) — 30d ≈ 150 MB. Adjust the flag in `docker-compose.yml` if you want longer history or tighter disk.

## Upgrades

```bash
cd deploy/monitoring
docker compose pull
docker compose up -d
```

Grafana's named volume preserves the admin password, user customizations, and any dashboards edited through the UI (they live alongside the provisioned ones).

## Teardown

```bash
cd deploy/monitoring
docker compose down              # keeps volumes
docker compose down --volumes    # wipes all data
```
