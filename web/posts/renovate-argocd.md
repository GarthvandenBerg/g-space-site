---
title: Automating Image Updates with Renovate and ArgoCD
date: 2026-08-25
readTime: 5
tags: kubernetes, gitops
summary: A look into pushing static build artifacts to container registries and triggering seamless GitOps deployments via Renovate pull requests.
---

Automating container deployments using GitOps avoids manual `kubectl apply` commands while keeping cluster configurations auditable in Git repositories.

By using **Renovate Bot**, dependencies and container image updates generate automated Pull Requests on GitHub. Once code review and GitHub Actions security scans pass, merging into main triggers ArgoCD to synchronize the cluster state.

This provides an explicit audit trail for every deployed image version.
