---
title: Hardening Unprivileged Nginx in Kubernetes
date: 2026-08-18
readTime: 8
tags: homelab, kubernetes
summary: Running non-root Nginx containers with strict security contexts, custom port bindings (8080), and read-only root filesystems.
---

Standard Nginx containers default to binding on privileged port 80 and execution under root UID 0. In hardened Kubernetes setups, strict security policies block root containers.

Using the official `nginxinc/nginx-unprivileged` base image allows serving traffic on port 8080 as UID 101. Combining this with `allowPrivilegeEscalation: false` creates a secure runtime profile.
