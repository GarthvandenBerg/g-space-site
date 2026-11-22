---
title: Why I Chose Talos Linux for My Homelab Kubernetes Cluster
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, talos, infrastructure
summary: Talos Linux is an immutable, API-driven OS purpose-built for Kubernetes. Here's why I chose it over Ubuntu+kubeadm and k3s, what the trade-offs are, and what I've learned running it in a five-node homelab cluster.
---

**TL;DR:** Talos Linux removes the operating system entirely as a source of configuration drift. There is no shell, no SSH, and no imperative setup steps — the entire node is described by a YAML machine config applied via `talosctl`. For a homelab cluster I want to rebuild from scratch in under an hour, that property is worth every bit of the initial learning curve.

## What Talos Linux Actually Is

**Talos Linux** is a minimal, immutable Linux distribution purpose-built to run Kubernetes nodes and nothing else. It ships with just enough OS to boot the kernel, run `containerd`, and expose the Talos API. That's it.

Compare that to a standard Ubuntu node:

- Ubuntu has `apt`, `systemd` units, SSH keys, shell history, cron jobs, and a dozen other surfaces that accumulate state over time.
- Talos has none of those. The root filesystem is read-only. There is no package manager. There is no SSH daemon. There is no shell.

All node configuration — kernel modules to load, kubelet flags, network settings, disk wipe policy, even whether control-plane nodes are schedulable — is expressed as a **machine config** YAML document and applied via `talosctl`. The API replaces the shell entirely.

## The Alternatives I Considered

Before landing on Talos, I seriously evaluated two paths:

**Ubuntu + kubeadm** is the well-trodden route. The documentation is excellent, debugging is familiar, and you can SSH into a node at any time. The downside is that familiarity cuts both ways: it's easy to log in and "just fix" something imperatively, and that fix lives only in the running node. After six months you have five nodes that are all slightly different, and you're not sure why. That drift is the problem I most wanted to avoid.

**k3s** is attractive for homelab use because of its low resource overhead and fast bootstrap. The single binary with SQLite for small clusters is genuinely elegant. I didn't choose it primarily because I wanted to run a full Kubernetes API surface (Gateway API, CRDs from operators like CNPG and the Coroot Operator), and I wanted to practice managing something closer to what production clusters look like. k3s would have been the right call if simplicity were the top priority.

**Talos won** because it solves the drift problem structurally, not by discipline.

## How Configuration Is Managed

My cluster has five nodes: three control planes (`talos-ctl-1`, `talos-ctl-2`, `talos-ctl-3`) and two workers (`talos-worker-1`, `talos-worker-2`), all provisioned by Terraform on two Proxmox VE hosts.

All Talos configuration lives in `.talos/patches/` and is composed from a small set of YAML patch files:

- **`shared-patch.yaml`** — applies to every node. This is where the most opinionated choices live.
- **`ctl-patch.yaml`** — control-plane-specific settings (e.g. `allowSchedulingOnControlPlanes: false`).
- **`worker-patch.yaml`** — worker-specific settings.
- **`vip-patch.yaml`** — the Layer2 VIP configuration, applied only to control-plane nodes on Proxmox.
- **`dns-patch.yaml`** — DNS-related settings.

Terraform's `siderolabs/talos` provider merges these patches and applies the resulting config to each node at provision time. Because the patches are in Git and Terraform applies them deterministically, every node is *guaranteed* to match what the files say. There is no "I think I ran that command on this node" ambiguity.

## A Concrete Example: Kernel Modules for Longhorn

Longhorn (the distributed block storage layer) requires several kernel modules: `iscsi_tcp`, `nbd`, and `libiscsi`. On Ubuntu you'd install `open-iscsi`, enable the service, and hope you remember to do that on every new node you add.

On Talos, `shared-patch.yaml` includes:

```yaml
machine:
  kernel:
    modules:
      - name: iscsi_tcp
      - name: nbd
      - name: libiscsi
      - name: rpcsec_gss_krb5
```

