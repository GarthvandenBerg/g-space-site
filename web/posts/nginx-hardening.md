---
title: Hardening Unprivileged Nginx in Kubernetes
date: 2026-08-18
readTime: 8
tags: homelab, kubernetes
summary: Running non-root Nginx containers with strict security contexts, custom port bindings (8080), and read-only root filesystems.
---

Standard Nginx containers default to binding on privileged port 80 and execution under root UID 0. In hardened Kubernetes setups, strict security policies block root containers outright — and for good reason. This post walks through how to run Nginx properly in a security-conscious cluster: unprivileged base image, tight `securityContext` fields, `emptyDir` scratch volumes, and a ConfigMap-driven config pattern.

## Why Unprivileged Containers Matter

Kubernetes introduced [Pod Security Standards (PSS)](https://kubernetes.io/docs/concepts/security/pod-security-standards/) as the successor to PodSecurityPolicy. PSS defines three policy levels:

- **Privileged** — no restrictions, essentially the legacy default.
- **Baseline** — prevents the most obvious privilege escalations (host namespaces, privileged containers, etc.).
- **Restricted** — the strictest tier: requires non-root users, disallows privilege escalation, mandates read-only root filesystems, and drops all Linux capabilities.

If your namespace is labelled `pod-security.kubernetes.io/enforce: restricted`, any workload that doesn't satisfy the restricted policy is rejected at admission time — no warnings, just a hard `403`. That means you can't ship the stock `nginx:latest` image without modification.

Beyond PSS, running as root inside a container is a defence-in-depth failure point. If a vulnerability in Nginx (or in a served application) allows a container breakout, a root UID makes host compromise substantially easier, especially on nodes where the container runtime runs with elevated privileges.

## What Breaks With Standard Nginx

Try deploying `nginx:latest` under a restricted namespace with a minimal `securityContext`:

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
```

The pod will be admitted but it will immediately crash. Nginx's master process attempts to:

1. Bind to port **80** — a privileged port, requiring `CAP_NET_BIND_SERVICE` or UID 0.
2. Write PID files and cache data to `/var/run` and `/var/cache/nginx` — paths owned by root with restrictive permissions.
3. Fork worker processes that inherit the root UID.

The result is a `CrashLoopBackOff` with errors like `nginx: [emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)` in the logs. Even if you patch the port, the filesystem writes fail under a read-only root.

## The `nginx-unprivileged` Base Image

NGINX Inc. maintains [`nginxinc/nginx-unprivileged`](https://hub.docker.com/r/nginxinc/nginx-unprivileged) specifically for this scenario. Key differences from the standard image:

- Runs as **UID 101** (`nginx` system user) rather than root.
- Listens on **port 8080** by default.
- Ships with pre-adjusted directory permissions so the `nginx` user can write to `/var/cache/nginx` and `/var/run` at startup.

That last point is relevant — but as we'll see, a read-only root filesystem re-introduces the write problem, so we still need to handle scratch paths explicitly.

## The Full `securityContext`

For a restricted-compliant deployment, the container-level `securityContext` looks like this:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 101          # nginx-unprivileged UID
  runAsGroup: 101
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

Field by field:

| Field | Why it matters |
|---|---|
| `runAsNonRoot: true` | Admission webhook rejects the pod if the image would run as UID 0. |
| `runAsUser: 101` | Pins the UID explicitly; don't rely on the image default alone. |
| `allowPrivilegeEscalation: false` | Prevents `setuid`/`setgid` binaries inside the container from gaining new privileges. Sets the `no_new_privs` seccomp bit. |
| `readOnlyRootFilesystem: true` | Mounts the container's root filesystem as read-only. Any write to an un-mounted path fails immediately — a strong containment boundary. |
| `capabilities.drop: [ALL]` | Strips every Linux capability. Nginx doesn't need any to serve traffic on 8080 as a non-root user. |

## Handling Write Paths With `emptyDir`

Even with `nginx-unprivileged`, Nginx still needs to write to a few paths at runtime:

- `/tmp` — temporary files during request processing.
- `/var/cache/nginx` — proxy and fastcgi cache buffers.
- `/var/run` — the PID file (`nginx.pid`).

With `readOnlyRootFilesystem: true` these writes fail silently or loudly depending on the Nginx version. The fix is to mount ephemeral `emptyDir` volumes over each writable path:

```yaml
volumes:
  - name: nginx-tmp
    emptyDir: {}
  - name: nginx-cache
    emptyDir: {}
  - name: nginx-run
    emptyDir: {}

containers:
  - name: nginx
    image: nginxinc/nginx-unprivileged:1.27-alpine
    volumeMounts:
      - name: nginx-tmp
        mountPath: /tmp
      - name: nginx-cache
        mountPath: /var/cache/nginx
      - name: nginx-run
        mountPath: /var/run
```

`emptyDir` volumes live on the node's local disk (or memory if `medium: Memory` is set), are scoped to the pod's lifetime, and are writable by the container UID. They satisfy Nginx's runtime write requirements without punching holes in the read-only filesystem guarantee.

## ConfigMap-Driven Nginx Configuration

Because the root filesystem is read-only, you can't `kubectl exec` into the pod and edit `/etc/nginx/nginx.conf` in place. That's actually a feature — it forces configuration to be declarative. The idiomatic pattern is a ConfigMap mounted over `/etc/nginx/conf.d/`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  default.conf: |
    server {
      listen 8080;
      server_name _;

      location /healthz {
        return 200 'ok';
        add_header Content-Type text/plain;
      }

      location / {
        root /usr/share/nginx/html;
        index index.html;
      }
    }
```

Then in the pod spec:

```yaml
volumeMounts:
  - name: nginx-config
    mountPath: /etc/nginx/conf.d
    readOnly: true

volumes:
  - name: nginx-config
    configMap:
      name: nginx-config
```

The `readOnly: true` on the volume mount is an extra belt-and-suspenders measure — the config directory shouldn't be writable at runtime anyway. Rolling out a config change becomes a `kubectl apply` on the ConfigMap followed by a pod restart (or a Deployment rollout), giving you a full audit trail in Git.

## Kubernetes Pod Security Standards — Namespace Labels

To actually enforce these constraints cluster-wide, label your namespace:

```bash
kubectl label namespace <your-ns> \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest
```

With `enforce=restricted`, any pod that omits `runAsNonRoot`, leaves `allowPrivilegeEscalation` unset (it defaults to `true`), or tries to mount a writable root is rejected before it ever schedules. The `warn` and `audit` modes are useful during migration — they emit warnings or audit log entries without blocking, letting you find non-compliant workloads before flipping to `enforce`.

Note that `baseline` stops short of requiring a read-only root filesystem or non-root UIDs, so if you're only at baseline today, the `nginx:latest` container might actually run — but you're leaving risk on the table.

## Takeaway

Hardening Nginx in Kubernetes is less about the web server itself and more about meeting the expectations of a security-conscious runtime environment. The combination of `nginxinc/nginx-unprivileged`, a tight `securityContext`, `emptyDir` volumes for scratch paths, and ConfigMap-managed configuration lets you satisfy the restricted Pod Security Standard without heroics. Each constraint — non-root UID, no privilege escalation, read-only root, dropped capabilities — has a concrete security rationale, and together they meaningfully shrink the blast radius if something in the serving stack is ever exploited.

If you're running anything in a homelab or production cluster that you care about, restricted PSS enforcement on your application namespaces is a low-effort, high-value control. Start with `audit` mode, fix the warnings, then flip to `enforce`.
