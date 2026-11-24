---
title: Kubernetes Storage in My Homelab: Local-Path, Longhorn, and NFS
date: 2026-11-22
readTime: 8
tags: homelab, kubernetes, storage, infrastructure
summary: Why putting your databases on distributed block storage is usually a mistake, and how I split storage across local SSDs, Longhorn, and TrueNAS.
---

When people first get into Kubernetes storage, the instinct is usually to find a distributed storage operator like Longhorn or Ceph, deploy it across every node, and point every single PersistentVolumeClaim at it. 

It sounds great in theory: every volume is replicated across the network, and if a node explodes, your pod can just start up on another node with its data intact.

In practice, blindly putting everything on distributed storage is an easy way to kill your disk performance and waste system resources. Different applications handle failures in completely different ways, and your storage should match what the workload actually needs.

In my five-node Talos cluster, I have three control planes and two worker nodes. Since workloads only run on the two workers, I have to be very deliberate about where data lands. 

Here is how I split storage between `local-path`, Longhorn, and TrueNAS NFS, and why each workload ended up where it did.

## 1. Local-path: fast, pinned, and perfect for databases

The `local-path` provisioner writes files directly to the local NVMe SSD on the node running the pod. There is zero network latency, no background synchronization, and no distributed controller overhead. It is as fast as bare metal disk I/O gets.

The catch is obvious: data on a `local-path` volume is permanently stuck to that specific machine. If the node dies, the data on that drive is gone until the machine comes back online.

That sounds terrifying for important data, but it is actually the best choice for all my Postgres databases managed by CloudNativePG (CNPG).

Here is why: CNPG already handles its own database replication at the application layer.

- Every database cluster runs two instances: a primary and a replica.
- Strict `podAntiAffinity` rules force the two database pods to land on different worker nodes.
- If the worker running the primary node catches fire, CNPG promotes the standby replica on the other worker to primary within seconds.

If I put CNPG databases on Longhorn, I would be paying for replication twice. The database writes the transaction to the replica over the network, and then Longhorn writes the underlying block storage to the other node over the network again. That just burns CPU, doubles network traffic, and tanks write IOPS for no extra safety.

Instead, I give CNPG raw local SSDs. If a worker goes down, the standby database takes over. If both workers die, Barman restores the database from MinIO S3 backups where write-ahead logs stream continuously. 

I run four databases this way (`immich-db`, `authentik-db`, `coroot-db`, and `grafana-db`), and performance has been rock solid.

## 2. Longhorn: replicated block storage for single-instance apps

Longhorn comes in when an application cannot replicate its own data and needs its volume to survive a node crash.

I run Longhorn with a replica count of 2 across my two worker nodes, with backups scheduled daily to an S3 bucket at `s3://pvc-backup/longhorn/`.

The best example of where Longhorn makes sense is our Minecraft server. 

Minecraft is a single-instance Java application with zero built-in clustering or replication. If the worker node running Minecraft crashes, Kubernetes will reschedule the pod over to the surviving worker. Because the world save data lives on a replicated Longhorn volume, the pod attaches the volume on the new node and boots the server without losing our builds.

Prometheus also uses a 50 GB Longhorn volume for its 60-day metric history. Metrics can be re-scraped if disaster hits, but having the volume follow the pod across worker reboots keeps monitoring graphs from developing annoying gaps.

### Why I kicked Longhorn out of Terraform

When I first set up the cluster, I tried to install Longhorn with Helm directly inside Terraform alongside Cilium and ArgoCD. 

That was a mistake. Longhorn installs a massive collection of custom resource definitions and background controllers. Terraform kept racing ahead and trying to configure volumes before the Longhorn API was actually ready to receive requests, leading to random bootstrap failures.

I fixed this by removing Longhorn from Terraform completely and letting ArgoCD manage it via GitOps. Terraform now bootstraps the bare cluster, installs Cilium, waits for the API to settle, and hands off to ArgoCD. ArgoCD uses sync waves to deploy Longhorn cleanly once the foundation is stable. 

Terraform is great for provisioning infrastructure, but for complex, CRD-heavy operators, GitOps sync waves give you much better control over startup ordering.

## 3. TrueNAS NFS: bulk storage for family photos

For my photo library on Immich, neither local SSDs nor Longhorn made sense. 

Immich stores thousands of high-resolution photos and family video clips. Storing hundreds of gigabytes of media files inside replicated Kubernetes block volumes would fill up the worker node SSDs in no time.

Instead, the Immich photo library lives on an NFS share exported from a TrueNAS SCALE box running a dedicated ZFS pool. 

This keeps bulk media off the Kubernetes nodes and takes advantage of ZFS features: native snapshots, data integrity checks, and scheduled off-site replication to Backblaze B2. Immich's database and metadata still live on fast local SSDs with CNPG, but the actual photo files sit on TrueNAS.

The trade-off here is that TrueNAS is a single point of failure for the photo library. If the TrueNAS box is powered off for maintenance, the Immich web app will run, but users won't be able to view or upload photos. For a homelab, that is a reasonable trade-off to keep storage management simple and centralized.

## The takeaway on storage

Don't assume you need to run every volume through distributed storage just because you are on Kubernetes. 

If your application already knows how to cluster and replicate itself (like modern database operators), give it fast local disk and let the app do its job. 

Save distributed storage like Longhorn for single-instance tools that need their disks to follow them between nodes. 

And for bulk media, a solid NAS running ZFS with external backups is almost always easier to manage than trying to cram terabytes of photos into container volumes.
