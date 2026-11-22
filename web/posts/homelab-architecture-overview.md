---
title: Homelab Architecture Overview — Talos Linux on Proxmox VE
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, talos, infrastructure
summary: A ground-up walkthrough of my homelab Kubernetes platform — Talos Linux running on Proxmox VE, bootstrapped with Terraform, operated with ArgoCD, and designed around the principle of rebuilding rather than repairing.
---

**TL;DR:** This is a production-grade homelab Kubernetes cluster running Talos Linux on two Proxmox VE hosts, fully bootstrapped with Terraform, and operated via GitOps with ArgoCD. It exists primarily as a learning platform for end-to-end platform engineering: infrastructure as code, secrets management, CNI internals, GitOps patterns, and disaster recovery. This post is the architecture index — every component has a dedicated deep-dive linked from here.

---

## Why I Built This

I built this homelab to learn platform engineering the way it actually works in production, not the way a tutorial presents it. That means dealing with real dependencies between components, real failure modes, and real trade-offs — not a managed Kubernetes service that abstracts the hard parts away.

The specific goals were:

- Understand how a Kubernetes cluster is actually assembled from scratch (CNI, kube-proxy replacement, control-plane bootstrapping)
- Practice **Infrastructure as Code** discipline end-to-end, from VM creation to application deployment
- Build and repeatedly drill a credible **disaster recovery** runbook
- Run real workloads (photos, identity, monitoring) so the cluster has stakes

This is not a "spin up a Kind cluster" project. Every layer — from the UEFI VM config in Terraform to the sync waves in ArgoCD — is a deliberate choice I can explain and defend.

---

## Physical Topology

The cluster runs on two physical Proxmox VE hosts and a lightweight QDevice for quorum.

| Host | Role | Notes |
|---|---|---|
| **kirk** | Primary Proxmox host | Runs 2 control planes + 1 worker |
| **picard** | Secondary Proxmox host | Runs 1 control plane + 1 worker |
| **QDevice** | Corosync quorum device | Also runs Uptime Kuma for external monitoring |

The two-host setup means I can tolerate a single host failure on the Proxmox layer. The QDevice prevents split-brain without requiring a third full host.

### Kubernetes Node Inventory

All five nodes are Talos Linux VMs (**Talos v1.14.6**, **Kubernetes v1.37.2**). The node inventory is driven by a `nodes.yaml` file — Terraform loops over it to create every VM, so adding a node is a one-line YAML change.

| Node | Role | vCPU | RAM | Disk | Host |
|---|---|---|---|---|---|
| talos-ctl-1 | Control plane | 2 | 5 GB | 50 GB | kirk |
| talos-ctl-2 | Control plane | 2 | 5 GB | 50 GB | kirk |
| talos-ctl-3 | Control plane | 2 | 5 GB | 50 GB | picard |
| talos-worker-1 | Worker | 6 | 16 GB | 200 GB | kirk |
| talos-worker-2 | Worker | 4 | 10 GB | 200 GB | picard |

Control planes are explicitly **not schedulable** (`allowSchedulingOnControlPlanes: false`). The control-plane API is exposed via a **Layer 2 VIP at 192.168.2.5**, so a control-plane failure doesn't require a DNS change — the VIP floats to a healthy node automatically.

All VMs use OVMF/UEFI firmware, q35 machine type, `virtio-scsi-single`, and a VirtIO NIC on a dedicated VLAN2 bridge.

---

## Logical Architecture

The stack is organised into three distinct layers, each responsible for a different concern:

### Layer 1 — Terraform Bootstrap

Terraform owns everything that must exist *before* GitOps can take over:

