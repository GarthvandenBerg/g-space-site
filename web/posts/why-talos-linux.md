---
title: Why I Chose Talos Linux for My Homelab Kubernetes Cluster
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, talos, infrastructure
summary: Talos Linux is an immutable, API-driven OS purpose-built for Kubernetes. Here is why I chose it over Ubuntu + kubeadm and k3s, the trade-offs, and what I have learned running it in a five-node homelab cluster.
---

**TL;DR:** **Talos Linux** removes the operating system as a source of **configuration drift**. There is no shell, no SSH, and no imperative setup: the entire node is described by a YAML **machine config** applied through `talosctl`. For a cluster I want to rebuild from scratch in under an hour, that property is worth the learning curve.

## What Talos Linux Actually Is

**Talos Linux** is a minimal, **immutable** Linux distribution built to run Kubernetes nodes and nothing else. It includes just enough OS to boot the kernel, run `containerd`, and expose the **Talos API**.

Compare that with a standard Ubuntu node, which has `apt`, `systemd` units, SSH keys, shell history, and cron jobs — all surfaces that accumulate state over time. Talos has none of them. The root filesystem is read-only, and there is no package manager, SSH daemon, or shell.

All node configuration (kernel modules, kubelet settings, networking, disk handling, whether control planes accept workloads) lives in a **machine config** document applied via `talosctl`. **The API replaces the shell.**

## The Alternatives I Considered

**Ubuntu + kubeadm** is the well-trodden route. Documentation is excellent and debugging is familiar. But familiarity cuts both ways: it is easy to SSH in and "just fix" something, and that fix lives only on that node. After six months you have five nodes that are all slightly different. That **drift** is the problem I most wanted to avoid.

**k3s** is attractive for homelabs thanks to low resource use and fast bootstrap. I did not choose it mainly because I wanted to run a full upstream Kubernetes surface (Gateway API and operator CRDs from CNPG and the Coroot Operator) and practice something closer to a production cluster. k3s would be the better answer if simplicity were the top priority.

**Talos won** because it solves drift **structurally**, not through discipline.

## How Configuration Is Managed

The cluster has five nodes: three control planes (`talos-ctl-1`, `talos-ctl-2`, `talos-ctl-3`) and two workers (`talos-worker-1`, `talos-worker-2`), all provisioned by **Terraform** on two Proxmox VE hosts.

All Talos configuration lives in `.talos/patches/` as a small set of YAML patches:

- **`shared-patch.yaml`**: applies to every node; most opinionated choices live here
- **`ctl-patch.yaml`**: control-plane settings (for example `allowSchedulingOnControlPlanes: false`)
- **`worker-patch.yaml`**: worker settings
- **`vip-patch.yaml`**: Layer 2 VIP, applied only to control planes on Proxmox
- **`dns-patch.yaml`**: DNS settings

The `siderolabs/talos` Terraform provider merges these patches and applies the result to each node. Because patches are in Git and applied deterministically, every node **matches what the files say**.

## A Concrete Example: Kernel Modules for Longhorn

**Longhorn** (distributed block storage) needs iSCSI support on every node. On Ubuntu you would install `open-iscsi`, enable the service, and hope you repeat it on every new node.

On Talos, the required kernel modules are declared in `shared-patch.yaml`:

```yaml
machine:
  kernel:
    modules:
      - name: iscsi_tcp
      - name: nbd
      - name: libiscsi
      - name: rpcsec_gss_krb5
```

Every node, current and future, loads those modules at boot. There is no post-install script and no Ansible role. The list is version-controlled and reviewed like any other change.

## Disabling kube-proxy and Setting CNI to None

I run **Cilium** with `kubeProxyReplacement: true`, so Cilium handles service routing in eBPF and kube-proxy is not needed. On Talos that is a patch:

```yaml
cluster:
  network:
    cni:
      name: none
  proxy:
    disabled: true
```

Terraform installs Cilium via Helm right after the cluster bootstraps, before workloads schedule. (More on this in my networking post.)

## The VIP: Layer 2 Instead of an External Load Balancer

The Kubernetes API needs a stable address across three control-plane nodes. Instead of running HAProxy or a separate keepalived setup, I use Talos's built-in **Layer 2 VIP**, configured as a `vip` entry on the control-plane network interface in `vip-patch.yaml`.

Talos handles **leader election** and **ARP advertisement** internally. The result is a **highly available API endpoint** with no extra component to maintain.

## Custom Image Extensions via Image Factory

Longhorn's userspace requirements (such as **iSCSI tooling**) are not in the default Talos image. They are **system extensions** baked into a custom image through [factory.talos.dev](https://factory.talos.dev). I define a **schematic** listing the extensions I need, the factory returns a unique schematic ID (`factory_id`), and Terraform pulls that image when provisioning VMs.

Extension requirements are therefore encoded at the **infrastructure layer**, in a Terraform variable, not in a post-boot script. The schematic ID stays the same across Talos versions; the version tag changes. A **new schematic is only needed when the extension list changes**, so a routine upgrade means updating the Talos version in Terraform and rolling nodes.

## Trade-offs I Accepted

These are the costs I have actually felt:

- **Interactive debugging is harder.** There is no `ssh node01` and `journalctl -f`. You use `talosctl logs`, `talosctl dmesg`, and `talosctl read` remotely. During my first rebuilds I kept reaching for a shell that was not there.
- **The learning curve is steep up front.** Machine configs, patch merge order, the bootstrap sequence (generate secrets → apply config → bootstrap etcd → wait for health), and the Image Factory all take time to learn.
- **Some sysadmin knowledge does not transfer.** Checking processes, editing `/etc`, and restarting services do not apply; you build new instincts around `talosctl`.

## What I Would Do Differently

I have run **three full cluster rebuild drills**; the last two were timed, and the third took about **33 minutes** from first `terraform apply` to a fully reconciled ArgoCD cluster. Looking back:

- **Document the bootstrap sequence earlier.** The order (OpenBao unsealed → Terraform state accessible → `terraform apply` → ArgoCD reconciles) only became clear through drilling.
- **Codify OpenBao configuration.** It is configured by hand today, which is a gap for a secrets backend.
- **Make the Talos upgrade process a first-class runbook step,** including when a new schematic is required and how to verify the image before rolling nodes.

## The Bottom Line

Talos Linux is the right choice if **config-as-data and zero drift** matter more than operational familiarity. For a homelab used to practice **GitOps, Infrastructure as Code, secrets management, and disaster recovery**, the trade-off is clearly worth it.

Not being able to SSH into a node stopped feeling like a limitation once I reframed it: the shell was always the wrong interface for a node that should be fully described by its configuration. Talos enforces what good practice already says.
