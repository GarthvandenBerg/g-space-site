---
title: Disaster Recovery in a Homelab: Backup Strategy, Restore Procedures, and Lessons from Real Rebuild Drills
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, disaster-recovery, infrastructure
summary: How I approach disaster recovery for a five-node Talos Linux cluster — rebuild from code, restore only durable data — including two timed rebuild drills that cut recovery time from 70 minutes to 33 minutes.
---

**TL;DR:** My homelab DR philosophy is simple: the cluster itself is disposable. Everything that matters lives outside it — manifests in Git, database backups in S3, secrets in OpenBao, photos on ZFS. When something breaks badly enough, I `terraform apply` and let ArgoCD do the rest. This post documents where state lives, how each piece is backed up, the exact restore order, and what two timed drills taught me.

---

## The Philosophy: Rebuild, Don't Rescue

Traditional DR thinking for Kubernetes often starts with etcd snapshots — back up the control plane state, restore it in an emergency. I deliberately chose the opposite approach.

**etcd is not backed up.** Not because I forgot, but because it's the wrong thing to protect. If etcd is the source of truth, you have a cluster-shaped dependency that's hard to restore correctly and easy to get wrong. Instead, **Git is the source of truth for cluster state**, and **S3-compatible object storage is the source of truth for data**. The cluster is a runtime artifact of those two things.

This means a full rebuild — from bare Proxmox VMs to running workloads — is a *tested, exercised path*, not a theoretical one. That distinction matters enormously.

---

## Where State Actually Lives

Before you can design a recovery procedure, you have to be honest about where every piece of durable state lives. Here's mine:

| State | Location | Backup mechanism |
|---|---|---|
| Cluster manifests | Git (ArgoCD app-of-apps) | Git history + remote |
| Terraform state | NAS (unencrypted — documented limitation) | NAS itself |
| CNPG PostgreSQL databases | MinIO on TrueNAS (S3, WAL archiving) | Barman + ScheduledBackup CRs |
| Secrets | OpenBao VM (outside cluster) | Proxmox Backup Server + Raft snapshots |
| Immich photos | TrueNAS ZFS dataset (NFS) | ZFS snapshots + off-site + Backblaze B2 |

Notice what's *not* in that table: the Kubernetes API server, running pods, ConfigMaps derived from Git, anything ephemeral. Those are all reconstructed on rebuild. The goal is to keep the "durable" list as short and well-understood as possible.

---

## Database Backups: CNPG + Barman + WAL Archiving

The cluster runs four **CloudNative-PG** clusters — `coroot-db`, `immich-db`, `authentik-db`, and `grafana-db` — all in the `database-system` namespace. Each has two instances with `podAntiAffinity: required` so they spread across nodes automatically.

Backups flow through **Barman** to **MinIO** (hosted on TrueNAS), configured as an S3-compatible target (`s3://database-backup/<db-name>`). WAL archiving runs continuously with **gzip compression**. Scheduled full backups are staggered to avoid simultaneous load:

```
coroot-db:    00:00 UTC
immich-db:    00:10 UTC
authentik-db: 00:20 UTC  (immediate: true)
grafana-db:   01:00 UTC  (immediate: true)
```

`immediate: true` on the authentik and grafana backups means the first backup runs at deploy time rather than waiting for the next scheduled window — useful after a fresh cluster build.

### The Init/Restore Manifest Pattern

This is the most operationally important detail in the whole database setup, and the one most likely to bite you if you forget it.

Each database has **two manifests**:

- `init-db.yaml` — uses `bootstrap.initdb`, creates a fresh empty database
- `restore-db.yaml` — uses `bootstrap.recovery` with `externalClusters` pointing at the S3 backup path

**The restore manifest must be committed to Git *before* the first ArgoCD sync after a rebuild.** If ArgoCD reconciles with the init manifest first, CNPG creates an empty database, starts accepting connections, and that empty state becomes the new baseline. Recovery from that point means wiping and starting over.

The workflow on a full rebuild:
1. Before running `terraform apply`, swap `init-db.yaml` → `restore-db.yaml` for each DB in Git and push.
2. ArgoCD syncs and CNPG sees `bootstrap.recovery` on first contact — it pulls WAL and base backups from MinIO.
3. After recovery is confirmed, swap back to `init-db.yaml` for future clean installs.

There's one more subtlety: **the `serverName` field must be changed on recovery**. CNPG uses `serverName` as the S3 path prefix for new WAL segments. If you reuse the old name, the recovering cluster will overwrite the backup you're trying to restore from. The convention here is to append a suffix like `-restore-1` and increment it on each drill.

A ready-to-use `grafana-db.yaml.restore` already exists in the repo for exactly this reason.

---

## Secrets: OpenBao Outside the Cluster

**OpenBao** runs as a dedicated VM outside the Kubernetes cluster, accessed at `https://bao.g-space.co.za/`. Keeping it external is intentional — the cluster needs secrets to start, so the secret store can't depend on the cluster being up.