1. Create Proxmox VMs from the `nodes.yaml` inventory (providers: `bpg/proxmox`, `siderolabs/talos`)
2. Pull a custom Talos image from `factory.talos.dev` — the schematic includes extra kernel modules (`iscsi_tcp`, `nbd`, `rpcsec_gss_krb5`) required for Longhorn and NFS
3. Apply Talos machine configs (shared patch, control-plane patch, VIP patch, worker patch)
4. Bootstrap etcd, wait for the Kubernetes API to become healthy
5. Install **Cilium** via Helm — with a forced 300-second wait after installation because CRDs weren't reliably ready otherwise
6. Install **Longhorn** and **ArgoCD** via Helm
7. Apply the root ArgoCD `Application` manifest, handing control to GitOps
8. Inject the ArgoCD repo credentials and the OpenBao AppRole secret as Kubernetes Secrets

After step 8, Terraform steps back. Everything else is owned by Git.

### Layer 2 — GitOps (ArgoCD)

ArgoCD runs the **app-of-apps pattern**: a single root `Application` defines four child Applications — `infrastructure-staging`, `apps-staging`, `monitoring-staging`, and `apps-prod` (prepared but not yet deployed).

Sync policy is `automated`, with `prune=true` and `selfHeal=true`. If a resource drifts from Git, ArgoCD corrects it within minutes.

**Sync waves** enforce dependency order across the infrastructure layer:

| Wave | What deploys |
|---|---|
| -10 | Namespaces |
| -9 | CRDs |
| -8 | Operators (ESO, CNPG, Longhorn, Coroot) |
| -6 | ClusterSecretStore |
| -5 | ExternalSecrets (pull credentials from OpenBao) |
| 2 | CNPG database clusters, storage |
| 3 | Credential-sync Jobs |
| 5 | Applications (Immich, Authentik, etc.) |
| 10 | Post-deploy / validation |

Kustomize overlays (`base/` + `staging/` + `production/`) allow the same manifests to target different environments with minimal duplication.

### Layer 3 — Workloads

Workloads currently deployed:

- **Immich** — self-hosted photo library, NFS storage from TrueNAS, CNPG PostgreSQL backend
- **Authentik** — identity provider with CNPG backend
- **Personal websites / blog** — served via Cloudflare Tunnel and Gateway API HTTPRoutes
- **Minecraft** — game server with Longhorn persistent storage
- **Renovate** — CronJob running every 2 hours, opens PRs for Helm and container image updates

---

## Key Components

### Cilium — CNI and Load Balancer

Cilium runs in **full kube-proxy replacement mode** (`kubeProxyReplacement: true`), talking directly to the Talos local API (`localhost:7445`). **BPF masquerade** is enabled. L2 announcements handle LoadBalancer IPs in the `192.168.2.200–240` range, with the local gateway at `192.168.2.240`. Gateway API is enabled, which powers the Cloudflare Tunnel integration.

Hubble is enabled for flow visibility but is not yet actively used for policy generation — that's a known gap.

### ArgoCD — GitOps Controller

ArgoCD is the single source of truth for cluster state after bootstrap. The UI is reachable at `192.168.2.206`. Every manifest change goes through a Git PR; ArgoCD reconciles within seconds of merge.

### CloudNative-PG — Databases

Four PostgreSQL clusters (Immich, Authentik, Coroot, Grafana) each run as independent CNPG clusters with 2 instances and `podAntiAffinity=required` to spread across nodes. Storage is intentionally **`local-path`** (node-local SSDs) rather than Longhorn — CNPG already replicates at the application layer, so using Longhorn would double-replicate unnecessarily.

All databases ship WAL continuously to MinIO S3 with gzip compression. Full backups are taken on staggered schedules overnight. Ready-to-use restore manifests (`restore-db.yaml`) live in the repo for each cluster.

### OpenBao + External Secrets Operator — Secrets Management

**OpenBao** (an open-source Vault fork) runs on a dedicated VM outside the cluster, accessible at `https://bao.g-space.co.za/`. Secrets never touch Git. The ESO **ClusterSecretStore** uses Vault AppRole auth (the `roleId` is committed to the repo; `secret_id` is not). AppRole tokens have a 1-hour TTL, bound to the cluster node CIDR. ESO pulls secrets from `secret/data/staging/*` with a read-only policy.

OpenBao is backed up two ways: Proxmox Backup Server snapshots the whole VM, and a cron job takes Raft snapshots.

