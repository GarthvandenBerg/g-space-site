---
title: GitOps with ArgoCD: App-of-Apps and Sync Waves
date: 2026-11-22
readTime: 9
tags: kubernetes, gitops, homelab
summary: How I use ArgoCD to manage my cluster from Git, and the sync wave race condition that broke my rebuild drill.
---

If you have ever managed a Kubernetes cluster by manually running `kubectl apply` commands from your laptop, you already know how it ends. You tweak a deployment here, edit a ConfigMap there, forget to save your changes in a file, and six months later you have no clue what is actually running in your cluster.

GitOps fixes that by making your Git repository the absolute source of truth. Every deployment, secret definition, and network policy is saved in a repo. ArgoCD sits inside the cluster watching that repo, and the moment a commit lands on `main`, it pulls the changes and applies them automatically.

It sounds simple on paper, but when you stand up a whole cluster from zero, Kubernetes tries to apply everything at the exact same time. If you don't force things to wait their turn, the whole deploy crashes into a wall of missing CRD errors. 

Here is how I use ArgoCD's app-of-apps pattern and sync waves to keep things running smoothly, including a nasty timing bug I only caught during a disaster recovery drill.

## App-of-apps: one root to run them all

Instead of pointing ArgoCD at ten different folders by hand, I use what is called the app-of-apps pattern. 

When Terraform bootstraps my cluster, it applies just one single manifest to ArgoCD: `root-app.yaml`. 

That root application doesn't run any actual software. Its only job is to point at a directory in my Git repo that contains the child applications:

- `infrastructure-staging`: The foundational plumbing like Cilium networking, cert-manager, External Secrets Operator, Longhorn storage, and CloudNativePG.
- `apps-staging`: The user-facing software like Immich, Authentik, the personal websites, and a Minecraft server.
- `monitoring-staging`: Prometheus, Grafana, and Coroot.
- `apps-prod`: Prepared and committed in the repo, but kept dormant for now.

This split is great because it keeps infrastructure separate from user apps. If I need to upgrade an operator in `infrastructure-staging`, I don't have to touch or risk breaking my application manifests.

## Self-healing: letting Git be the boss

All my child applications run with automated syncing, pruning, and self-healing turned on:

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
```

`automated` means ArgoCD detects when a commit hits the repo and starts syncing without me having to push buttons in a web UI.

`prune: true` ensures that when I delete a YAML file from Git, Kubernetes actually deletes the resource from the cluster. Without this, old pods and services linger around forever like digital ghosts.

`selfHeal: true` is the strict parent in the setup. If I get lazy late at night and run `kubectl edit` to hack a live ConfigMap in the cluster, ArgoCD notices within minutes that the cluster doesn't match Git, and it overwrites my manual tweak back to what is in the repository. It forces discipline: if a change matters, you commit it to Git.

## Two sync options you really need

Inside my infrastructure applications, I add two specific sync options that save a ton of headaches:

```yaml
syncOptions:
  - ServerSideApply=true
  - SkipDryRunOnMissingResource=true
```

`ServerSideApply=true` stops client-side `kubectl apply` from running out of annotation memory when dealing with massive custom resource definitions like Prometheus.

`SkipDryRunOnMissingResource=true` is the magic setting that makes sync waves work. By default, ArgoCD tries to dry-run validate every single resource before touching anything. If an operator's CRD hasn't been installed yet, ArgoCD throws an error saying it doesn't recognize the resource kind and bails out. This option tells ArgoCD to skip validating resources whose CRDs aren't installed yet, allowing it to progress through early waves and install those CRDs first.

## Sync waves: stopping Kubernetes from rushing

Kubernetes is built to reconcile things concurrently. If you throw a big folder of manifests at it all at once, it will happily try to start your Postgres database before the storage operator is alive, or deploy an `ExternalSecret` before the secrets controller exists. 

ArgoCD fixes this with sync waves. You add a simple annotation to your resources, and ArgoCD sorts them into waves, waiting for each wave to be completely healthy before moving on to the next one:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-9"
```

