---
title: "Monitoring My Homelab: Prometheus, Grafana on Postgres, and Coroot"
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, observability, infrastructure
summary: Why I put Grafana on PostgreSQL instead of SQLite, using Coroot eBPF to map traffic, and keeping Uptime Kuma outside the cluster.
---

When you set up monitoring in Kubernetes, the standard advice is to install `kube-prometheus-stack` from a Helm chart, open the Grafana dashboard, and admire all the graphs. 

If you are just playing around, that default setup is fine. But once you start running real workloads and testing disaster recovery, the default monitoring stack shows its cracks:

Grafana defaults to using an SQLite database saved on a single container volume. If your node crashes or you wipe your cluster, your custom dashboards and datasources vanish unless you manually backed up that specific volume.

Prometheus comes pre-configured to scrape components like kube-proxy and kube-scheduler. If you run a modern immutable OS like Talos with Cilium, those components don't exist in the traditional way, and your alert inbox gets spammed with `TargetDown` errors.

If your monitoring stack runs entirely inside Kubernetes, and your cluster crashes, how do you know it died? You don't, because your monitoring died with it.

Here is how I set up observability on my Talos cluster so it actually survives rebuilds, gives clear visibility into network traffic, and alerts me from the outside when things go wrong.

## Prometheus tuning for Talos and Cilium

Prometheus runs with 60-day metric retention capped at 45 GiB, backed by a 50 GiB Longhorn volume. It gets an internal load balancer IP at `192.168.2.231` announced over Layer 2 ARP by Cilium.

The most important tweak in the `kube-prometheus-stack` values was disabling scrape targets that don't make sense on my cluster:

```yaml
kubeProxy:
  enabled: false
kubeScheduler:
  enabled: false
kubeControllerManager:
  enabled: false
```

Because my cluster runs Talos Linux with Cilium replacing kube-proxy via eBPF, there is literally no kube-proxy process running on the nodes. Talos also manages the scheduler and controller-manager internally without exposing standard metrics ports. 

If you leave those targets enabled, Alertmanager goes crazy firing alerts for endpoints that will never exist. Turning them off keeps your alert feed clean and focused on actual workloads.

## Putting Grafana on PostgreSQL

By default, Grafana stores all its settings, users, and dashboards in an SQLite file on a local persistent volume. 

I didn't want my dashboards tied to a fragile local disk file. Instead, I pointed Grafana at a dedicated PostgreSQL database managed by CloudNativePG (`grafana-db`):

```ini
[database]
type = postgres
host = grafana-db-rw.database-system.svc:5432
name = grafana
```

This database runs two instances across my worker nodes, streams write-ahead logs to S3 on MinIO, and has an automated restore manifest in Git.

This decision paid off immediately during my disaster recovery drills. When I wiped the cluster and brought it back up, Grafana connected straight to the restored Postgres database. All my dashboards, datasources, and preferences appeared instantly without needing any manual re-configuration.

## Coroot: automatic service mapping with eBPF

To understand what is happening between my microservices, I run Coroot alongside Prometheus. Coroot runs via the Coroot Operator and is backed by its own Postgres database (`coroot-db`).

Instead of needing code changes or sidecar proxies injected into every pod, Coroot uses eBPF in the Linux kernel to watch network traffic. 

It automatically builds a visual map of service-to-service communication, tracks network latency, and flags error rates. 

This was a lifesaver before writing network policies. Instead of reading through application documentation and trying to guess which pods need to talk to which ports, I can just open Coroot and see real network traffic flowing between services in real time.

## Outside monitoring with Uptime Kuma

If your monitoring stack runs inside Kubernetes, it cannot alert you when the cluster itself is down.

To catch host and network failures, I run Uptime Kuma completely outside Kubernetes on the Proxmox QDevice VM. 

Uptime Kuma monitors the physical Proxmox servers (`kirk` and `picard`), key standalone VMs like OpenBao and TrueNAS, and the full end-to-end user path for our photo library (DNS resolution to Caddy LXC to the Immich web interface). 

If any link in that chain drops, Uptime Kuma sends an immediate notification to a Discord webhook on my phone. Because the QDevice runs outside the Kubernetes cluster, it stays alive and alerts me even if every single Kubernetes node is down.

## What is still missing

There are still a few things I need to wire up to make this observability stack complete:

In-cluster Alertmanager is not connected to Discord yet. While Uptime Kuma handles external downtime alerts, Prometheus Alertmanager doesn't have an active notification receiver configured for internal pod warnings. 

There is no distributed tracing. I don't run Jaeger or Tempo right now. For the small set of self-hosted apps I run, metrics and logs give me enough information without needing the overhead of a full tracing pipeline.

Cilium Hubble is running but underused. Coroot gives me an easy service map UI out of the box, so I haven't taken the time to set up Hubble Relay or write complex flow queries.

## The big takeaway

Observability in a homelab isn't just about pretty graphs you look at once and forget. 

Backing tools like Grafana with a real database keeps your setup reproducible when you test disaster recovery. 

Turning off scrape targets for components you don't run keeps your alerts useful. 

And putting an external monitor like Uptime Kuma on a separate host guarantees that when your cluster inevitably breaks, you actually hear about it.
