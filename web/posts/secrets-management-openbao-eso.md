---
title: Keeping Secrets Out of Git: OpenBao and External Secrets Operator
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, security, infrastructure
summary: Why encrypting secrets in Git is a trap, and how running OpenBao outside Kubernetes lets my cluster rebuild cleanly from zero.
---

GitOps is great right up until you have to deal with your first database password, API key, or SSL certificate. 

The temptation is always to just throw the secret into your Git repository. Maybe you base64 encode it in a normal Kubernetes secret, or maybe you use a tool like Sealed Secrets or SOPS to encrypt it before committing. 

Even if you encrypt your secrets, keeping them in Git creates problems:

Your Git repository becomes a high-value target. If your encryption keys leak, anyone with read access to the repo can decrypt your entire commit history.

Rotating a single secret turns into a whole Git workflow. You have to encrypt the new value, commit it, open a pull request, merge it, and wait for ArgoCD to sync.

If you wipe your cluster and you were relying on cluster-side keys like Sealed Secrets, you better hope you backed up that controller key, or you just locked yourself out of your own data.

I wanted something cleaner: I wanted secrets to live outside Kubernetes completely. That way, if I destroy the cluster or rebuild it from scratch, the secrets are sitting safely on another machine waiting to be synced back in.

Here is how I set up OpenBao and External Secrets Operator to keep credentials out of Git.

## Why OpenBao and External Secrets Operator?

OpenBao is an open-source, community-driven fork of HashiCorp Vault. It was created after HashiCorp changed Vault's license to BSL. Because OpenBao is API-compatible with Vault, all standard Vault tools and Kubernetes operators work with it out of the box.

Inside Kubernetes, I run External Secrets Operator (ESO). ESO watches for custom resources called `ExternalSecret`. When an application needs a password, ESO talks to OpenBao, pulls the actual secret value over HTTPS, and creates a standard Kubernetes `Secret` in memory. 

Your pods consume regular Kubernetes secrets. They don't know or care that the secret originally came from OpenBao.

This gives you a few massive advantages:

- Secrets never touch Git. Your manifests only contain references to secret paths, not actual passwords.
- The cluster only has read access. If a pod gets compromised, an attacker cannot wipe or overwrite secrets in OpenBao.
- Disaster recovery is painless. When you rebuild the cluster from scratch, ESO connects to OpenBao and populates all the secrets automatically.

## How the architecture fits together

OpenBao runs on a dedicated virtual machine on Proxmox at `bao.g-space.co.za`, completely separate from the Kubernetes cluster. 

Keeping OpenBao outside Kubernetes is a deliberate choice. If your secret store runs inside the cluster, and the cluster is dead, you have a chicken-and-egg problem trying to get secrets to rebuild the cluster. 

The OpenBao VM is backed up in two ways: Proxmox Backup Server takes scheduled full VM snapshots, and a cron job takes regular Raft snapshots of the internal database.

Inside OpenBao, secrets live in a KV v2 engine under `secret/data/staging/*`. 

## Authenticating with AppRole

To let External Secrets Operator talk to OpenBao without giving it keys to the kingdom, I use AppRole authentication. AppRole requires two pieces:

A `role_id`: A public identifier for the role. This is safe to commit to Git.

A `secret_id`: The actual password for the role. This is never committed to Git.

Tokens issued through this AppRole are locked down tightly. They expire after one hour, have a maximum lifetime of four hours, and are restricted to the IP range of the Kubernetes cluster nodes. If someone steals a token and tries to use it from outside the home network, OpenBao rejects it.

The policy for the operator is strictly read-only:

```hcl
path "secret/data/staging/*" {
  capabilities = ["read"]
}

path "secret/metadata/staging/*" {
  capabilities = ["read"]
}
```

ESO can read secrets and check their version metadata. It cannot delete, write, or touch anything outside the staging path.

## The ClusterSecretStore manifest

Inside the cluster, a `ClusterSecretStore` tells ESO how to talk to OpenBao:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: openbao
spec:
  provider:
    vault:
      server: "https://bao.g-space.co.za"
      path: "secret"
      version: "v2"
      auth:
        appRole:
          path: "approle"
          roleId: "67fc1871-62db-2257-6416-852bbf189d1d"
          secretRef:
            name: openbao-approle
            namespace: external-secrets
            key: secretId
```

The `roleId` is written right in the YAML file and committed to Git. The `secretRef` points to a Kubernetes secret named `openbao-approle` that holds the actual `secret_id`.

## Pulling secrets into applications

When an application like Grafana needs a password, you define an `ExternalSecret` resource:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: grafana-admin
  namespace: monitoring
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: grafana-admin-secret
    creationPolicy: Owner
  data:
    - secretKey: admin-password
      remoteRef:
        key: staging/grafana/admin
        property: password
```

ESO checks OpenBao every hour. If you update the password inside OpenBao, ESO detects the change and updates the Kubernetes secret automatically without you needing to touch Git.

## The "first secret" problem

Every secrets architecture has to solve the chicken-and-egg problem: how do you give Kubernetes the very first credential it needs to fetch other credentials?

In my setup, the only credential that has to be injected manually is that `secret_id`. 

During my Terraform bootstrap, I pass the `secret_id` as an environment variable to `terraform apply`. Terraform creates the `openbao-approle` secret in the `external-secrets` namespace right after installing the operator. 

That is the only manual secret in the entire system. From that point on, ESO authenticates and pulls down every other database password, API key, and token on its own.

## Sync waves: why order matters

During my rebuild drills, I ran into a bug where ArgoCD tried to create `ExternalSecret` custom resources before the External Secrets Operator CRDs had finished registering with the Kubernetes API. The sync failed with `no matches for kind ExternalSecret`.

To fix this, I used ArgoCD sync waves to enforce strict ordering:

- Wave -9 installs the CRDs.
- Wave -8 installs the ESO operator pods.
- Wave -6 creates the `ClusterSecretStore`.
- Wave -5 deploys the `ExternalSecret` manifests.
- Wave 5 deploys the user applications that actually need the secrets.

Setting those waves explicitly guaranteed that by the time an application starts, its secrets are already created in memory and waiting for it.

## Honest gaps I still need to fix

There are a few shortcuts in my OpenBao setup that need attention:

The AppRole secret ID does not expire. I set `secret_id_ttl=0` during initial setup so I wouldn't have to deal with automated secret rotation while learning the stack. If that secret ID leaks, it remains valid until I revoke it manually.

OpenBao was configured by hand. The OpenBao VM, its policies, mounts, and AppRoles were set up using the CLI and web interface. If that VM ever gets corrupted, I have to restore it from a Proxmox VM backup rather than rebuilding it with Terraform. Codifying OpenBao in Terraform is on my to-do list.

No network policies on ESO. Cilium is installed, but I haven't written strict network policies restricting which pods can talk to the ESO controller.

## Why this approach is worth the extra work

Setting up an external vault VM and configuring AppRoles takes more effort than just running `sops -e` on a YAML file. 

The payoff comes when you have to rebuild your cluster. During my 33-minute recovery drill, I didn't spend a single second worrying about decryption keys or restoring secret backups. OpenBao was already running, ESO connected on boot, and every secret appeared in the cluster within seconds.

Treating your cluster as disposable means putting your durable data and secrets on solid ground outside of it.
