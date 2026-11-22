---
title: Lessons Learned — Reflections from Building a Production-Habits Homelab
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, infrastructure
summary: After three full cluster rebuild drills, two Proxmox hosts, and one honest gap analysis, here's what I actually learned building a production-grade homelab — and what I'd do differently.
---

When I started this project, I had a clear-enough goal: build a Kubernetes homelab that behaved less like a weekend experiment and more like something I'd be comfortable putting on a résumé. Run real workloads, practice disaster recovery, treat GitOps as the source of truth, and document the gaps I didn't fix. What I didn't expect was how much the *process* of operating it — not just building it — would be where the real learning happened.

This post is a retrospective. It covers what I actually learned (which is not always what I set out to learn), what I'd change if I started over, and where this is heading.

---

## What I Set Out to Do

The goal was a **five-node Talos Linux cluster** running on two Proxmox VE hosts (`kirk` and `picard`), bootstrapped entirely from code, with GitOps via ArgoCD managing the application layer, and secrets managed through OpenBao with External Secrets Operator. Infrastructure as Code all the way down — Terraform provisions VMs, applies Talos configs, bootstraps etcd, and hands off to ArgoCD.

I wanted the cluster to be *recoverable*, not just *running*. That meant actual disaster recovery drills, not just theoretical runbooks.

What I didn't fully appreciate at the start was how many of the most valuable lessons would come not from getting things working, but from watching them break in controlled conditions.

---

## The Six Lessons That Actually Stuck

### 1. Dependency ordering is everything

This sounds obvious. It is obvious — until you're staring at a CRD-not-found error because your operator deployed before its own CRDs were registered.

The ArgoCD sync wave system is the right tool for this, but you have to *commit* to it. My wave assignments:

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

This ordering isn't just aesthetic. It reflects real dependency chains. The ExternalSecrets operator cannot function before the ESO CRDs exist. The `ClusterSecretStore` cannot authenticate before OpenBao is reachable. CNPG clusters cannot start before their credential secrets are populated. Getting this wrong produces errors that look like configuration bugs but are actually *timing* bugs.

The same principle applies in Terraform: VM creation → Talos config application → etcd bootstrap → API readiness → Cilium → Longhorn → ArgoCD → root app. Each step depends on the previous one completing successfully, and the ordering has to be explicit. And on recovery, the sequence matters just as much: network and DNS first, then TrueNAS, then OpenBao unsealed, then Terraform state accessible, then `terraform apply`.

**Key takeaway:** In distributed systems, implicit ordering assumptions will eventually fail. Make ordering explicit everywhere: sync waves, Terraform `depends_on`, recovery runbooks.

### 2. Test your restores — the drills found real bugs

I ran three full cluster rebuild drills:

- **October 2026** — untimed, low bar, more of a proof-of-concept
- **November 19, 2026** — timed, ~70 minutes, found **three real bugs**: the Talos image on the Proxmox host was stale, Helm repos on the provisioning machine hadn't been updated, and the ESO CRD sync wave was misconfigured, causing ExternalSecrets to fail on a clean apply
- **November 22, 2026** — ~33 minutes, clean except for a manual nudge needed on the monitoring stack

That 37-minute improvement between the second and third drills came entirely from fixing the bugs the second drill surfaced. Without the timed drill, those bugs would have remained latent — they don't surface during normal operation, only during a fresh bootstrap.

The November 19 ESO bug is a good example. External Secrets Operator was deploying but its CRDs weren't ready yet because the sync wave was set incorrectly. Everything *looked* fine in steady state because the CRDs were already present from a previous install. A clean rebuild exposed it immediately.

**Key takeaway:** An untested restore is not a backup. The October drill gave me false confidence. The November 19 drill gave me data. Timed drills are qualitatively different from untimed ones.

### 3. Durable state outside the cluster changes what "disaster" means

Because manifests live in Git, database WAL and base backups go to MinIO S3, photos live on TrueNAS with ZFS snapshots, and secrets are in OpenBao (outside the cluster, backed up via Proxmox Backup Server and Raft snapshots) — a total cluster loss is a **rebuild event**, not a catastrophe.

I deliberately chose *not* to back up etcd. The cluster's desired state is in Git. The data is in S3 and NFS. Etcd is a runtime artifact. This is a philosophical choice that simplifies recovery: `terraform apply` reconstitutes the cluster, ArgoCD reconciles the application layer, and the databases restore from Barman/WAL.

The 33-minute rebuild time reflects this. It's not 33 minutes of heroic recovery effort — it's mostly waiting for Terraform to provision VMs and for ArgoCD to sync.

**Key takeaway:** Durable state placement is an architectural decision, not an operational detail. Knowing *exactly* what lives where — and verifying it with drills — is what makes recovery predictable.

### 4. The immutable OS removes an entire class of problems — and raises the debugging skill floor

**Talos Linux** has no SSH, no package manager, no shell access in the traditional sense. Every configuration change goes through the Talos API (`talosctl`), every node config change is a declarative patch. This eliminates configuration drift almost entirely — you cannot log in and `apt install` something that isn't captured in code.

But that tradeoff has a cost. When something goes wrong, your diagnostic toolkit is `talosctl logs`, `talosctl read`, and careful reading of patch files. If you're used to `ssh node && journalctl -f`, the learning curve is real. The immutable OS doesn't make debugging easier — it makes it *different*, and in some ways more demanding. You have to understand the system at a deeper level because you can't paper over problems with ad-hoc changes.