In-cluster workloads access OpenBao via **External Secrets Operator** using AppRole auth. The ESO `ClusterSecretStore` uses the Vault provider (OpenBao is API-compatible). Secrets are read from `secret/data/staging/*` under a read-only policy.

OpenBao is backed up two ways:
- **Proxmox Backup Server**: whole-VM backup on a schedule
- **Cron Raft snapshots**: periodic `vault operator raft snapshot save` exported to a known location

One documented limitation: **OpenBao was configured by hand**, not with Terraform or OpenTofu. That means the restore procedure for OpenBao itself is less automated than everything else. The restore time for OpenBao has not been drilled end-to-end — a known gap.

---

## Recovery Order and Why It Matters

Order matters because almost everything has an upstream dependency. Try to bring up ArgoCD before OpenBao is unsealed, and ESO will fail to fetch secrets. Try to restore databases before MinIO is reachable, and CNPG's recovery controller will time out.

The practiced recovery order:

1. **Network, DNS, Proxmox** — foundation layer; nothing else works without it
2. **TrueNAS** — MinIO (S3 for database backups) and NFS (Immich photos) live here
3. **OpenBao** — unseal it; ESO will need it before most apps can start
4. **Terraform state** — confirm NAS is accessible and state file is intact
5. **`terraform apply`** — rebuilds VMs, applies Talos configs, bootstraps etcd, installs Cilium + Longhorn + ArgoCD, applies `root-app.yaml`
6. **ArgoCD reconciles** — sync waves enforce dependency order the rest of the way

The Terraform bootstrap itself is fully scripted and sequenced. One noteworthy detail: a **300-second `time_sleep`** was added after Cilium installation because CRDs were not reliably available in time for the next steps. It's inelegant, but it's reliable — the alternative was intermittent failures that were harder to diagnose than a fixed wait.

ArgoCD sync waves handle application-layer ordering:

```
-10: namespaces
 -9: CRDs
 -8: operators
 -6: ClusterSecretStore
 -5: ExternalSecrets
  2: CNPG clusters + storage
  3: credential-sync Jobs
  5: applications
 10: post-deploy / validation
```

---

## Drill Results: Actual Numbers

Planning a recovery procedure is not the same as having one. The only way to know if your DR works is to run it.

### October 2026 — First Full Rebuild (Untimed)

Goal: prove end-to-end rebuild is possible. Databases were restored from S3. No timing recorded — the goal was just to validate the path, not optimize it. It worked, with some manual intervention.

### November 19, 2026 — Second Drill: 9:41 → 10:51 (~70 minutes)

First timed drill. Three bugs surfaced:

- **Stale Talos image on Proxmox host** — the custom Talos factory image (with `iscsi_tcp`, `nbd`, and `rpcsec_gss_krb5` modules for Longhorn/NFS) had not been updated on the host after a Talos version bump. First boot failed.
- **Helm repos not updated** — Terraform references specific chart versions; repos on the bootstrap machine were stale and chart pulls failed.
- **ESO CRD sync wave wrong** — External Secrets Operator CRDs were not installed before the operator tried to reconcile, causing a sync failure. Fixed by moving CRD installation to wave `-9` and the operator to wave `-8`.

All three were real bugs that would have caused a failed recovery in a genuine incident. Finding them in a drill is exactly the point.

### November 22, 2026 — Third Drill: 17:10 → 17:43 (~33 minutes)

Same procedure, bugs from the previous drill fixed. Clean rebuild. The only manual step needed was triggering the monitoring stack sync — not a blocker, but noted for the next run.

**70 minutes → 33 minutes** between two drills, three weeks apart.

---

## Known Gaps

Honesty about what hasn't been tested is as important as the parts that work:

- **Off-site NAS restore is untested.** ZFS snapshots replicate off-site and to Backblaze B2, but pulling from B2 back to a fresh TrueNAS has never been drilled. It's an assumption, not a known-good path.
- **MinIO zvol cloud replication coverage is unconfirmed.** The database backup target (MinIO on TrueNAS) may or may not be included in cloud replication — this needs verification.
- **OpenBao restore has not been timed.** The VM backup exists, but walking through an actual restore of OpenBao from PBS and re-unsealing it has not been drilled as a standalone procedure.

---

## Lessons

**Untested backups are assumptions, not backups.** The October drill turned a theoretical design into a proven one. The November drills turned a proven design into a *fast* one.

**Drill logs are an artifact worth keeping.** Timestamps, error messages, and the sequence of what broke tell you exactly where your runbook is wrong. Without them, you're fixing the same bugs twice.

**Dependency ordering is the hardest part of recovery.** It's not obvious until something fails that ESO needs CRDs, that CRDs need the operator, and that the operator needs the namespace. Sync waves make this explicit and machine-enforced — not dependent on whoever is running the drill remembering the order.

**Every drill found something new.** The first drill validated the path. The second found three real bugs. The third ran clean. The pattern suggests one more drill will reveal whatever the third one missed — probably something in the OpenBao or off-site restore path.

The goal isn't a perfect DR plan on paper. It's a DR plan that gets shorter and more reliable every time it's exercised.
