---
title: GitOps with ArgoCD — App-of-Apps and Sync Waves
date: 2026-11-22
readTime: 9
tags: kubernetes, gitops, homelab
summary: How I use ArgoCD's app-of-apps pattern and sync waves to manage a Talos Linux homelab cluster declaratively — including a real CRD-ordering bug caught during a timed disaster-recovery drill.
---

**TL;DR:** This post covers how I structure GitOps for my five-node Talos Linux cluster using ArgoCD's app-of-apps pattern, Kustomize overlays, and sync waves to enforce strict dependency ordering between infrastructure components. The sync wave design was validated (and partially corrected) during a timed full-cluster rebuild drill on November 19, 2026.

---

## What GitOps Actually Means Here

**GitOps** is the practice of treating a Git repository as the single source of truth for cluster state. Every resource — namespaces, operators, applications, secrets configuration — is declared in YAML, committed to Git, and reconciled automatically by a controller (in this case, **ArgoCD**).

The practical benefits for a homelab running production-grade workloads:

- **Auditability:** every change is a commit with a timestamp and message. No `kubectl apply` commands run from a laptop and forgotten.
- **Declarative:** the desired state is always readable. If you want to know what should be running, read the repo — not the cluster.
- **Recoverability:** during a full cluster rebuild, ArgoCD reconciles everything from Git. The cluster is a runtime artifact of the repository, not the other way around.

That last point is what motivated investing in this setup seriously. My disaster-recovery principle is: *rebuild cluster from code, restore durable data from backups.* GitOps is what makes the "from code" part credible.

---

## App-of-Apps: One Root to Rule Them All

ArgoCD's **app-of-apps pattern** uses a single root `Application` manifest to spawn all other `Application` resources. Terraform bootstraps the cluster and applies one file — `root-app.yaml` — to ArgoCD at the end of provisioning. From that point, ArgoCD owns everything.

The root app points to a path in the GitOps repo that contains child `Application` manifests. Right now it spawns four children:

- **`infrastructure-staging`** — Cilium configs, cert-manager, External Secrets Operator, CNPG operator, Longhorn, the Cloudflare gateway operator, and all the foundational plumbing
- **`apps-staging`** — user-facing workloads: Immich, Authentik, personal websites, Minecraft, Renovate
- **`monitoring-staging`** — kube-prometheus-stack, Grafana, Coroot
- **`apps-prod`** — defined and committed, but *not deployed*; production overlay is prepared and waiting

This separation keeps infrastructure lifecycle distinct from application lifecycle. An operator upgrade in `infrastructure-staging` doesn't require touching `apps-staging`. The root app itself has no business logic — it's purely a pointer.

---

## Kustomize Overlays: Base, Staging, Production

Every component follows the same directory layout:

```
base/          # common manifests shared across environments
staging/       # patches and values specific to the staging cluster (deployed)
production/    # patches for production (committed, not yet deployed)
```

The **`base/`** layer defines the resource skeletons. The **`staging/`** overlay patches in environment-specific values: replica counts, resource limits, storage sizes, image tags, and secret references. The **`production/`** overlay exists and is maintained, but the ArgoCD `Application` for production is not live yet.

This separation of concerns means staging and production share the same base definitions — drift between environments is explicit and tracked in Git, not hidden in one-off `kubectl` edits.

---

## Sync Policy: Automated, Prune, Self-Heal

All child Applications use the same sync policy:

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
```

What each flag does:

- **`automated`:** ArgoCD polls the repo and syncs automatically when it detects drift. No manual `argocd app sync` needed for routine changes.
- **`prune: true`:** resources removed from Git are deleted from the cluster. Without this, deleted manifests leave zombie resources running indefinitely.
- **`selfHeal: true`:** if someone manually edits a resource in the cluster (a `kubectl edit` on a ConfigMap, for example), ArgoCD reverts it to the Git-declared state. Git wins.

The combination means the cluster continuously converges toward Git. The trade-off is that any manual cluster change is immediately overwritten — which is the point.

---

## ServerSideApply and SkipDryRunOnMissingResource

The `infrastructure-staging` and `monitoring-staging` apps both have two additional sync options:

```yaml
syncOptions:
  - ServerSideApply=true
  - SkipDryRunOnMissingResource=true
```

**`ServerSideApply=true`** switches ArgoCD from client-side `kubectl apply` to Kubernetes server-side apply. This matters for large or complex resources (like `kube-prometheus-stack` CRDs) where client-side apply hits annotation size limits and fails. Server-side apply also gives cleaner field ownership semantics when multiple controllers touch the same resource.

**`SkipDryRunOnMissingResource=true`** tells ArgoCD not to perform a dry-run validation for resource types whose CRDs don't exist yet at sync time. Without this, ArgoCD fails early with a "no matches for kind" error when it encounters a CRD-defined resource before the CRD itself has been applied. This option is what makes sync waves viable — it allows ArgoCD to proceed through waves without aborting on resources from later waves whose types aren't registered yet.

---

## Sync Waves: Solving the Dependency Ordering Problem

Kubernetes has no native concept of ordered resource application. If you apply a Helm chart for an operator and an `ExternalSecret` custom resource in the same `kubectl apply`, you'll likely get a failure because the CRD for `ExternalSecret` isn't registered yet.

ArgoCD solves this with **sync waves**: an annotation on each resource that tells ArgoCD to wait for all resources in wave N to be healthy before starting wave N+1.

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-9"
```

