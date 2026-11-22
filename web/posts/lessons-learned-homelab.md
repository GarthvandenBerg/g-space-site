---
title: Lessons Learned — Reflections from Building a Production-Habits Homelab
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, infrastructure
summary: After three cluster rebuild drills (two of them timed), two Proxmox hosts, and an honest gap analysis, here is what I learned building a production-style Kubernetes homelab — and what I would do differently.
---

**TL;DR:** I built a five-node **Talos Linux** Kubernetes cluster on two **Proxmox VE** hosts, managed entirely through **Infrastructure as Code** (Terraform) and **GitOps** (ArgoCD). The most valuable lessons came from **disaster recovery drills**, not from the initial build: a timed rebuild exposed three latent bugs, and fixing them cut the rebuild from **~70 minutes to ~33 minutes**. This post covers the six lessons that stuck, the gaps I have not fixed yet, and the roadmap.

When I started this project, the goal was a Kubernetes homelab that behaved less like a weekend experiment and more like a small production environment: real workloads, practiced recovery, Git as the source of truth, and documented gaps. What I did not expect was how much of the learning would come from *operating* the cluster and *breaking it on purpose*, rather than from building it.

---

## What I Set Out to Do

The target architecture:

- **Five-node Talos Linux cluster** (three control planes, two workers) on two Proxmox VE hosts (`kirk` and `picard`)
- **Bootstrapped entirely from code:** Terraform provisions the VMs, applies Talos machine configs, bootstraps etcd, installs Cilium, and hands off to ArgoCD
- **GitOps** with **ArgoCD** managing the application layer
- **Secrets management** with **OpenBao** and the **External Secrets Operator (ESO)**
- **Recoverable by design:** actual rebuild drills, not just written runbooks

---

## The Six Lessons That Actually Stuck

### 1. Dependency ordering is everything

Ordering assumptions that are only implicit will eventually fail. The classic example is a *CRD-not-found* error because an operator deployed before its CRDs were registered. These errors look like configuration bugs but are really **timing bugs**.

ArgoCD **sync waves** are the right tool, but you have to commit to them. My wave assignments:

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

These reflect real dependency chains:

- The ESO operator cannot function until its CRDs exist.
- The `ClusterSecretStore` cannot authenticate until OpenBao is reachable.
- CloudNativePG (CNPG) clusters cannot start until their credential secrets are populated.

The same principle applies at the infrastructure layer. Terraform runs: **VM creation → Talos config → etcd bootstrap → API readiness → Cilium → Longhorn → ArgoCD → root app**. Recovery has an order too: **network and DNS → TrueNAS → OpenBao unsealed → Terraform state accessible → `terraform apply`**.

**Key takeaway:** Make ordering explicit everywhere — sync waves, Terraform `depends_on`, and recovery runbooks.

### 2. Test your restores — the drills found real bugs

| Drill | Date | Result |
|---|---|---|
| 1 | October 2026 | Untimed proof of concept |
| 2 | November 19, 2026 | **~70 minutes**, timed, found **three real bugs** |
| 3 | November 22, 2026 | **~33 minutes**, clean apart from one manual nudge on the monitoring stack |

The three bugs found in drill 2:

1. The **Talos image on the Proxmox host was stale**
2. **Helm repos on the provisioning machine** had not been updated
3. The **ESO CRD sync wave was misconfigured**, so ExternalSecrets failed on a clean apply

The ESO bug is a good example of a *latent* failure. In steady state everything looked healthy because the CRDs already existed. Only a from-scratch bootstrap exposed the ordering problem.

The **37-minute improvement** between drills 2 and 3 came entirely from fixing what drill 2 surfaced. That is a measurement, not an estimate.

**Key takeaway:** An untested restore is not a backup. The untimed October drill gave me confidence; the timed November drill gave me data.

### 3. Durable state outside the cluster changes what "disaster" means

Where state lives determines how bad a failure is:

- **Manifests:** Git
- **Database backups (WAL and base backups):** MinIO S3, restored with Barman/CNPG
- **Photos:** TrueNAS with ZFS snapshots
- **Secrets:** OpenBao, outside the cluster, protected by Proxmox Backup Server and Raft snapshots

Because of this, a total cluster loss is a **rebuild event, not a catastrophe**. I deliberately chose **not** to back up etcd: desired state is in Git and data is in S3/NFS, so etcd is a runtime artifact. `terraform apply` reconstitutes the cluster, ArgoCD reconciles the application layer, and databases restore from backup.

The ~33 minute figure is the **cluster rebuild time**. It is mostly waiting on Terraform to provision VMs and on ArgoCD to sync, not heroic recovery effort.

**Key takeaway:** Durable state placement is an architectural decision, not an operational detail. Know exactly what lives where, and verify it with drills.

### 4. The immutable OS removes a class of problems — and raises the debugging skill floor

