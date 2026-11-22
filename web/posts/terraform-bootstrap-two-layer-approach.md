---
title: Terraform Bootstrap and the Two-Layer IaC Design
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, infrastructure, gitops
summary: How I use Terraform to bootstrap a Talos Linux cluster on Proxmox — provisioning VMs, applying machine configs, bootstrapping etcd, and handing off to ArgoCD — and why the split between the two layers matters.
---

TL;DR: Terraform has one job — build everything ArgoCD needs to exist so it can take over. Once ArgoCD is running and the root app is applied, Git becomes the source of truth for everything else. This post covers what that bootstrap sequence looks like, what each Terraform resource is responsible for, and the trade-offs I made along the way.

## The Two-Layer Philosophy

Infrastructure as Code for a Kubernetes cluster has a bootstrapping problem: before GitOps can manage your cluster, the cluster has to exist. That circularity is exactly what Terraform is for in this setup.

**Layer 1 — Terraform:** Provisions the physical (virtual) substrate. VMs, Talos machine configuration, etcd bootstrap, the CNI, and ArgoCD itself. These are the things that *must* exist before anything else can run. Terraform is the right tool here because this layer deals with declarative resources that have no higher-level controller to reconcile them — there is no operator watching Proxmox and creating VMs.

**Layer 2 — ArgoCD (GitOps):** Once ArgoCD is running and a root Application is applied, it owns everything above the platform layer. App workloads, most infrastructure components, secrets synchronisation, monitoring — all of it is reconciled from Git. The rule is simple: if ArgoCD can manage it, it should. Terraform should not drift into managing things that belong to layer two.

The boundary is not arbitrary. It reflects *who can run what, and when*. Terraform can run from a laptop with a kubeconfig. ArgoCD needs a cluster, a CNI, and a Git repo credential to function. Terraform creates all three; ArgoCD owns the rest.

## What Terraform Manages

### Proxmox VMs

The cluster runs on two Proxmox VE hosts — `kirk` (primary: 2 control planes + 1 worker) and `picard` (1 control plane + 1 worker) — plus a QDevice for quorum. All five Talos nodes are defined in a **`nodes.yaml` inventory file** that Terraform loops over.

Each entry in `nodes.yaml` carries: `name`, `ip`, `type` (control-plane or worker), `platform` (proxmox or cloud), `nodename`, `storage_pool`, and `mac`. That MAC address is deliberate — it pins the VM to a static DHCP reservation on the network, so IP addresses are stable across rebuilds without Terraform managing DHCP itself.

The top-level cluster metadata lives alongside the node list: `cluster_name`, `talos_version` (v1.14.6), `kube_version` (v1.37.2), and a `factory_id` pointing to a custom Talos image schematic.

The `proxmox_virtual_environment_vm` resource creates each VM with:
- **OVMF/UEFI** firmware (not legacy BIOS)
- **q35** machine type
- **virtio-scsi-single** disk controller
- **virtio NIC** on a VLAN2 bridge
- The Talos disk image pulled from `factory.talos.dev` using the `factory_id` — a custom schematic that includes the `iscsi_tcp`, `nbd`, and `rpcsec_gss_krb5` kernel modules required by Longhorn and NFS

Control planes are sized at 2 vCPU / 5 GB RAM / 50 GB disk. Workers vary: the `kirk` worker gets 6 vCPU / 16 GB / 200 GB, the `picard` worker gets 4 vCPU / 10 GB / 200 GB.

### Talos Machine Configuration

The **`talos_machine_secrets`** resource generates the cluster PKI — certificates, keys, and bootstrap tokens. Everything Talos nodes need to trust each other and to authenticate the API comes out of this single resource.

**`talos_machine_configuration_apply`** then renders and applies a machine config to each node. Patches are layered by node role and platform:

- `shared-patch.yaml` — CNI set to `none`, kube-proxy disabled, disk `/dev/sda` with wipe, kernel modules (`iscsi_tcp`, `nbd`, `libiscsi`, `rpcsec_gss_krb5`), kubelet extra mounts for Longhorn/CNI/local-path/Tetragon, host DNS disabled
- `ctl-patch.yaml` — `allowSchedulingOnControlPlanes: false` (control planes are not schedulable)
- `vip-patch.yaml` — Layer2 VIP `192.168.2.5` on `net0`, applied only to Proxmox control planes; this is the stable API endpoint the kubeconfig points to
- `worker-patch.yaml` — worker-specific settings

### etcd Bootstrap and API Readiness

**`talos_machine_bootstrap`** runs against the first control plane to initialise the etcd cluster. This is a one-time operation — if it runs again on an already-bootstrapped node, Talos rejects it gracefully, but Terraform tracks it in state so it only fires once.

After bootstrap, there is a **`null_resource.wait_for_api`** that runs a bash loop polling TCP port 6443 on the VIP address. Without this, subsequent Helm and kubectl steps race against an API server that may not be ready to accept connections.

There is also a **`time_sleep`** of 90 seconds immediately after bootstrap — a guard against the window where etcd is elected but the API server has not yet started.

### CNI: Cilium

