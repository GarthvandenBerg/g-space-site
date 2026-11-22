---
title: Automating Image Updates with Renovate and ArgoCD
date: 2026-08-25
readTime: 7
tags: kubernetes, gitops
summary: A look into pushing static build artifacts to container registries and triggering seamless GitOps deployments via Renovate pull requests — including how Renovate runs as a Kubernetes CronJob, how secrets stay out of Git, and where the current limitations are.
---

Automating container deployments using GitOps avoids manual `kubectl apply` commands while keeping every change auditable in Git. This post covers how **Renovate Bot** and **ArgoCD** work together in my homelab cluster — specifically the self-hosted setup, the secret management wiring, and the honest trade-offs that remain.

## Why Self-Host Renovate?

Renovate is commonly run as a GitHub App or through the hosted Mend SaaS service. For a homelab with private repositories and secrets stored in **OpenBao**, neither option was ideal. Running Renovate as a **Kubernetes CronJob** keeps the entire update pipeline inside the cluster, using the same secret management infrastructure as everything else.

The Renovate pod has no long-lived credentials baked into it. The GitHub token is sourced from **OpenBao** via the **External Secrets Operator (ESO)**, the same path used for Grafana admin credentials, Cloudflare tokens, and database passwords across the cluster.

## How Renovate Is Deployed

Renovate runs in the `renovate-system` namespace as a **Kubernetes CronJob** that fires every two hours:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: renovate
  namespace: renovate-system
spec:
  schedule: "0 */2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: renovate
              image: ghcr.io/renovatebot/renovate
              # ... env, volumeMounts
```

The Renovate configuration itself lives in a **ConfigMap** that is mounted into the container at runtime. This keeps the config version-controlled alongside everything else without embedding it into the image or the CronJob spec directly.

### Secrets Without Hardcoding

The GitHub token Renovate needs to open pull requests is stored in OpenBao at `secret/staging/renovate`. An **ExternalSecret** resource pulls it into the cluster as a Kubernetes Secret:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: renovate-github-token
  namespace: renovate-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-cluster-secret-store
    kind: ClusterSecretStore
  target:
    name: renovate-github-token
  data:
    - secretKey: token
      remoteRef:
        key: secret/data/staging/renovate
        property: github_token
```

The `ClusterSecretStore` authenticates to OpenBao using **AppRole**, with the `role_id` committed in Git and the `secret_id` injected at bootstrap. No token ever appears in a manifest or in Terraform state — the ESO controller fetches it at runtime and refreshes every hour.

## Tracking Container Images with Inline Annotations

For **Helm chart** updates, Renovate discovers versions automatically by scanning `Chart.yaml` and `values.yaml` files. For raw Kubernetes manifests that reference container images directly, Renovate needs a hint.

The pattern is a one-line comment immediately above the image field:

```yaml
# renovate: datasource=docker depName=cloudflare/cloudflared
image: cloudflare/cloudflared:2024.6.1
```

This tells Renovate which datasource and package name to use when checking for updates. When a new version of `cloudflare/cloudflared` is published to Docker Hub, Renovate opens a pull request that updates the tag on that line. The comment itself stays untouched — it persists across updates and continues directing future scans.

In the same repository, Renovate manages both **Helm chart versions** and **container image tags**, so a single tool covers the full dependency surface.

## The PR-First Update Flow

When Renovate finds an update — whether a new Helm chart version or a new container image tag — the flow is:

1. **Renovate opens a PR** on GitHub with the diff (e.g., `cloudflared: 2024.6.1 → 2024.7.0`).
2. **Review**: the engineer reads the changelog, checks whether the update is breaking, and approves.
3. **GitHub Actions** run security and lint checks against the PR branch.
4. **Merge to `main`**: once checks pass and review is done.
5. **ArgoCD detects the drift**: with `automated` sync, `selfHeal: true`, and `prune: true` enabled, ArgoCD continuously compares the live cluster state against `main`. After the merge, it detects the diff and applies the updated manifest to the cluster — no manual `kubectl` command needed.

```
[Renovate CronJob] → [GitHub PR] → [Review + CI] → [Merge to main]
                                                          ↓
                                               [ArgoCD detects diff]
                                                          ↓
                                               [ArgoCD syncs cluster]
```

This gives every image update an explicit, human-reviewed audit trail. The Git log on `main` is the source of truth for what version of every workload is running in the cluster.

## What selfHeal Actually Means

ArgoCD's `selfHeal: true` policy does two things:

- **After a merge**: ArgoCD reconciles the new desired state from Git.
- **After drift**: if someone runs a `kubectl apply` or `kubectl edit` directly against the cluster, ArgoCD reverts it back to what Git says.

This makes the PR review step non-optional in practice. The only way to change what runs in the cluster is to change what is in `main` — either through a Renovate PR or a manually authored one. Direct cluster mutations don't survive the next sync cycle.

## Current Limitations

This setup works well but has two documented gaps worth being honest about:

**No auto-merge for patch updates yet.** Renovate supports automatically merging patch-level version bumps after CI passes. That is not enabled here — every PR still requires a manual merge. The blocker is that CI does not yet validate Kubernetes manifests (no `kubeval`, `kubeconform`, or dry-run apply step), so it is not safe to auto-merge without that gate in place. A bad manifest would only be caught at ArgoCD sync time.

**No manifest validation in CI.** If a Renovate PR introduces a structurally invalid manifest — for example, a Helm values change that generates bad YAML — the GitHub Actions checks will pass, the PR can be merged, and the problem surfaces when ArgoCD tries to apply it. Adding a `kubeconform` or `helm template | kubeval` step to CI is the fix, but it is not implemented yet.

Both are known gaps. The honest trade-off is: the pipeline is fast to set up and covers the common case well, but it shifts some validation responsibility to the ArgoCD sync step rather than catching errors earlier.

## What This Demonstrates

Running Renovate as a CronJob rather than a SaaS service means the dependency update pipeline is:

- **Fully self-contained** — no external service has access to the GitHub token or the repository.
- **Consistent with the rest of the secret management** — same OpenBao/ESO path as every other credential in the cluster.
- **GitOps-native** — every change, whether a Helm chart bump or a container image tag update, goes through a PR and an ArgoCD sync. No imperative paths exist.

The inline annotation pattern for image tracking (`# renovate: datasource=docker depName=...`) is a small but important detail: it makes raw YAML manifests as trackable as Helm charts, without requiring a separate configuration file per image.

For a homelab used as a learning environment and portfolio project, the PR-per-update workflow also creates a natural history of what changed, when, and why — which is exactly what you want when you are demonstrating operational discipline to a potential employer.