### Cloudflare Tunnel — Public Exposure

Public-facing services go through **Cloudflare Tunnel** (`cfgate`), managed by the `cfgate.io` operator using Gateway API `HTTPRoute` resources. Two `cloudflared` replicas run for redundancy. No inbound firewall ports are opened. DNS records are synced automatically from `HTTPRoute` annotations via a `CloudflareDNS` resource (zone: `g-space.co.za`).

### NetBird + Caddy — Private Access

Private services (Immich for friends and family) are accessed via **NetBird** WireGuard mesh. Caddy runs in an Alpine LXC container on Proxmox, in an HA pair with `keepalived` VRRP (VIP `192.168.70.244`, priorities 101/100). TLS certificates are issued via Cloudflare DNS-01 challenge. Internal DNS is handled by a Technitium DNS cluster.

---

## Design Philosophy

Four principles shaped every decision:

1. **Immutable OS.** Talos Linux has no SSH daemon, no package manager, no shell. Config is applied declaratively via API. Nodes are configured, not administered.

2. **Git as the source of truth.** If it isn't in Git, it doesn't exist. ArgoCD's `selfHeal=true` enforces this — manual `kubectl apply` changes are reverted automatically.

3. **Durable state lives outside the cluster.** Databases back up to S3 (MinIO). Secrets live in OpenBao. Talos configs and Kubernetes manifests live in Git. etcd is *intentionally not backed up* — if etcd is gone, the cluster is rebuilt from code and data restored from S3.

4. **Rebuild over repair.** The disaster recovery posture is: wipe everything, run `terraform apply`, let ArgoCD reconcile. Drills have been run three times:
   - **October 2026** — untimed first run, identified gaps
   - **November 19, 2026** — ~70 minutes, found and fixed the ESO CRD sync wave bug, stale Talos image, and stale Helm repos
   - **November 22, 2026** — ~33 minutes, clean except for a manual monitoring sync

---

## Known Limitations

I'd rather document these than pretend they don't exist:

- **Terraform state is unencrypted on the NAS.** It contains kubeconfig, Talos certs, and bootstrap secrets. This is a risk; the fix is to migrate to an encrypted remote backend.
- **OpenBao is configured by hand.** Policies, auth methods, and mounts were set up manually. It should be codified with Terraform/OpenTofu.
- **AppRole `secret_id_ttl=0` (never expires).** The AppRole secret ID doesn't rotate. The plan is to bind it with a TTL and automate rotation.
- **No NetworkPolicy or CiliumNetworkPolicy defined.** All pods can reach all pods. Hubble is enabled but unused.
- **No in-cluster AlertManager delivery.** Alerting runs through Uptime Kuma on the QDevice and delivers via Discord webhook. Prometheus AlertManager is deployed but not wired to a delivery channel.
- **`apps-prod` overlay exists but is not deployed.** The production environment is prepared but not running.
- **Off-site NAS restore never tested.** The backup path exists; the restore path has not been drilled end-to-end.
- **MinIO cloud replication coverage unconfirmed.** It's unclear whether the MinIO zvol is included in cloud replication.
- **Worker nodes are asymmetric.** `talos-worker-1` has 6 vCPU / 16 GB; `talos-worker-2` has 4 vCPU / 10 GB. Scheduling is not perfectly balanced.

---

## What's Coming

This post is the index. Each component listed above has (or will have) a dedicated post covering implementation details, trade-offs, and lessons learned:

- Terraform bootstrap deep dive
- Cilium configuration and L2 announcements
- Secrets management with OpenBao and ESO
- CloudNative-PG: multi-cluster PostgreSQL with WAL archiving
- Disaster recovery: drills, runbooks, and what broke
- Cloudflare Tunnel + Gateway API for zero-inbound-port public exposure
- Monitoring stack: kube-prometheus-stack, Coroot, and Uptime Kuma

If you're a hiring manager or engineer evaluating this: the repo is the artifact. The decisions are documented, the trade-offs are acknowledged, and the disaster recovery has been drilled — not just planned.