Cilium is installed via **`helm_release.cilium`** before ArgoCD. This is intentional: ArgoCD itself needs a functioning CNI to schedule its own pods. Cilium is configured with `kubeProxyReplacement: true`, pointing at the Talos local API proxy (`k8sServiceHost: localhost`, `k8sServicePort: 7445`). Gateway API and L2 announcements are enabled.

Gateway API CRDs are applied separately using **`kubectl_manifest.gateway_api_crds`**, which downloads the CRD manifest from GitHub and applies it ahead of Cilium's own configuration. CRDs must exist before Helm can reference them.

After Cilium installs, there is a **`time_sleep` of 300 seconds** before proceeding. This was added to fix a real race condition: CRDs were not reliably ready by the time the next resources tried to use them, causing intermittent failures on fresh installs. Five minutes is conservative, but it makes the bootstrap reliably idempotent.

### ArgoCD and the Root App

ArgoCD is installed via **`helm_release`** after Cilium stabilises. Before ArgoCD can sync anything, it needs two secrets injected as Kubernetes Secrets by Terraform:

- **`openbao-approle` Secret** — contains the OpenBao AppRole `role_id` and `secret_id` that the External Secrets Operator uses to authenticate to OpenBao. The `role_id` (`67fc1871-62db-2257-6416-852bbf189d1d`) is committed in Git; the `secret_id` is passed in as a Terraform variable and never written to the repository.
- **ArgoCD repo credentials Secret** — gives ArgoCD access to the private Git repository so it can begin syncing.

Finally, **`kubectl_manifest`** applies the root `app.yaml`. This is the ArgoCD Application that defines the app-of-apps: four child Applications (`infrastructure-staging`, `apps-staging`, `apps-prod`, `monitoring-staging`) that ArgoCD then reconciles from Git. At this point, Terraform's job is done.

## Sensitive Outputs

Terraform outputs the `talosconfig` and `kubeconfig` as sensitive values (`sensitive = true`). They are written to temp files during bootstrap so that subsequent Helm and kubectl providers can authenticate. These are not stored in the repository.

## Bootstrap Sequence, End to End

```
1. proxmox_virtual_environment_vm       — create all VMs
2. talos_machine_configuration_apply   — apply patches per node
3. talos_machine_bootstrap             — bootstrap etcd on first CP
4. time_sleep (90s)                    — wait for API server to start
5. null_resource.wait_for_api          — poll :6443 until ready
6. kubectl_manifest.gateway_api_crds   — apply Gateway API CRDs
7. helm_release.cilium                 — install Cilium
8. time_sleep (300s)                   — wait for CRDs to settle
9. helm_release.argocd                 — install ArgoCD
10. kubectl_manifest (secrets)         — inject openbao-approle + repo creds
11. kubectl_manifest (root-app.yaml)   — ArgoCD takes over
```

This sequence has been validated through multiple full cluster rebuilds: the most recent run on 22 November 2026 completed in approximately 33 minutes.

## What Terraform Does NOT Manage

Everything above the platform layer lives in Git and is reconciled by ArgoCD:

- Application workloads (Immich, Authentik, Minecraft, the blog)
- Longhorn storage (installed by ArgoCD now, not Terraform)
- External Secrets Operator and ClusterSecretStore
- CloudNative-PG clusters and databases
- Monitoring stack (kube-prometheus-stack, Grafana, Coroot)
- Cloudflare Tunnel and DNS
- Renovate CronJob

If it can be expressed as a Kubernetes manifest and reconciled by ArgoCD, it should be. Terraform managing Kubernetes objects beyond the bootstrap secrets creates split-brain risk — the same resource managed in two places.

## Known Limitations

**Unencrypted Terraform state.** State is stored on a NAS share. It contains the Talos PKI and bootstrap credentials generated by `talos_machine_secrets`. This is a documented gap. The plan is to migrate to **OpenTofu** and enable state encryption, which OpenTofu supports natively without requiring a remote backend.

**OpenBao not codified.** OpenBao itself is configured by hand — policies, AppRole, mounts. It is backed up via Proxmox Backup Server and cron Raft snapshots, but a full rebuild would require manually reconfiguring it before Terraform can inject the approle secret. Codifying this with OpenTofu is on the roadmap.

**`secret_id_ttl = 0`.** The AppRole secret ID never expires. This is a convenience for a homelab but a gap against least-privilege best practice. The plan is to introduce TTL-bound secret IDs with automated rotation.

## What This Design Demonstrates

The two-layer approach makes the cluster **reproducible by design**. Terraform handles the parts that cannot bootstrap themselves; ArgoCD handles everything that can be declared in Git. The separation keeps each tool doing what it is good at — Terraform as a provisioner, ArgoCD as a reconciler — without either one overreaching into the other's domain.

Running timed rebuild drills (the November 22 rebuild came in at ~33 minutes) validates that the design holds under real failure conditions, not just in theory. Each drill has surfaced at least one real bug — a sync wave ordering issue with ESO CRDs, a stale Talos image on the Proxmox host — and those fixes are committed back into the codebase, making each subsequent rebuild faster and cleaner.
