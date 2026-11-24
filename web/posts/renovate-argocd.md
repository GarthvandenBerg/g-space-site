---
title: Automating Image Updates with Renovate and ArgoCD
date: 2026-08-25
readTime: 7
tags: kubernetes, gitops
summary: How I run Renovate as a Kubernetes CronJob to keep Helm charts and container tags updated without giving SaaS tools access to my cluster.
---

Keeping container images and Helm charts updated in Kubernetes is one of those chores you always put off. You set up your cluster, everything is working, and three months later you realize you are running outdated software with known security patches sitting on GitHub.

The usual way people handle this is by connecting an external SaaS bot to their GitHub account. 

For my homelab, I didn't want an external service holding credentials to my private repos. I already had OpenBao running outside the cluster to manage secrets, so it made a lot more sense to self-host Renovate directly inside Kubernetes as a scheduled CronJob.

Here is how Renovate and ArgoCD work together to keep my cluster up to date, how secrets stay protected, and why I still review every pull request by hand.

## Running Renovate as a CronJob

Instead of running a heavy persistent server, Renovate runs inside the `renovate-system` namespace as a lightweight Kubernetes CronJob that fires every two hours:

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
```

The configuration for Renovate lives in a ConfigMap mounted into the container at runtime. That keeps the configuration version-controlled in Git without baking anything into custom container images.

## Keeping GitHub tokens out of Git

To open pull requests on GitHub, Renovate needs a personal access token. 

Instead of hardcoding that token or baking it into a secret file in Git, it lives inside OpenBao under `secret/data/staging/renovate`. 

An `ExternalSecret` resource tells the External Secrets Operator to pull that token from OpenBao and create a Kubernetes secret in the `renovate-system` namespace:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: renovate-github-token
  namespace: renovate-system
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: renovate-github-token
  data:
    - secretKey: token
      remoteRef:
        key: staging/renovate
        property: github_token
```

The Renovate pod grabs the token from the secret on startup, runs its checks, opens any needed PRs, and exits. No long-lived credentials sit exposed in the repository.

## Tracking raw container images with inline comments

For Helm charts, Renovate is smart enough to scan `Chart.yaml` and `values.yaml` files automatically. 

For raw Kubernetes manifests that reference container image tags directly, Renovate needs a small hint so it knows what to watch. 

You can add a simple one-line comment directly above the `image:` line:

```yaml
# renovate: datasource=docker depName=cloudflare/cloudflared
image: cloudflare/cloudflared:2024.6.1
```

Renovate reads that comment, checks Docker Hub for newer releases of `cloudflare/cloudflared`, and opens a pull request updating the tag. The comment stays in place, so future updates keep working without you having to reconfigure anything.

## The pull request flow

When Renovate finds an update for a Helm chart or container tag, the process works like this:

1. Renovate opens a pull request on GitHub with the version diff and release notes.
2. I review the PR on my phone or laptop to check if there are breaking changes.
3. Once I merge the pull request into `main`, ArgoCD detects the change.
4. ArgoCD pulls the updated manifest and rolls the new container out to the cluster.

Because ArgoCD runs with `selfHeal: true`, the only way to update a service is by merging a change into `main`. If you try to manually edit a pod image using `kubectl`, ArgoCD notices the drift and rolls it back to match Git.

## What is still missing

There are two shortcuts in this setup that I am working to improve:

Every update requires a manual click. Renovate supports automatically merging patch-level security updates, but I haven't turned that on yet. 

The reason I haven't turned on auto-merge is that I don't have automated manifest validation in GitHub Actions yet. If Renovate opens a PR with a Helm value change that breaks YAML syntax, GitHub would happily auto-merge it, and the error would only surface when ArgoCD crashed during sync. 

Once I add a `kubeconform` linting step to my GitHub Actions workflow, I can safely let Renovate auto-merge minor patch releases while keeping major upgrades manual.

## Why this workflow works so well

Self-hosting Renovate inside Kubernetes gives you the best of both worlds. 

You don't have to give third-party SaaS services access to your private repos, and your tokens stay secured in OpenBao. 

When you sit down at your computer, you don't have to manually hunt down version numbers across twenty different tools. You just review a list of clean pull requests with release notes attached, click merge, and let GitOps handle the rest.
