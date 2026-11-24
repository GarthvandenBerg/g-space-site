---
title: Hardening Unprivileged Nginx in Kubernetes
date: 2026-08-18
readTime: 7
tags: homelab, kubernetes, nginx
summary: Running non-root Nginx containers without tearing your hair out over port bindings, scratch folders, and crash loops.
---

If you drop a standard Nginx container into a locked-down Kubernetes cluster, it falls flat on its face right away. It wants port 80, it wants to write to paths it has no business touching as a regular user, and it will just crash loop until you sort it out.

Standard Nginx assumes it has root UID 0, so it can bind to low ports and write wherever it feels like. That might be fine for a quick test on your laptop, but once you start turning on proper security in your cluster, Kubernetes will kick it straight out the door. 

Here is how I set up non-root Nginx properly with unprivileged images, tight security contexts, scratch mounts, and ConfigMaps so it actually behaves.

## Why bother running unprivileged?

Kubernetes has Pod Security Standards, and if you label your namespace with restricted security, the cluster stops playing around. The admission webhook checks incoming pods, and if something tries to run as root or asks for privilege escalation, it throws a hard 403 error. No polite warnings, it just rejects the pod.

Even if you aren't enforcing restricted policies yet, running containers as root is just asking for trouble. If somebody finds an exploit in Nginx or an application sitting behind it and breaks out of the container, you really do not want them landing on your node as root. Running as a plain user gives you a real safety net if something goes sideways.

## What happens when stock Nginx breaks

To see what goes wrong, take the standard `nginx:latest` image and give it a basic non-root security context:

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
```

Kubernetes lets the pod in, but it dies immediately. When you check the logs, you get slapped with:

```text
nginx: [emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)
```

By default in Linux, any port below 1024 is privileged. A regular user cannot touch it unless you grant extra capabilities like `CAP_NET_BIND_SERVICE`. On top of the port issue, Nginx immediately tries to write its PID file to `/var/run/` and cache files to `/var/cache/nginx`. Since those folders are owned by root, the whole thing grinds to a halt.

## The unprivileged base image

Instead of fighting the stock image and trying to hack permissions by hand, the easiest starting point is `nginxinc/nginx-unprivileged`. 

It comes pre-configured with a few sanity checks:

- It runs as UID 101 (the `nginx` user) instead of root.
- It listens on port 8080 out of the box so you don't fight low-port binding rules.
- Directory permissions for `/var/cache/nginx` and `/var/run` are already set up for UID 101.

This gets you past the first round of errors, but if you want to lock the container down with a read-only root filesystem, you run straight into the next hurdle.

## Locking down the security context

Here is the container-level `securityContext` I use for locked-down deployments:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 101
  runAsGroup: 101
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

What this is doing:

`runAsNonRoot: true` tells Kubernetes to reject the pod if the container image tries to run as UID 0.

`runAsUser: 101` and `runAsGroup: 101` pin the UID and GID explicitly so there is no guessing what user the process runs as.

`allowPrivilegeEscalation: false` sets the `no_new_privs` flag in the Linux kernel so processes inside cannot grab higher privileges through setuid binaries.

`readOnlyRootFilesystem: true` mounts the root filesystem as read-only. Nothing inside the container can write to disk unless you explicitly give it a scratch volume.

`capabilities.drop: [ALL]` strips away every single Linux capability. Nginx serving on port 8080 as a regular user does not need any of them.

## Giving Nginx its write paths with emptyDir

Once you turn on `readOnlyRootFilesystem: true`, Nginx blows up again. Even in the unprivileged image, Nginx still needs to write temporary request buffers, proxy cache files, and its PID file at runtime. If the root filesystem is read-only, those writes fail and Nginx refuses to start.

The fix is mounting ephemeral `emptyDir` volumes over the exact paths Nginx needs to touch:

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

An `emptyDir` volume lives on the node's local disk, dies when the pod dies, and is owned by the container user. This gives Nginx the sandbox space it needs to do its job without opening up the rest of the container filesystem to writes.

## Managing config with ConfigMaps

Because the root filesystem is locked down read-only, you can't just `kubectl exec` into the pod and tweak `/etc/nginx/nginx.conf` when you want to test something. That might feel a bit frustrating at first, but it saves you from making random one-off changes on a node that you forget to save anywhere.

The clean way to handle this is putting your config in a ConfigMap and mounting it straight into `/etc/nginx/conf.d/`:

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

Then in your deployment, mount the ConfigMap as read-only:

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

Any time you need to update routing or headers, you change the ConfigMap in Git, apply it, and roll the pod. You get an audit trail of every change without touching a running shell.

## Turning on restricted security cluster-wide

To make sure your cluster actually enforces these rules, label your namespace:

```bash
kubectl label namespace web \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest
```

With `enforce=restricted` turned on, any pod that forgets `runAsNonRoot`, leaves `allowPrivilegeEscalation` true, or tries to run with a writable root gets rejected immediately. 

If you are migrating existing apps and do not want to break things right away, swap `enforce` for `audit` or `warn` first. That way Kubernetes logs the offenders or warns you in the CLI without killing the workload, giving you time to clean up the manifests.

## Wrapping up

Getting unprivileged Nginx working properly in Kubernetes takes a bit of troubleshooting upfront. You have to handle the non-standard port on 8080, carve out `emptyDir` volumes for scratch directories, and keep your config in ConfigMaps. But once you have that pattern down, the container runs smoothly, passes restricted security checks without complaining, and keeps your cluster that much safer.
