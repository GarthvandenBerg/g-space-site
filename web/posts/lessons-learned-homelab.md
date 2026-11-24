---
title: Real Lessons from Breaking and Rebuilding My Homelab
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, infrastructure
summary: Wiping a five-node cluster to see how long it takes to recover, and the three bugs that only showed up when everything was deleted.
---

Building a Kubernetes cluster the first time is pretty straightforward. You follow the guides, get pods running, see green checkmarks in your dashboard, and feel pretty good about yourself. 

The real test comes when you pull the plug on purpose to see if you can bring it back from the dead.

I built a five-node Talos Linux cluster across two Proxmox servers (`kirk` and `picard`). Everything is provisioned from code with Terraform and managed through GitOps with ArgoCD. But instead of just letting it sit there once it worked, I decided to run disaster recovery drills. I wiped the nodes, set a timer on my phone, and watched where the whole setup broke down.

Here is what I learned from doing that, including the messy bits and the shortcuts I still need to clean up.

## The timed drills: 70 minutes down to 33 minutes

You don't really know if your backups or automation work until you wipe your cluster and try to stand it back up from zero. 

I did three full rebuild drills:

The first run was back in October. It was untimed and mostly about seeing if the general idea worked. 

The second run in mid-November was timed, and it took about 70 minutes. More importantly, it uncovered three real bugs that never would have shown up during normal day-to-day operation:

1. The Talos image sitting on my Proxmox host was outdated, so new nodes were pulling old software.
2. The Helm repositories on my provisioning machine hadn't been updated, which caused package pull errors mid-deploy.
3. The External Secrets Operator (ESO) CRD sync wave was out of order, so application secrets failed to deploy on a clean run.

That ESO bug is a classic example of a hidden timing issue. While the cluster was running normally, everything looked completely healthy because the custom resource definitions already existed. It was only when I wiped the cluster and stood it up from scratch that the race condition popped up. 

By fixing those three issues, the third drill a few days later took about 33 minutes from running `terraform apply` to having a fully healthy cluster with all applications synced in ArgoCD. 

Having a written runbook makes you feel prepared, but actually timing a recovery gives you real data on where your bottlenecks are.

## Sync waves: why order matters

When ArgoCD syncs a repo, Kubernetes tries to create resources as fast as it can in parallel. If you don't explicitly tell it the order things need to happen in, you get slapped with CRD-not-found errors and broken deployments.

I use ArgoCD sync waves to force things into a strict sequence:

```text
-10: namespaces
 -9: CRDs
 -8: operators
 -6: ClusterSecretStore
 -5: ExternalSecrets
  2: CloudNativePG clusters and storage
  3: credential-sync jobs
  5: applications
 10: post-deploy validation
```

This reflects how dependencies actually work in the real world:

The External Secrets operator cannot do anything until its CRDs are registered in the API.

The `ClusterSecretStore` cannot authenticate until OpenBao is reachable over the network.

Postgres databases managed by CloudNativePG cannot initialize until their database password secrets exist.

The same thing applies to Terraform when bootstrapping the bare nodes: VM creation leads into Talos machine configuration, which leads into etcd bootstrap, then Cilium CNI, Longhorn storage, and finally ArgoCD. If you don't make ordering explicit everywhere, things will eventually fail on a fresh deploy.

## The ugly 300-second sleep

Speaking of ordering, not everything in Terraform is clean. 

When Terraform installs Cilium via Helm, Cilium has to start up and register its custom resource definitions before downstream resources can reference them. But Terraform doesn't have a built-in way to poll for "are these CRDs ready yet?"

My fix? A 300-second `time_sleep` resource right after the Cilium install. 

Is a 5-minute hard sleep ugly? Absolutely. But it is completely predictable, and it keeps Terraform from crashing while Cilium finishes settling into the nodes. Sometimes in homelabs you pick the simple, slightly hacky fix that works every time over an over-engineered script that breaks when you least expect it.

## Why I don't back up etcd

This might sound crazy to some Kubernetes admins, but I deliberately do not back up etcd. 

In my setup, etcd is treated as disposable runtime state. All the desired state for the cluster lives in Git. All the actual data that matters lives outside the cluster:

- Application manifests are in Git repositories.
- Database base backups and write-ahead logs go to MinIO S3 storage, managed by CloudNativePG and Barman.
- Family photos and bulk media live on TrueNAS with ZFS snapshots.
- Cluster secrets are stored in OpenBao outside Kubernetes, backed up to Proxmox Backup Server.

Because none of the permanent state lives exclusively inside the cluster, losing the entire cluster is just a rebuild event rather than a disaster. Running `terraform apply` stands the nodes back up, ArgoCD pulls the manifests from Git, and the databases restore their data from S3. 

Most of that 33-minute rebuild time is just waiting for VMs to clone on Proxmox and container images to download. There is no frantic manual rescue mission needed.

## The learning curve of an API-only OS

Talos Linux gets rid of configuration drift by completely removing SSH and bash shells. Every single node setting is defined in a YAML patch file and applied through `talosctl`.

That sounds fantastic on paper, but it raises the bar on troubleshooting. When a node doesn't join the cluster or has a network issue, you cannot just SSH in and run `journalctl -f` or check `/var/log/syslog`. You have to get used to using `talosctl logs`, `talosctl dmesg`, and reading machine configs carefully. 

It took me a while to stop instinctively reaching for an SSH client, but once you build the muscle memory for the Talos CLI, you realize how much cleaner it is to manage nodes as code.

## Being honest about the current gaps

Too many homelab write-ups pretend everything is 100% perfect. My lab still has some rough edges that I haven't gotten around to fixing yet:

Internal networking is still mostly flat. I have Cilium installed and Hubble running, but I haven't written strict `CiliumNetworkPolicy` rules to isolate namespaces from each other yet.

Terraform state is sitting on my NAS unencrypted. It contains sensitive credentials from the bootstrap process, which is a security gap I need to close with proper backend encryption.

OpenBao was set up manually. While the Kubernetes cluster is 100% code, the OpenBao instance running on a separate VM was configured by hand. If that VM dies, I have to restore it from a Proxmox backup rather than spinning it up with Terraform.

The AppRole secret ID does not expire. I set `secret_id_ttl=0` during initial setup so I wouldn't have to deal with token rotation while getting the cluster off the ground. It works, but it needs to be rotated properly.

No CI pipeline checking manifests before commit. Right now I don't run `kubeconform` or `kustomize build` in GitHub Actions before pushing. If I make a typo in a manifest, I only find out when ArgoCD goes red.

## What this actually gives you

The whole point of running a lab like this is getting comfortable with how systems behave when things go wrong. 

It is easy to get overwhelmed by all the tools in the cloud native ecosystem. You hear people talk about GitOps, immutable infrastructure, eBPF, and secrets operators, and it feels like an impossible mountain to climb. But when you break it down into small pieces, build it by hand, and break it on purpose, it stops being mysterious.

You don't need a massive budget or enterprise gear to build good habits. You just need some patience, backups of your data, and the willingness to let things crash so you can learn how to put them back together.
