---
title: How My Homelab Actually Works: Talos Linux on Proxmox
date: 2026-11-22
readTime: 10
tags: homelab, kubernetes, talos, infrastructure
summary: Walking through my five-node Talos cluster on Proxmox, how Terraform and ArgoCD run the show, and why the whole thing is built to be wiped and rebuilt in half an hour.
---

Most homelab setups start with someone running a quick script on a single server, getting a couple of containers running, and calling it a day. That is great for messing around on a weekend, but it doesn't teach you how production systems actually behave when real traffic hits or when something catches fire.

I wanted to build a lab that forced me to learn platform engineering the hard way: managing infrastructure entirely as code, handling networking with eBPF, keeping secrets out of Git, and practicing disaster recovery by deliberately destroying the cluster and timing how fast it comes back.

This is the big picture walkthrough of how the whole platform fits together, warts and all.

## The physical servers

The whole setup runs on two physical Proxmox VE hosts, which I named after Star Trek captains:

`kirk` is the primary Proxmox machine, carrying two control plane nodes and one worker.

`picard` is the second host, carrying one control plane and one worker.

To prevent split-brain issues with Proxmox cluster quorum, I have a tiny third machine acting as a QDevice. It doesn't run any heavy VMs; it just votes in Corosync so the two main hosts don't fight over who is in charge if network connectivity blips. It also runs Uptime Kuma to monitor the lab from the outside.

If either `kirk` or `picard` dies completely, the surviving host stays up and Kubernetes keeps the workloads running.

## The Kubernetes nodes

Inside Proxmox, the cluster runs five virtual machines, all powered by Talos Linux:

- `talos-ctl-1` (2 vCPU, 5 GB RAM on kirk)
- `talos-ctl-2` (2 vCPU, 5 GB RAM on kirk)
- `talos-ctl-3` (2 vCPU, 5 GB RAM on picard)
- `talos-worker-1` (6 vCPU, 16 GB RAM on kirk)
- `talos-worker-2` (4 vCPU, 10 GB RAM on picard)

All node specs live in a simple `nodes.yaml` file in the repository. When I run Terraform, it loops through that YAML file and builds the VMs automatically with UEFI boot, virtio-scsi storage, and dedicated VLAN bridges. Adding or upgrading a node is just changing a line in that file.

Workloads are blocked from running on the control planes so system components always have breathing room. 

For the Kubernetes API, I use Talos's built-in Layer 2 VIP at `192.168.2.5`. If the control plane node holding that IP drops offline, another control plane takes over the address automatically. I don't need to spin up separate HAProxy or keepalived VMs just to talk to the cluster.

## Splitting the work: Terraform and ArgoCD

One rule I stuck to is having a very clear split between provisioning bare infrastructure and running applications.

### 1. Terraform builds the foundation

Terraform is responsible for everything that has to exist before Kubernetes can even think about running apps:

It creates the Proxmox VMs, pulls our custom Talos image from the Image Factory with extra kernel modules for storage, pushes the machine configs to every node, and bootstraps etcd. 

Once the Kubernetes API is healthy, Terraform installs Cilium for networking, Longhorn for storage, and bootstraps ArgoCD via Helm. Finally, it drops the repository credentials and secrets into the cluster, applies the root ArgoCD application manifest, and steps back.

From that second onward, Terraform is done. It does not touch application manifests.

### 2. ArgoCD runs the workloads

ArgoCD takes over where Terraform leaves off. It uses the app-of-apps pattern, where one root application points to child applications for infrastructure tools, staging apps, and monitoring.

Everything is set to auto-sync with self-healing turned on. If I get impatient and manually tweak something with `kubectl edit`, ArgoCD will detect the drift within minutes and overwrite it back to what Git says. 

To keep things from crashing into each other on boot, ArgoCD sync waves enforce the deployment order. Namespaces and CRDs get built first, then the secrets operators, then storage and databases, and finally the user applications.

## What is actually running in the cluster?

I run real workloads in this lab so that breaking things actually has consequences:

