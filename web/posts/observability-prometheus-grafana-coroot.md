---
title: Observability Stack — kube-prometheus-stack, Grafana on PostgreSQL, and Coroot for eBPF Service Mapping
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, observability, infrastructure
summary: How I set up a production-grade observability stack on my Talos homelab — Prometheus with long-term retention, Grafana backed by CNPG PostgreSQL, Coroot for eBPF service maps, and Uptime Kuma for external user-path monitoring.
---

**TL;DR:** My Kubernetes observability stack runs `kube-prometheus-stack` for metrics, Grafana backed by a CloudNative-PG PostgreSQL database so dashboards survive full cluster rebuilds, and Coroot for eBPF-based service mapping and basic SLO views. External monitoring is handled by Uptime Kuma on the QDevice, alerting via Discord. Everything is deployed via ArgoCD's `monitoring-staging` overlay. This post covers what I built, why I made certain trade-offs, and what I learned from two cluster rebuilds in November 2026.

---

## Stack Overview

The observability layer sits in its own ArgoCD `Application` — `monitoring-staging` — which is one of four child apps in the app-of-apps pattern. The components are:

- **kube-prometheus-stack** — Prometheus Operator, Prometheus, Alertmanager, kube-state-metrics, node-exporter
- **Grafana** — backed by a CNPG PostgreSQL database (`grafana-db`) instead of SQLite on a PVC
- **Coroot** — eBPF-based continuous profiling and service map, deployed via the Coroot Operator, backed by its own CNPG database (`coroot-db`)
- **Uptime Kuma** — external monitoring running on the Proxmox QDevice (outside the cluster entirely)

All in-cluster components are deployed via Kustomize overlays with ArgoCD's `ServerSideApply=true` and `selfHeal=true`. Sync waves enforce dependency order: CRDs arrive before operators, operators before the applications that consume their APIs.

---

## Prometheus: Configuration and Retention

Prometheus runs with **60-day retention** and a **45 GiB retention size cap**, backed by a **50 Gi Longhorn PVC**. It's exposed internally via a `LoadBalancer` service at `192.168.2.231` — Cilium's L2 announcement policy handles ARP for that IP on `eth0`.

Longhorn was chosen for the Prometheus PVC because it provides replicated block storage, meaning the volume survives a node failure without losing metric history. CNPG databases, by contrast, use `local-path` because CNPG already replicates at the application layer — no need to pay the cost of double-replication.

### kube-proxy Metrics Disabled

Three `kube-prometheus-stack` scrape targets are disabled in the Helm values:

```yaml
kubeProxy:
  enabled: false
kubeScheduler:
  enabled: false
kubeControllerManager:
  enabled: false
```

**Why:** This cluster runs **Talos Linux** with **Cilium in full kube-proxy replacement mode** (`kubeProxyReplacement: true`). There is no kube-proxy process, and the Talos-managed scheduler and controller-manager don't expose the metrics endpoints that kube-prometheus-stack would try to scrape. Leaving these targets enabled fills Alertmanager with `TargetDown` alerts for endpoints that will never exist. Disabling them is the correct configuration for a Cilium-on-Talos cluster, not a gap.

---

## Grafana: Backed by PostgreSQL for Real Persistence

Grafana is exposed at `192.168.2.230` via LoadBalancer. The admin credentials are pulled from **OpenBao** via the External Secrets Operator — no hardcoded passwords in Git.

The more interesting decision is the **database backend**. By default, Grafana uses SQLite on a local PVC. That means dashboards, data source configurations, and user preferences are tied to a persistent volume — which works fine until you rebuild the cluster and need to decide whether to try to rehydrate that PVC from a backup or just start over.

Instead, Grafana's `grafana.ini` is configured to use **PostgreSQL** via the `grafana-db` CNPG cluster:

```ini
[database]
type = postgres
host = grafana-db-rw.database-system.svc:5432
name = grafana
```

The `grafana-db` CNPG cluster runs 2 instances with `podAntiAffinity: required` (spread across nodes), backs up WAL to MinIO S3 at `s3://database-backup/grafana-db` on a schedule (01:00 UTC, `immediate: true`), and has a ready-made restore manifest (`grafana-db.yaml.restore`) committed to the repo.

**The payoff was real.** During the November 2026 cluster rebuilds, Grafana came back with all dashboards and data source configurations intact. The restore path is:
1. Commit `grafana-db.yaml.restore` before the first ArgoCD sync (the CNPG recovery bootstrap must exist before the cluster is created)
2. Change `serverName` in the restore manifest to avoid overwriting the existing backup path
3. Let ArgoCD reconcile — Grafana connects to the restored database and everything is there

