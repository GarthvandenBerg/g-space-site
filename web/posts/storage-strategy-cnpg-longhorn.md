---
title: Storage Strategy — Matching Storage Class to Workload Failure Model
date: 2026-11-22
readTime: 7
tags: homelab, kubernetes, storage, infrastructure
summary: Not all storage classes are equal — the right choice depends on how your workload already handles failure. Here's how local-path, Longhorn, and NFS are used across this Talos Linux homelab cluster, and why.
---

**TL;DR:** Storage class selection is a *failure-domain decision*, not just a capacity decision. This post walks through the three storage backends in use — `local-path`, Longhorn, and NFS from TrueNAS — explains why each workload lands where it does, and covers the trade-offs that come with each choice.

## The Core Question: What Breaks When a Node Dies?

Before picking a storage class, ask one question: *what happens to this workload's data when the node it's running on becomes unavailable?*

The answer determines everything. A workload that replicates its own data at the application layer has fundamentally different storage needs than one that relies on the infrastructure to keep data available. Treating every PVC the same leads to either wasted overhead (double-replication) or silent single points of failure.

This cluster runs on **5 Talos Linux nodes** (3 control planes + 2 workers) across 2 Proxmox VE hosts. Control planes are not schedulable, so workloads land on the 2 worker nodes. With only 2 workers, every storage and scheduling decision has to be deliberate.

## Three Storage Classes, Three Failure Models

### 1. `local-path` — Node-Local, Fast, Intentionally Pinned

`local-path` provisioner writes data directly to the node's local disk. No replication, no network I/O, no storage controller overhead. It's the fastest option and also the most opinionated: the data is permanently tied to one node.

**This is the storage class for all CloudNative-PG (CNPG) databases.**

That choice is deliberate. CNPG already handles its own replication at the application layer:

- Each database cluster runs **2 instances** (primary + replica).
- `podAntiAffinity: required` ensures the two pods land on *different* worker nodes.
- If the node hosting the primary dies, CNPG promotes the replica to primary — no volume migration needed.

Given that, adding Longhorn's block-level replication would mean **replication-on-replication**: data written once at the application layer, written again by the storage layer. That adds write latency, extra disk I/O, and CPU overhead for no additional durability benefit. CNPG's replica is already on a different node with its own independent local-path volume.

The trade-off is explicit: each instance's data is pinned to one node's disk. If that disk fails and there is no replica to promote, data loss is possible. The mitigation is **Barman/WAL backups to MinIO S3** (`s3://database-backup/<db>`), with scheduled backups staggered across the night and WAL archiving with gzip compression running continuously.

```yaml
# CNPG cluster — storage and anti-affinity
storage:
  size: 10Gi
  storageClass: local-path

affinity:
  podAntiAffinityType: required
```

Databases in use: `coroot-db`, `immich-db`, `authentik-db`, and `grafana-db` — all in the `database-system` namespace, all on `local-path`.

### 2. Longhorn — Replicated Block Storage, Waiting for the Right Workload

**Longhorn** provides replicated block storage across the worker nodes. It's installed, configured, and backing one workload in production: the **Minecraft server's persistent world data**.

Configuration:

- **2 replicas** (constrained by having 2 worker nodes — that's the maximum meaningful replica count)
- **Backup target:** `s3://pvc-backup/longhorn/`
- **Daily RecurringJob** at 02:00 for the `app-data` group
- `storageOverProvisioningPercentage: 500`
- `dataLocality: best-effort`
- `allowSchedulingOnControlPlaneNodes: false`

Longhorn is the right choice when the application *doesn't* replicate its own data and you need a PVC to survive a node failure without manual intervention. The Minecraft world is a good fit: it's a single-instance workload with no built-in replication, and the world data needs to follow the pod if it reschedules to the other worker.

**Why Longhorn was removed from the Terraform bootstrap:**

Early in the cluster build, Longhorn was provisioned directly by Terraform alongside Cilium and ArgoCD. This ran into a CRD/controller race condition: Longhorn's CRDs weren't reliably registered before the controller tried to use them during initial provisioning. The fix was to remove Longhorn from Terraform entirely and let **ArgoCD manage it** after the cluster is stable. Terraform now bootstraps Cilium, waits (with a `time_sleep` of 300 seconds for CRD readiness), installs ArgoCD, and applies the root app — Longhorn comes up through GitOps from there.

This is a pattern worth remembering: **Helm + Terraform is not always the right tool for CRD-heavy operators**. GitOps with sync waves gives you explicit ordering guarantees that Terraform's dependency graph can't easily replicate for in-cluster resources.

Prometheus also uses a **50 Gi Longhorn PVC** for its 60-day metric retention — this is an observability workload where the data is regenerated from scraping anyway, so Longhorn's replication provides availability without meaningful durability requirements.

### 3. NFS from TrueNAS — High Capacity, ZFS-Backed, Single Point of Failure

**Immich** (self-hosted photo library) stores photos on an NFS share exported from a **TrueNAS SCALE** host running a ZFS pool. This gives large capacity and takes advantage of ZFS's native snapshot capability, with off-site replication to Backblaze B2.

Immich's metadata and database run on CNPG (`immich-db` on `local-path`). The photo *files* live on NFS because they're large, write-once, and need to outlive any single Kubernetes node or pod restart.

**The trade-off:** TrueNAS is a **single point of failure** for Immich's photo data. If the TrueNAS host is unavailable, Immich degrades — the application pod can run, but it can't serve or ingest photos. The mitigation is ZFS snapshots plus B2 replication, but recovery from a full TrueNAS loss would require restoring from B2 and is a path that hasn't been fully drilled yet.

This is a known and accepted limitation. For a homelab, the operational simplicity of a single NAS with ZFS outweighs the complexity of running distributed object storage for unstructured photo data.

## Storage Class Decision Summary

| Storage Class | Workloads | Why |
|---|---|---||
| `local-path` | CNPG databases | App-layer replication; highest IOPS; Barman S3 backups |
| Longhorn | Minecraft world, Prometheus metrics | No app-layer replication; needs pod-portable PVC |
| NFS (TrueNAS) | Immich photos | Large unstructured files; ZFS snapshots + B2 offsite |

## What I Learned

**Storage class is a failure-domain decision.** The question isn't "which storage class performs best" or "which one has the most features" — it's "how does this workload already handle failure, and what does it need from storage to maintain its guarantees?"

For CNPG, local-path is the correct choice *because* CNPG is opinionated about replication. Adding Longhorn would be cargo-culting "distributed storage" onto a workload that already manages its own distribution. The result would be higher latency and more complexity for the same failure characteristics.

For single-instance workloads like Minecraft, Longhorn earns its overhead: without it, a node failure means waiting for manual data recovery before the pod can restart elsewhere.

For large unstructured files tied to a specific host's storage capacity, NFS is pragmatic — with eyes open to the single-point-of-failure trade-off.

The Longhorn CRD race condition during Terraform bootstrap was a concrete lesson in the **limits of Terraform for in-cluster lifecycle management**. Terraform is excellent at infrastructure provisioning; it's not a Kubernetes controller. Sync waves in ArgoCD handle ordering concerns that Terraform simply wasn't designed to express.