Here is the exact wave order I use across my cluster:

Wave -10: Namespaces. Everything needs a namespace to live in, so these have to come first.

Wave -9: Custom Resource Definitions (CRDs). The cluster needs to know what these new resource types are before operators or apps use them.

Wave -8: Core operators like External Secrets Operator, CloudNativePG, Longhorn, and Coroot.

Wave -6: The `ClusterSecretStore` pointing to my OpenBao vault.

Wave -5: `ExternalSecret` definitions. Now that the secret store is ready, ESO can reach out and pull secrets into memory.

Wave 2: Databases and storage. Passwords are in place, so CloudNativePG clusters can safely initialize.

Wave 3: Credential-sync jobs that need databases running before they do their work.

Wave 5: User applications like Immich and Authentik. All infrastructure, databases, and secrets are healthy and waiting for them.

Wave 10: Validation checks and post-deployment cleanup.

The negative numbers aren't special; ArgoCD just runs them in ascending order. Starting at negative numbers leaves plenty of room in the middle if you need to slide a new step between waves later.

## The bug that broke my 70-minute rebuild drill

During a full teardown drill in mid-November, I wiped all five nodes and ran `terraform apply` to see what would break. 

The build sailed through provisioning VMs and installing Cilium, but stalled hard when ArgoCD tried to sync the infrastructure app. The logs started spewing errors:

```text
no matches for kind "ExternalSecret" in version "external-secrets.io/v1beta1"
```

The External Secrets Operator Helm chart was in wave -8, but the Helm chart's custom resource definitions were also being installed in wave -8. Because ArgoCD was processing that wave, it tried to create `ExternalSecret` custom resources before the CRDs were finished registering with the Kubernetes API.

The crazy thing was that this bug was completely invisible while the cluster was running day-to-day. In normal operation, the CRDs had been installed months ago, so any manifest update synced fine. The race condition only reared its ugly head when standing up the entire cluster from complete scratch.

The fix was straightforward: I explicitly annotated the ESO CRD resources to install in wave -9, a full wave before the operator and secrets. That guaranteed the API server recognized the custom resource kinds before anything tried to use them.

When I ran the drill again a few days later, that error was completely gone, and the rebuild finished cleanly in 33 minutes.

## Automated updates with Renovate

To keep packages and image tags up to date, I run Renovate as a Kubernetes CronJob every two hours. 

Renovate connects to GitHub using a token pulled from OpenBao via an `ExternalSecret`. It scans my repository for container image tags and Helm chart versions. When an update drops, it opens a pull request with the release notes. 

All I have to do is review the diff, click merge, and ArgoCD automatically syncs the new version into the cluster.

## Honest gaps I still need to fix

There are still a couple of things in this GitOps setup that aren't where I want them to be:

There is no pull request testing. Right now, if I commit a typo in a YAML file or an invalid Kustomize overlay, GitHub just lets it merge. I only find out that something is broken when ArgoCD lights up red in the web UI. I need to set up a GitHub Actions workflow with `kubeconform` and `kustomize build` to catch errors before they merge.

Patch updates aren't auto-merged. Because I don't have automated CI checks testing the manifests on PRs, I can't safely let Renovate auto-merge minor patches. I have to click merge manually for every single update.

OpenBao is outside GitOps. While everything in Kubernetes is declared in code, the OpenBao instance holding my secrets was built manually. If that VM dies, it has to be restored from backup rather than reconciled from a repository.

## What GitOps actually teaches you

Setting up GitOps with sync waves takes some effort upfront. You spend hours wrestling with Helm chart dependencies, figuring out which CRDs need to register first, and fixing race conditions.

The payoff is that you stop treating your cluster like a delicate pet. If something gets corrupted or a node dies, you don't spend hours trying to nurse it back to life. You just pull down the manifests from Git and let the controllers rebuild the cluster for you.
