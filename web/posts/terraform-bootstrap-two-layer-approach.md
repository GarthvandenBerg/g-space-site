---
title: "Terraform Bootstrap: How I Split Infrastructure and GitOps"
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, infrastructure, gitops
summary: Solving the chicken-and-egg problem of bootstrapping Kubernetes, and why Terraform should step aside the moment ArgoCD wakes up.
---

When building a Kubernetes cluster with Infrastructure as Code, you immediately run into a chicken-and-egg problem. 

You want GitOps to manage everything in your cluster. But before ArgoCD can manage your cluster, you need a Kubernetes cluster to run ArgoCD. And before you have a Kubernetes cluster, you need virtual machines, an operating system, and networking.

A lot of homelab setups try to force one tool to do everything. Either they use Terraform to deploy application Helm charts and manage workloads, or they write complicated bash scripts that run half in Git and half on a laptop.

I decided on a strict two-layer rule for my homelab:

Terraform has one job: build the foundation up to the point where ArgoCD can stand on its own two feet. 

Once ArgoCD is running and takes over the root application manifest, Terraform steps away completely. It never touches user workloads, application databases, or internal policies.

Here is how the bootstrap sequence works, and why keeping that seam clean makes full cluster rebuilds fast and predictable.

## The Proxmox inventory: nodes.yaml

The cluster runs five Talos Linux nodes across two Proxmox hosts (`kirk` and `picard`). Instead of writing individual Terraform blocks for each VM, all five nodes are defined in a clean `nodes.yaml` file:

- `talos-ctl-1` (kirk)
- `talos-ctl-2` (kirk)
- `talos-ctl-3` (picard)
- `talos-worker-1` (kirk)
- `talos-worker-2` (picard)

Each entry defines the VM name, IP address, hardware sizing, storage pool, and MAC address. Setting explicit MAC addresses is a deliberate trick: it locks each VM to a static DHCP reservation on my home router. That way, nodes always get the exact same IP addresses across rebuilds without Terraform needing to manage DHCP directly.

Terraform loops over that YAML file and uses the `bpg/proxmox` provider to create the VMs with UEFI firmware, virtio-scsi disk controllers, and custom Talos images pulled from `factory.talos.dev`.

## Talos machine configs and etcd bootstrap

Once the VMs exist, Terraform uses the `siderolabs/talos` provider to generate the cluster PKI and certificates with `talos_machine_secrets`. 

Next, it applies machine config patches to each node:

- `shared-patch.yaml`: Turns off the built-in CNI, disables kube-proxy, loads kernel storage modules (`iscsi_tcp` and `nbd`), and configures local disks.
- `ctl-patch.yaml`: Disables workload scheduling on control plane nodes.
- `vip-patch.yaml`: Sets up a shared Layer 2 VIP at `192.168.2.5` across the control planes.
- `worker-patch.yaml`: Applies worker-specific settings.

Once configs are pushed, Terraform fires `talos_machine_bootstrap` on the first control plane node to initialize etcd. 

Right after bootstrap, I have a 90-second wait followed by a bash loop that polls port 6443 on the VIP. That keeps Terraform from rushing ahead before the Kubernetes API server has actually started accepting requests.

## Installing the network and the 300-second sleep

Before ArgoCD can schedule pods, the cluster needs a working network. 

Terraform applies the Gateway API CRDs and installs Cilium using Helm, pointing it at Talos's local KubePrism proxy on `localhost:7445`. 

Right after the Cilium install, I put in a 300-second `time_sleep`. 

Is a 5-minute hard sleep pretty? No. But Cilium registers multiple custom resource definitions in the background, and without that wait, downstream steps intermittently crashed because the CRDs weren't ready yet. A 5-minute wait makes the whole bootstrap sequence rock solid every time.

## Handing the keys to ArgoCD

With networking stable, Terraform installs ArgoCD via Helm. Before ArgoCD can start pulling manifests from Git, it needs two secrets created in the cluster:

1. The ArgoCD repository credentials, so it can read my private GitOps repo.
2. The `openbao-approle` secret, containing the `secret_id` that External Secrets Operator needs to authenticate to our vault.

The `secret_id` is passed into Terraform as an environment variable and never committed to Git.

Finally, Terraform applies `root-app.yaml`. This is the master ArgoCD Application that points to our child applications in Git (`infrastructure-staging`, `apps-staging`, and `monitoring-staging`). 

The second that root app is applied, Terraform's job is finished.

## The bootstrap sequence from start to finish

Here is the exact order of operations when running `terraform apply`:

1. Create VMs in Proxmox from `nodes.yaml`.
2. Push Talos machine config patches to all nodes.
3. Bootstrap etcd on the first control plane.
4. Wait 90 seconds and poll port 6443 until the API responds.
5. Apply Gateway API CRDs.
6. Install Cilium via Helm.
7. Wait 300 seconds for Cilium CRDs to settle.
8. Install ArgoCD via Helm.
9. Inject the OpenBao AppRole secret and Git repo credentials.
10. Apply `root-app.yaml` to hand control over to GitOps.

In my last timed drill, this entire sequence ran completely unattended in about 33 minutes.

## What Terraform does NOT manage

Everything above the foundation layer lives in Git and is reconciled by ArgoCD:

- User apps like Immich, Authentik, the personal websites, and Minecraft
- Longhorn storage operator
- External Secrets Operator and secret stores
- CloudNativePG database clusters
- Prometheus, Grafana, and Coroot
- Cloudflare Tunnels and DNS records
- Renovate update jobs

If a tool can be declared as a Kubernetes manifest, it belongs in GitOps. Having Terraform manage in-cluster application resources creates split-brain headaches where you can't tell whether Git or Terraform is in charge.

## Honest gaps in my setup

There are still a couple of areas in the Terraform layer that need work:

Terraform state is unencrypted on my NAS. That state file contains bootstrap certificates and tokens. I plan to migrate to OpenTofu so I can use native state encryption without needing a complex remote backend.

OpenBao was configured manually. While the Kubernetes cluster is fully automated with Terraform, the OpenBao VM was configured through the CLI by hand. Codifying OpenBao setup into Terraform is on my backlog.

The AppRole secret ID does not expire. I set `secret_id_ttl=0` during initial testing so I wouldn't have to build automated rotation right away.

## Why the split matters

Splitting your setup into two clean layers prevents tools from fighting each other. 

Terraform does what it does best: talking to the Proxmox API, creating VMs, and standing up the base cluster. 

ArgoCD does what it does best: watching Git, syncing manifests, and keeping workloads running. 

By keeping that boundary clear and testing it with rebuild drills, you get an infrastructure you can trust and rebuild at a moment's notice.