This is a concrete example of **infrastructure as code enabling disaster recovery**, not just deployment automation.

---

## Coroot: eBPF Service Mapping

**Coroot** is deployed via the Coroot Operator and backed by its own CNPG database (`coroot-db`, same pattern as `grafana-db`). It uses **eBPF** to instrument service-to-service traffic without requiring sidecars or application changes — the kernel does the work.

What Coroot provides in this cluster:

- **Service map** — a live graph of which services are calling which, with latency and error rate. This was useful before writing any network policies: I could see the actual traffic patterns rather than guessing from application documentation.
- **Basic SLO views** — Coroot surfaces availability and latency data per service out of the box.
- **Continuous profiling** — eBPF-based CPU and memory profiling per process, without code instrumentation.

**Why Coroot instead of just using Hubble?** Cilium's Hubble is enabled on this cluster, but it's not currently wired up for flow visibility or used for policy generation. Coroot gives a more immediately useful service map UI without requiring Hubble Relay configuration or writing Hubble CLI queries. That said, Coroot and Hubble are complementary rather than mutually exclusive — this is a current convenience, not a permanent architectural decision.

---

## External Monitoring: Uptime Kuma

**Uptime Kuma** runs on the **QDevice** — the small VM that provides Proxmox cluster quorum. This is intentional: if the Kubernetes cluster is down, in-cluster monitoring is also down. External monitoring needs to be independent.

Uptime Kuma monitors:

- **Proxmox nodes** (`kirk` and `picard`)
- **Key VMs** (OpenBao, TrueNAS, etc.)
- **Full user path for Immich** — DNS resolution → Caddy LXC → Immich pod — which covers the entire stack a user would traverse

Alerts go to a **Discord webhook**. It's simple, it works, and it's outside the blast radius of a cluster failure.

---

## Limitations and Known Gaps

Being honest about what's missing is part of operating a system responsibly:

**No in-cluster alert delivery.** Alertmanager is running (part of kube-prometheus-stack), but there's no configured receiver for routing alerts to Discord, PagerDuty, or anything else from inside the cluster. Uptime Kuma handles the only active alert path today. This is the next thing to wire up.

**No distributed tracing.** No Tempo, no Jaeger, no OpenTelemetry Collector. Metrics and logs only. For a homelab running personal workloads, this is acceptable — but it's a gap worth naming.

**No formal SLO definitions.** Coroot surfaces latency and availability data, but there are no Prometheus recording rules or alerting rules defining SLOs with error budgets. The data is there; the structure isn't.

**Hubble enabled but unused.** Cilium's Hubble is configured, but Hubble Relay and the Hubble UI aren't set up. No NetworkPolicy or CiliumNetworkPolicy has been written yet. This is documented as a known limitation — Coroot fills the service-map gap in the interim.

---

## What I Learned

**Back Grafana with a real database from day one.** The SQLite-on-PVC default is fine for experimentation but terrible for a cluster you plan to rebuild. CNPG with WAL archiving to S3 means Grafana configuration is as durable as any other stateful workload. The 10 minutes spent setting this up initially saved significant pain during the November rebuilds.

**eBPF tooling like Coroot is genuinely useful for understanding a cluster before you lock it down.** I used Coroot's service map to understand which services were actually talking to each other before attempting to write any network policies. It's much easier to write accurate CiliumNetworkPolicy rules when you can see real traffic rather than relying solely on documentation and guesswork.

**Naming what you haven't done is part of good platform engineering.** The limitation list above isn't a confession — it's a prioritized backlog. In-cluster alertmanager delivery and SLO definitions are next. Distributed tracing will come when there's a workload that would actually benefit from it.

---

## Quick Reference

| Component | Detail |
|---|---|
| Prometheus retention | 60 days / 45 GiB |
| Prometheus PVC | 50 Gi Longhorn |
| Prometheus LB | `192.168.2.231` |
| Grafana LB | `192.168.2.230` |
| Grafana DB | CNPG `grafana-db`, `local-path`, 10 Gi |
| Coroot DB | CNPG `coroot-db`, `local-path`, 10 Gi |
| DB backups | WAL + ScheduledBackup → MinIO S3 |
| External monitoring | Uptime Kuma on QDevice → Discord |
| Deployment | ArgoCD `monitoring-staging` overlay |