That's it. Every node — current and future — loads those modules at boot because the patch says so. No post-install script, no Ansible role, no forgotten step. The module list is in version control and reviewed like any other change.

## Disabling kube-proxy and Setting CNI to None

I run **Cilium** as my CNI in `kubeProxyReplacement: true` mode, meaning Cilium handles all service routing via eBPF and kube-proxy is not needed. Disabling it on a traditional node means finding the right kubeadm config flag or systemd unit. On Talos it's a patch field:

```yaml
cluster:
  network:
    cni:
      name: none
  proxy:
    disabled: true
```

Cilium is then installed by Terraform (Helm) immediately after the cluster bootstraps, before any workloads attempt scheduling.

## The VIP: Layer2 Instead of an External Load Balancer

For the Kubernetes API endpoint I need a stable IP across three control-plane nodes. Rather than running an external load balancer (HAProxy, keepalived separately, or a cloud LB), Talos has first-class support for **Layer2 VIP** via its `VIPConfig` machine config field.

My `vip-patch.yaml` sets `192.168.2.5` as the VIP on `net0`. Talos manages leader election and ARP advertisement internally. The result is a highly-available API endpoint with no additional infrastructure component to maintain.

## Custom Kernel Extensions via factory.talos.dev

The `iscsi_tcp` and `nbd` modules I need for Longhorn aren't in the default Talos image — they're **extensions** that must be baked into a custom image schematic at [factory.talos.dev](https://factory.talos.dev). I provide a schematic definition listing the extensions I need (`iscsi_tcp`, `nbd`, `rpcsec_gss_krb5`), the factory produces a unique `factory_id`, and Terraform pulls that specific image when provisioning VMs.

This means my kernel extension requirements are encoded at the infrastructure layer — in the Terraform variable referencing the `factory_id` — not in a post-boot script. Upgrading Talos means generating a new schematic at the same factory and updating the image reference in Terraform. The process is intentional and auditable.

## Trade-offs I Accepted

Talos is not without real costs. These are the ones I've actually felt:

**Interactive debugging is harder.** When something goes wrong at the node level, there is no `ssh node01` and `journalctl -f`. You use `talosctl logs`, `talosctl dmesg`, and `talosctl read` to inspect the node remotely. This is a genuinely different mental model and takes time to internalise. During my first few cluster rebuilds I kept reaching for a shell that wasn't there.

**The initial learning curve is steep.** Understanding machine configs, patch merging order, the Talos bootstrap sequence (generate secrets → apply config → bootstrap etcd → wait for health), and the factory schematic system all takes time upfront. There's no "just apt install kubernetes" shortcut.

**Some operational knowledge doesn't transfer.** A lot of Linux sysadmin intuition — checking running processes, editing config files in `/etc`, restarting services — simply doesn't apply. You have to build a new set of instincts around `talosctl` and the API.

## What I'd Do Differently

Running full cluster rebuilds as a drill has been the best learning tool. By November 2026 I'd done three timed rebuilds, getting from first `terraform apply` to a fully functional ArgoCD-reconciled cluster in around 33 minutes on the third run.

If I were starting over:

- **Document the bootstrap sequence earlier.** The order of operations (OpenBao unsealed → Terraform state accessible → `terraform apply` → ArgoCD reconciles) only became clear after drilling it.
- **Codify OpenBao configuration.** Right now OpenBao is configured by hand. That's a gap — the secrets backend should be as reproducible as everything else.
- **Plan the schematic update process explicitly.** When Talos releases a new version, I need to generate a new factory schematic. Making that a first-class step in the upgrade runbook would save fumbling.

## The Bottom Line

Talos Linux is the right choice if **config-as-data and zero drift** are higher priorities than operational familiarity. For a homelab cluster I use to practice production-grade patterns — GitOps, infrastructure as code, secrets management, disaster recovery drills — the trade-off is clearly worth it.

The inability to SSH into a node stopped feeling like a limitation once I reframed it: it's not that the shell is missing, it's that the shell was always the wrong interface for a node that should be fully described by its configuration. Talos just enforces what good practice already says.