**Key takeaway:** Immutability is a genuine operational improvement, but it front-loads expertise requirements. The debugging skill floor is higher, and that's worth knowing going in.

### 5. The two-layer approach (Terraform → ArgoCD) works, but creates a seam you must keep consistent

Terraform owns the infrastructure layer: VMs, Talos config, the initial Cilium and ArgoCD installs. ArgoCD owns everything above that. The seam between them is deliberate — Terraform should not be managing application manifests, and ArgoCD should not be provisioning VMs.

But the seam creates consistency obligations. ArgoCD's repo credentials are injected as a Kubernetes Secret by Terraform at bootstrap. The OpenBao AppRole `secret_id` is passed as a Terraform variable. If those values drift between what Terraform created and what ArgoCD or ESO expects, the system breaks in ways that aren't immediately obvious.

The Cilium timing issue is illustrative: Cilium was installed by Terraform via Helm, but the CRDs weren't reliably ready when Terraform moved on to the next step. The fix was a `time_sleep` of 300 seconds after Cilium install — an ugly but pragmatic solution that reflects how difficult it is to reliably wait for CRD readiness in Terraform without a proper polling mechanism.

**Key takeaway:** Clean architectural boundaries are good. But boundaries have interfaces, and interfaces need to be explicit, documented, and tested. The Terraform→ArgoCD handoff is not a one-time event — it's something the rebuild drill exercises every time.

### 6. Race conditions in distributed systems are real, even at homelab scale

I hit three distinct race conditions during this build:

- **Cilium CRD timing** — CRDs not ready when subsequent resources tried to reference them (fixed with `time_sleep`)
- **ESO CRD sync wave** — ExternalSecrets operator attempted to register resources against CRDs that hadn't synced yet
- **API readiness polling** — Terraform had to wait for the Kubernetes API to become available after etcd bootstrap before it could proceed

None of these would have appeared in a system that starts up slowly and sequentially. Kubernetes parallel reconciliation surfaces them quickly. The homelab scale doesn't protect you — if anything, with fewer nodes and less headroom, timing margins are tighter.

---

## Known Gaps (Being Honest)

I'd rather document these than pretend they don't exist:

- **No NetworkPolicy or CiliumNetworkPolicy written yet.** Hubble is enabled but not being used for flow visibility or policy generation. The cluster is running with flat internal networking.
- **Terraform state is unencrypted on the NAS.** The state file contains sensitive values. This is a known risk.
- **OpenBao configured by hand.** The OpenBao instance is not codified with Terraform or OpenTofu. It's the most manual component in the stack.
- **AppRole `secret_id_ttl=0` (never expires).** The plan is TTL-bound secret IDs with rotation; this hasn't been implemented yet.
- **No CI validation.** PRs to the GitOps repo are not automatically validated with `kustomize build` or `kubeconform`. Errors are caught at sync time, not at PR time.
- **Off-site NAS restore never tested.** MinIO zvol coverage in cloud replication is also unconfirmed.

---

## What I'd Do Differently

**Use OpenTofu with state encryption from day one.** OpenTofu supports native state encryption. Starting without it and retrofitting it later is harder than it needs to be. This should have been a day-one requirement.

**Build a Kustomize restore overlay instead of manual manifest swapping.** Right now, restoring a CNPG database requires committing a `restore-db.yaml` manifest before the first ArgoCD sync. That's fragile and manual. A proper restore overlay — something like `overlays/restore/` that patches the base cluster definition — would make this safer and more repeatable.

**Add CI validation (kustomize build / kubeconform) on PRs.** Every merge to the GitOps repo should validate that manifests are well-formed before ArgoCD tries to apply them. This is table stakes for a team environment and good practice even solo.

**TTL-bound AppRole secret IDs with rotation.** The current `secret_id_ttl=0` is a known weakness. Rotation — even semi-automated — is the right answer.

**DevContainer for the bootstrap environment.** I've had to manually update Helm repos on the provisioning machine between drills. A DevContainer with pinned tool versions would make the bootstrap environment reproducible and eliminate that class of drill failure.

---

## What's Next

The roadmap items in rough priority order:

1. **Network policies** — Start generating them from Hubble flow data, then harden progressively
2. **Secrets hygiene** — TTL-bound AppRole secret IDs; consider codifying OpenBao config
3. **CI validation** — `kustomize build` + `kubeconform` on GitOps PRs
4. **Upgrade rehearsal** — Talos and Kubernetes version upgrades done in a controlled, documented way
5. **Migrate from MinIO** — MinIO's zvol cloud replication coverage is unconfirmed; evaluate alternatives

---

## What This Demonstrates

If you're a hiring manager reading this: the point of this project isn't the technology stack. Talos, ArgoCD, Cilium, and OpenBao are tools. The point is the *habits*.

- **I drill.** Not just once, and not just untimed. The November 19 drill found three bugs. The November 22 drill validated the fixes. That's the loop.
- **I document gaps I haven't fixed.** The unencrypted state, the never-expiring secret IDs, the absent network policies — these are in the README, not hidden. Knowing your limitations is a prerequisite to improving them.
- **I iterate based on real data.** The 37-minute improvement between the second and third drills is not an estimate. It's a measurement.
- **I write things down.** Runbooks, gap analysis, architecture decisions, known limitations. A system only one person can operate isn't production-grade.

Building with production habits in a homelab context means accepting that you'll never have *all* the resources or time to do everything right — but you can be honest about what's not done, have a plan for it, and keep iterating. That's the job.