- **Immich:** Self-hosted photo management for my family. It uses TrueNAS NFS shares for bulk photos and a dedicated Postgres database.
- **Authentik:** Single sign-on and identity provider that secures internal services.
- **Personal sites and blog:** Hosted right here on this cluster, routed through Cloudflare Tunnels so no inbound router ports are exposed to the public internet.
- **Minecraft:** A game server running on local persistent storage so friends can jump on.
- **Renovate:** A scheduled job that checks our Helm charts and container tags every two hours, opening pull requests automatically when updates drop.

## How data and secrets are handled

Storage and state are where most Kubernetes setups turn into a nightmare if you don't plan ahead.

### Databases with CloudNativePG

I run four separate PostgreSQL instances (for Immich, Authentik, Coroot, and Grafana) using the CloudNativePG operator. 

Each database runs two instances with anti-affinity rules so they never sit on the same physical host. I specifically put them on local node SSDs (`local-path`) instead of distributed block storage. Since CloudNativePG already handles replication between the database pods, putting them on top of replicated storage like Longhorn would just waste CPU and double-write everything.

Every database streams its write-ahead logs (WAL) to an S3 bucket on MinIO, and full backups run overnight. If a database goes belly up, there are ready-to-go `restore-db.yaml` files in the repo to restore the cluster from S3.

### Keeping secrets out of Git with OpenBao

Secrets never get committed to Git. I run OpenBao (an open-source fork of HashiCorp Vault) on a separate VM outside Kubernetes at `bao.g-space.co.za`. 

Inside the cluster, External Secrets Operator (ESO) talks to OpenBao using Vault AppRoles. When an application needs a database password or API token, ESO fetches it from OpenBao and creates a native Kubernetes secret in memory. If you look at the Git repository, you only see references to secret paths, never actual passwords.

### Networking and public access

For internal networking, Cilium handles all CNI routing and replaces kube-proxy entirely using eBPF. 

For public access, I don't forward any ports on my home router. Everything goes through Cloudflare Tunnels using the `cfgate` operator and Gateway API HTTPRoutes. The tunnel establishes an outbound connection to Cloudflare, and Cloudflare routes public traffic in securely. 

For private admin access, I use a NetBird WireGuard mesh combined with a Caddy reverse proxy running in a Proxmox container, secured with internal DNS.

## The rebuild mindset

A lot of homelab guides tell you how to set up complex backups for etcd. I deliberately chose not to back up etcd at all.

In this cluster, etcd is treated as completely disposable. All my configuration is in Git. All database data is safely backed up to MinIO S3 and TrueNAS ZFS snapshots. Secrets live outside the cluster in OpenBao. 

If both Proxmox hosts explode tomorrow, I don't try to stitch together an old etcd database. I run `terraform apply`, let it build fresh VMs and install ArgoCD, and let GitOps pull down the apps while CloudNativePG restores the databases from S3.

In my last timed drill, going from a completely wiped cluster to fully reconciled applications took about 33 minutes.

## Being upfront about what is still broken

No homelab is ever truly finished, and mine has plenty of shortcuts I haven't fixed yet:

Terraform state is sitting unencrypted on my NAS. That state file contains bootstrap credentials and tokens, which is a real security risk until I migrate it to an encrypted backend.

OpenBao was configured manually. While the Kubernetes cluster is 100% automated, the OpenBao VM was configured through the web UI and bash commands. If that VM dies, I have to restore it from a Proxmox image backup.

The AppRole secret ID does not expire. I set `secret_id_ttl=0` during setup so I wouldn't have to deal with automated rotation while learning the basics. 

There are no network policies. All pods can talk to all other pods across the cluster. I have Cilium Hubble running, but I haven't taken the time to write strict firewall policies between namespaces.

The worker nodes are uneven. One worker has 16 GB of RAM and 6 cores, while the other has 10 GB and 4 cores, because that is the hardware I had available on those two machines.

## Why this approach matters

The point of doing all this in a homelab isn't to look fancy on the internet. It is about getting over the fear of breaking things. 

When you spend your days working on production infrastructure, you learn that things will inevitably fail: hardware dies, network routes drop, and software updates break dependencies. If you build systems that rely on you remembering what you clicked in a web console six months ago, you will be terrified of touching them.

Once you force yourself to write everything as code, test your disaster recovery with a stopwatch, and treat your servers like cattle, running Kubernetes stops being stressful and actually becomes fun.
