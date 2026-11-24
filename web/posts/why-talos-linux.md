---
title: Why I Chose Talos Linux for My Homelab Kubernetes Cluster
date: 2026-11-22
readTime: 8
tags: homelab, kubernetes, talos, infrastructure
summary: An OS with no SSH and no shell sounds painful until you watch your nodes rebuild cleanly from scratch in 30 minutes.
---

I am not going to lie, the first time you boot Talos Linux it feels a bit weird because there is no SSH. You can't just shell into a node, run `apt update`, or poke around in `/etc` to see why something is broken. There is literally no bash prompt, no package manager, and no systemd units to restart. 

The entire operating system is just enough code to boot the Linux kernel, launch containerd, and expose an API you talk to with `talosctl`. 

Losing your shell feels like someone took away your safety blanket. But once you spend months rebuilding clusters and trying to keep nodes identical, you realize that having a shell was half the reason your machines ended up broken in the first place.

## The problem with traditional distros

When I set out to build this cluster, the obvious choice was Ubuntu with `kubeadm`. It is well documented, everybody knows how to use it, and you feel right at home fixing things in the terminal.

The problem with being comfortable in a shell is that it tempts you to be lazy. You hit a weird network glitch on a Tuesday night, you SSH into `worker-2`, edit a config file by hand, restart a service, and tell yourself you will add it to your Ansible playbook later. You never do. Six months down the line, you have five nodes that have quietly drifted apart into unique little snowflakes, and if one dies, you have no idea how to recreate it from scratch.

I looked at k3s as well. It is lightweight and boots in seconds, which is great for small homelabs. But I wanted to practice skills that transfer to real production setups, running full upstream Kubernetes, Gateway API, Cilium, and operator CRDs. 

Talos won because it fixes configuration drift at the root. You cannot log into a node and make an undocumented change even if you want to.

## How configuration actually works

My cluster runs five nodes across two Proxmox VE hosts (`kirk` and `picard`): three control plane nodes (`talos-ctl-1`, `talos-ctl-2`, `talos-ctl-3`) and two workers (`talos-worker-1`, `talos-worker-2`). 

Every node gets provisioned by Terraform. Instead of running shell scripts after boot, all configuration lives in a folder called `.talos/patches/` as a handful of small YAML files:

- `shared-patch.yaml` has the base settings applied to every single node.
- `ctl-patch.yaml` locks down control planes so workloads do not schedule on them.
- `worker-patch.yaml` sets up worker-specific tuning.
- `vip-patch.yaml` defines the Layer 2 VIP for the control plane.
- `dns-patch.yaml` points the cluster at local DNS.

The Talos Terraform provider takes these patches, merges them, and pushes them to the nodes via the Talos API. If a node needs a tweak, you edit the YAML patch in Git, run Terraform, and the node updates. Every machine on the floor matches what is in the repository, period.

## Loading kernel modules without a package manager

A good example of how this works in practice is storage. I use Longhorn for distributed block storage, and Longhorn needs iSCSI kernel modules on every node to attach volumes.

On a normal Ubuntu setup, you would SSH in, run `apt install open-iscsi`, enable the service, and hope you remember to do that on every new machine. 

With Talos, you just tell the machine config to load the modules at boot inside `shared-patch.yaml`:

```yaml
machine:
  kernel:
    modules:
      - name: iscsi_tcp
      - name: nbd
      - name: libiscsi
      - name: rpcsec_gss_krb5
```

Every single node, current or future, loads those modules when it starts up. No post-boot bash scripts, no Ansible plays, and no missing dependencies when you add a new node.

## Ditching kube-proxy for Cilium eBPF

I run Cilium as the CNI and let it handle service routing in eBPF with `kubeProxyReplacement: true`. Since Cilium handles all of that directly in the kernel, kube-proxy is just extra bloat you do not need.

Telling Talos to step aside and let Cilium do its job is just a couple of lines in your machine config:

```yaml
cluster:
  network:
    cni:
      name: none
  proxy:
    disabled: true
```

Terraform applies that config, boots the nodes with no default CNI, and then deploys Cilium via Helm right after the cluster comes up.

## Control plane high availability with Layer 2 VIP

If you have three control plane nodes, you need a single stable IP address for the Kubernetes API so your nodes and tools can talk to the cluster if one machine goes down.

Usually, people spin up separate VMs running HAProxy and Keepalived to load balance traffic across the control planes. With Talos, you don't need any extra load balancer VMs. It has a built-in Layer 2 VIP feature. 

You just assign an IP in `vip-patch.yaml`, and Talos handles leader election and ARP advertising between the control planes on its own. If the node currently holding the VIP dies, another control plane grabs the IP immediately. That is one less piece of infrastructure to babysit.

## Extensions via Image Factory

Some tools need user-space binaries that do not come in the standard minimal Talos image. Longhorn, for instance, needs user-space iSCSI tools. 

Instead of letting you install packages on a running system, Talos has an online Image Factory at factory.talos.dev. You submit a list of the extensions you need, and it generates a custom image schematic with a unique ID. 

I take that schematic ID, put it in my Terraform variables, and Proxmox downloads that exact custom image when creating the VMs. Upgrades stay clean because the schematic ID stays the same across versions. When Talos puts out a new patch release, I just update the version number in Terraform and let the nodes roll.

## The honest downsides

I am not going to pretend Talos is all sunshine and rainbows. It forces you to rethink how you troubleshoot, and the learning curve can be brutal:

You cannot just tail syslog. If a node is misbehaving, you have to use `talosctl logs`, `talosctl dmesg`, or `talosctl read` over the network. When your cluster networking is broken and you can't reach the API, troubleshooting gets tricky fast.

The bootstrap order is strict. Secrets have to be generated, configs pushed, etcd initialized, and the API verified before anything else can happen. If one step hangs, you need to understand the bootstrap sequence well enough to figure out which stage is stuck.

Your traditional Linux admin muscle memory does not work here. Checking running processes with `ps aux`, editing something in `/etc`, or poking around in `/var/log` simply do not exist. You have to build new habits around the Talos CLI.

## Was it worth it?

During my disaster recovery drills, I wiped the entire cluster and timed how long it took to bring everything back from scratch. The last run took about 33 minutes from running `terraform apply` to having a fully healthy cluster with ArgoCD syncing all applications.

If I had built this on standard Linux distros, a full rebuild would have taken hours of fixing broken dependencies, debugging mismatched packages, and hunting down manual tweaks I forgot to write down. 

Not having an SSH shell was uncomfortable for the first week. But once you see your entire infrastructure rebuild itself from Git without you touching a single terminal prompt on the nodes, you will never want to go back to managing snowflake servers again.
