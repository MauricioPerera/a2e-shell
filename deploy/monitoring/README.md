# a2e-shell — observability stack

Prometheus + Grafana sidecar for scraping `a2e-shell`'s `/metrics` endpoint and visualizing traffic / latency / errors / rate limits / process health.

## What's here

```
deploy/monitoring/
├── docker-compose.yml                  ← prometheus + grafana services
├── prometheus.yml                      ← scrape config (one target: a2e-shell)
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