The wave table for this cluster:

| Wave | Contents | Why here |
|------|----------|----------|
| **-10** | Namespaces | Everything else depends on namespaces existing |
| **-9** | CRDs | Operators need their CRDs registered before they install |
| **-8** | Operators (ESO, CNPG, Coroot, cfgate, etc.) | Operators must be running before their CRs are created |
| **-6** | `ClusterSecretStore` | ESO must be running before its store can be registered |
| **-5** | `ExternalSecret` resources | Store must exist before secrets can be fetched |
| **2** | CNPG clusters + storage | Secrets (DB credentials) must exist first |
| **3** | Credential-sync Jobs | Run after DBs are up, before apps need credentials |
| **5** | Applications (Immich, Authentik, etc.) | All infrastructure ready |
| **10** | Post-deploy / validation resources | Final checks after everything is running |

The negative wave numbers aren't special — ArgoCD just processes waves in ascending order, so -10 runs before -9 before 0 before 10.

---

## Real Bug: ESO CRDs Missing at Sync Time

During the **November 19, 2026 rebuild drill** (full cluster teardown and rebuild, timed at ~70 minutes), ArgoCD stalled on the `infrastructure-staging` sync with an error similar to:

```
no matches for kind "ExternalSecret" in version "external-secrets.io/v1beta1"
```

The External Secrets Operator (ESO) was assigned a sync wave, but the **CRDs shipped by the ESO Helm chart** were not being applied before ArgoCD attempted to process `ExternalSecret` custom resources.

The root cause: the ESO operator Helm chart and its CRDs were in the same wave as the operator itself (wave -8), but the `ClusterSecretStore` and `ExternalSecret` resources were processed before the chart's CRDs had fully registered with the API server.

**Fix:** Explicitly annotate the ESO CRD resources (or the Helm chart's CRD Job, if using `--set installCRDs=true`) at wave **-9**, one wave before the operator. This guarantees the API server has registered `ExternalSecret`, `ClusterSecretStore`, and related types before ArgoCD tries to reconcile any of them.

This is precisely the class of bug that sync waves are designed to prevent — but the design only works if the wave assignments are correct. The drill found the gap, the fix is now committed, and the **November 22, 2026 drill** completed cleanly in ~33 minutes.

> **Takeaway:** The wave table is only as good as the annotations. Test it with a real rebuild, not just a mental model.

---

## Renovate: Automated Dependency Updates

**Renovate** runs as a Kubernetes `CronJob` in the `renovate-system` namespace, triggering every 2 hours. Its GitHub token is sourced from OpenBao via an `ExternalSecret` — it's just another workload consuming the secret infrastructure.

When Renovate detects a new version of a Helm chart or container image, it opens a pull request against the GitOps repo. The engineer reviews and merges. ArgoCD picks up the merge and syncs the update automatically.

One inline annotation example for the Cloudflare tunnel image:

```yaml
# renovate: datasource=docker depName=cloudflare/cloudflared
image: cloudflare/cloudflared:2025.4.0
```

Renovate reads that annotation and targets just that image tag for updates, leaving the surrounding YAML untouched.

---

## Current Limitations

Being honest about what isn't done yet:

- **No CI validation on PRs.** There's no pipeline running `kustomize build` or `kubeconform` against pull requests. A malformed overlay could merge and cause an ArgoCD sync failure. This is the most significant gap.
- **No auto-merge for patch updates.** Renovate opens PRs; a human merges them. Patch-level updates (security fixes) could safely auto-merge with a passing CI check — but without CI, auto-merge would be risky.
- **OpenBao not codified.** The OpenBao vault is configured by hand. Its policy, auth methods, and secret paths aren't managed by Terraform or any IaC tool. A vault rebuild would require manual reconstruction.
- **No NetworkPolicy defined.** Hubble (Cilium's flow visibility layer) is enabled but unused. No `CiliumNetworkPolicy` resources have been written yet — east-west traffic is unrestricted within the cluster.

---

## Lessons Learned

**On sync wave ordering:** Assign waves to *types* of resources, not individual resources. All CRDs go in wave -9, all operators in wave -8, regardless of which application they belong to. Mixing concerns within a wave creates subtle ordering bugs that only surface during a cold rebuild.

**On idempotency:** Every resource in Git must be safe to re-apply. Avoid `generateName`, avoid resources that mutate themselves on first run, and test bootstrap with a real teardown. The rebuild drills cut time from untimed → 70 min → 33 min precisely because idempotency issues were found and fixed.

**On `selfHeal=true`:** It's not just a convenience feature — it's a correctness guarantee. Any manual cluster change that isn't reflected in Git will be reverted. This forces discipline: if a change is worth making, it's worth committing.

**On the app-of-apps pattern:** The pattern scales well. Adding a new workload means adding a manifest to `apps-staging/` and committing. ArgoCD reconciles it without touching anything else. The root app never needs to change.

**On disaster recovery validation:** A GitOps setup that has never been rebuilt from scratch is an untested hypothesis. The rebuild drills turned a theoretical DR procedure into a measured, repeatable process — and each drill found at least one real bug that would have extended a real outage.
