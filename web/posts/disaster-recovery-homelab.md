---
title: Disaster Recovery in My Homelab: Rebuild from Scratch in 33 Minutes
date: 2026-11-22
readTime: 10
tags: homelab, kubernetes, disaster-recovery, infrastructure
summary: Why I refuse to back up etcd, how CloudNativePG restores databases from S3, and the real bugs caught during timed rebuild drills.
---

Most Kubernetes backup guides spend a lot of time talking about etcd snapshots. You take a snapshot of your control plane state, store it somewhere safe, and hope that if disaster strikes, you can restore that exact etcd database back onto a fresh machine.

I decided not to back up etcd at all. 

That is not an accident or a shortcut. Trying to nurse an old etcd database back to life on broken nodes is a recipe for weird bugs and configuration drift. Instead, I treat the entire cluster as completely disposable. 

All my cluster manifests live in Git. Secrets live in an external OpenBao vault. Database backups stream to S3 on MinIO. Bulk photos sit on TrueNAS with ZFS snapshots. 

If my Kubernetes cluster gets corrupted or both Proxmox servers die, I don't try to salvage the wreckage. I run `terraform apply` to build fresh VMs, install the CNI, hand off to ArgoCD, and let CloudNativePG restore the databases from S3. 

Here is how that disaster recovery strategy works in real life, and what happened when I timed myself doing it.

## Where the data actually lives

Before you can build a recovery plan, you have to be completely honest about where your data is stored. In my lab, anything permanent lives outside the cluster:

- Cluster manifests: Stored in Git and managed with ArgoCD.
- Terraform state: Saved on my TrueNAS storage.
- Postgres databases: Streamed continuously to S3 buckets on MinIO using Barman.
- Cluster secrets: Held in OpenBao on a separate VM outside Kubernetes, backed up by Proxmox Backup Server.
- Photos and family media: TrueNAS ZFS dataset backed up to off-site storage and Backblaze B2.

Notice what is missing from that list: pods, API server state, ConfigMaps, and etcd. Those are all temporary runtime objects. When the cluster goes down, they disappear, and when Terraform runs, they get rebuilt cleanly from code.

## Restoring databases with CloudNativePG

I run four separate PostgreSQL database clusters using CloudNativePG: `coroot-db`, `immich-db`, `authentik-db`, and `grafana-db`. 

All four clusters continuously ship their write-ahead logs (WAL) to MinIO over S3 with gzip compression. Scheduled full backups run overnight on staggered timers so they don't hammer the storage array all at once:

- `coroot-db`: 00:00 UTC
- `immich-db`: 00:10 UTC
- `authentik-db`: 00:20 UTC
- `grafana-db`: 01:00 UTC

### The init vs restore trap

This is the single most important operational trick in the entire database setup, and if you forget it during a rebuild, you will kick yourself.

Every database in my repo has two manifests:

`init-db.yaml` uses `bootstrap.initdb` to create a fresh, empty database.

`restore-db.yaml` uses `bootstrap.recovery` to pull WAL logs and base backups down from MinIO.

If you rebuild your cluster and let ArgoCD sync `init-db.yaml` first, CloudNativePG will spin up a brand new empty database, start accepting connections, and treat that blank database as the new baseline. Once that happens, you have to wipe the database and start over.

To recover properly, you have to swap `init-db.yaml` to `restore-db.yaml` in Git before the first ArgoCD sync runs. That way, the moment CloudNativePG boots, it sees the recovery instructions and pulls down the data from S3.

There is one more catch: you have to change the `serverName` field on recovery. CloudNativePG uses `serverName` as the S3 folder prefix for new WAL segments. If you reuse the old name, the recovering database will overwrite the backup files you are actively trying to restore from. I just append a suffix like `-restore-1` to keep them separate.

## The recovery order

You cannot just run commands randomly during a recovery. Almost every tool in the stack relies on something upstream being alive first:

1. Network and DNS: The physical network, local DNS, and Proxmox hosts have to be up.
2. TrueNAS: MinIO (for database backups) and NFS storage (for photos) must be reachable.
3. OpenBao: You must unseal the vault VM so External Secrets Operator can fetch credentials.
4. Terraform state: Verify the NAS share holding your Terraform state is accessible.
5. `terraform apply`: Builds the VMs, configures Talos Linux, bootstraps etcd, installs Cilium and Longhorn, and bootstraps ArgoCD.
6. ArgoCD sync: Sync waves pull down manifests in sequence, External Secrets populates passwords, and CloudNativePG restores the databases.

In Terraform, I have an ugly 300-second `time_sleep` right after installing Cilium. Cilium takes a minute or two to register its custom resource definitions, and without that hard sleep, Terraform rushes ahead and crashes trying to apply dependent resources. It is not pretty, but it works every single time.

## What the timed drills actually taught me

You can write down the prettiest recovery runbook in the world, but until you wipe your cluster and set a stopwatch, you are just guessing.

### Drill 1: October 2026 (Untimed)

This was my proof of concept. I manually deleted the VMs, ran Terraform, restored databases from MinIO, and proved that rebuilding from code was actually possible. I didn't time it because I had to pause and fix small config issues along the way, but it gave me confidence that the architecture worked.

### Drill 2: November 19, 2026 (70 minutes)

This was the first timed run. It started at 9:41 and finished at 10:51, clocking in at about 70 minutes. More importantly, it uncovered three real bugs:

First, the Talos image sitting on my Proxmox host was outdated. I had bumped the Talos version in Terraform earlier that week, but hadn't downloaded the matching custom factory image with the iSCSI storage modules to Proxmox. The VMs failed to boot on the first pass.

Second, the Helm repositories on my laptop were stale. Terraform pulled old chart definitions, which threw errors when trying to fetch specific package versions.

Third, the sync waves for External Secrets Operator were wrong. The operator and its custom resource definitions were in the same wave, so ArgoCD tried to create `ExternalSecret` resources before the API server recognized what an ExternalSecret was.

Every single one of these was a hidden bug that never showed up during day-to-day use. If I had waited for a real hardware failure to find them, I would have spent hours debugging in a panic.

### Drill 3: November 22, 2026 (33 minutes)

Three weeks later, with those three fixes committed to Git, I ran the exact same drill. It started at 17:10 and finished at 17:43. 

The entire cluster came back up cleanly in 33 minutes. The only manual thing I had to touch was clicking a single sync button on the monitoring stack. Going from 70 minutes down to 33 minutes came entirely from fixing the bugs surfaced in the previous drill.

## Being honest about what is not tested yet

I am happy with how fast the Kubernetes cluster recovers, but there are still gaps in my backup strategy that I haven't tested:

Off-site restore from Backblaze B2 has never been drilled. My TrueNAS replicates ZFS snapshots to an off-site server and to Backblaze B2. But I have never taken a clean TrueNAS box and pulled data back down from B2. That is still an assumption.

MinIO cloud backup needs verification. I need to double-check whether the TrueNAS zvol hosting MinIO is included in the off-site replication job, or if it is only sitting on local storage.

Restoring OpenBao from scratch has not been timed. The OpenBao VM is backed up by Proxmox Backup Server, but I haven't timed a full restore and unseal process from zero.

## The takeaway

An untested backup is just a wish. 

Running rebuild drills is uncomfortable because you know things are going to break. You will sit there watching error logs scroll by, wondering why a pod is crash looping or why a Helm chart won't download. 

That friction is the whole point. Every bug you find while sitting calmly at your desk on a weekend is a bug that won't ruin your life when a real drive fails. Build your cluster as code, test your restores, and don't be afraid to pull the plug.