**Talos Linux** has no SSH, no package manager, and no interactive shell. Every change goes through the Talos API (`talosctl`) as a declarative patch. This nearly eliminates **configuration drift**: you cannot log in and install something that is not captured in code.

The cost is a higher skill floor. Diagnosis relies on `talosctl logs`, `talosctl dmesg`, `talosctl read`, and careful reading of patch files. If you are used to `ssh node && journalctl -f`, the learning curve is real. Immutability does not make debugging easier — it makes it *different*, and in some ways more demanding.

**Key takeaway:** Immutability is a genuine operational improvement, but it front-loads expertise requirements.

### 5. The two-layer approach (Terraform → ArgoCD) works, but the seam must stay consistent

**Terraform** owns infrastructure: VMs, Talos config, and the initial Cilium and ArgoCD installs. **ArgoCD** owns everything above that. The boundary is deliberate.

But the seam carries obligations. ArgoCD's repo credentials are injected as a Kubernetes Secret by Terraform at bootstrap, and the OpenBao AppRole `secret_id` is passed as a Terraform variable. If these drift from what ArgoCD or ESO expects, failures are not obvious.

The Cilium timing issue is the clearest example. Cilium is installed by Terraform via Helm, but its CRDs were not reliably ready when Terraform moved on. The fix was a **300-second `time_sleep`** — ugly but predictable, and a sign of how hard it is to wait for CRD readiness in Terraform without a proper polling mechanism.

**Key takeaway:** Boundaries have interfaces, and interfaces need to be explicit, documented, and tested. The rebuild drill exercises the Terraform→ArgoCD handoff every time.

### 6. Race conditions are real, even at homelab scale

I hit three distinct race conditions:

- **Cilium CRD timing:** dependent resources referenced CRDs that were not ready (fixed with `time_sleep`)
- **ESO CRD sync wave:** ExternalSecrets resources applied before the CRDs had synced (fixed by correcting the sync wave)
- **API readiness:** Terraform needed to wait for the Kubernetes API after etcd bootstrap before proceeding

Kubernetes reconciles in parallel, which surfaces these races quickly. Small scale does not protect you; fewer nodes and less headroom can make timing margins tighter.

---

## Known Gaps (Being Honest)

I would rather document these than pretend they do not exist:

- **No `NetworkPolicy` or `CiliumNetworkPolicy` yet.** Hubble is enabled but not used for flow visibility or policy generation, so internal networking is flat.
- **Terraform state is unencrypted on the NAS.** It contains sensitive values.
- **OpenBao is configured by hand.** It is not codified with Terraform or OpenTofu and is the most manual component.
- **AppRole `secret_id_ttl=0` (never expires).** TTL-bound secret IDs with rotation are planned.
- **No CI validation.** GitOps PRs are not checked with `kustomize build` or `kubeconform`; errors surface at sync time.
- **Off-site NAS restore never tested.** MinIO zvol coverage in cloud replication is unconfirmed.

---

## What I Would Do Differently

- **Use OpenTofu with native state encryption from day one.** Retrofitting it is harder than starting with it.
- **Build a Kustomize restore overlay.** Restoring a CNPG database currently means committing a `restore-db.yaml` before the first ArgoCD sync. An `overlays/restore/` that patches the base cluster definition would be safer and repeatable.
- **Add CI validation** (`kustomize build` + `kubeconform`) on every PR to the GitOps repo.
- **Use TTL-bound AppRole secret IDs with rotation.**
- **Use a DevContainer for the bootstrap environment.** Stale Helm repos on the provisioning machine caused a drill failure; pinned tool versions would remove that class of problem.

---

## What's Next

In rough priority order:

1. **Network policies:** generate a baseline from Hubble flow data, then harden progressively
2. **Secrets hygiene:** TTL-bound AppRole secret IDs; consider codifying OpenBao configuration
3. **CI validation:** `kustomize build` + `kubeconform` on GitOps PRs
4. **Upgrade rehearsal:** documented Talos and Kubernetes version upgrades
5. **Replace MinIO:** evaluate alternatives, since zvol cloud replication coverage is unconfirmed

---

## What This Demonstrates

The point of this project is not the tool list. Talos, ArgoCD, Cilium, and OpenBao are tools. The point is the *habits*:

- **I drill.** Not once and not untimed. Drill 2 found three bugs; drill 3 validated the fixes.
- **I document gaps I have not fixed.** Unencrypted state, non-expiring secret IDs, and missing network policies are written down, not hidden.
- **I iterate on measurements.** 70 minutes to 33 minutes is data, not a guess.
- **I write things down.** Runbooks, gap analysis, and architecture decisions, because a system only one person can operate is not production-grade.

Building with production habits in a homelab means accepting that you will never have all the time or resources to do everything right — but you can be honest about what is not done, have a plan for it, and keep iterating.
