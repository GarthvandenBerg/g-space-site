---
title: Secrets Management Without Secrets in Git — OpenBao + External Secrets Operator
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, security, infrastructure
summary: How I keep Kubernetes secrets out of Git entirely by running OpenBao on a dedicated VM outside the cluster and using the External Secrets Operator to sync them in — so secrets survive a full cluster rebuild.
---

**TL;DR:** Kubernetes apps need secrets. Putting them in Git — even encrypted — means your repo becomes part of your trust boundary. Instead, I run **OpenBao** (the open-source Vault fork) on its own VM outside the cluster and use the **External Secrets Operator (ESO)** to pull secrets into Kubernetes at runtime. The cluster is now fully rebuildable from code, and secrets are never touched by the GitOps pipeline.

---

## The Problem: Secrets and GitOps Don't Mix Well

A GitOps setup is elegant right up until you need a database password or an API token. The temptation is to commit it — maybe encrypted — alongside everything else. But even encrypted secrets in Git carry risk:

- **The repo becomes a target.** Anyone who compromises your Git host or your decryption key gets everything.
- **Rotation is painful.** Every rotation means a new commit, a new PR, a new sync.
- **The blast radius is wide.** A leaked decryption key (or key ceremony mistake) exposes all historical commits.

I considered the common alternatives before landing on my current approach.

### Alternatives I Ruled Out

**Sealed Secrets** encrypts secrets with a cluster-side key and stores the ciphertext in Git. It's simple and popular, but the secret is fundamentally tied to the cluster — destroy the cluster without backing up the controller key and you've lost decryption. That's the wrong direction for a setup where *full cluster rebuild* is a first-class scenario.

**SOPS** (usually with age or KMS) is more flexible and works well for small teams. The limitation I hit is the same: secrets still live in Git, your key material is still a single point of failure, and rotating a secret means a commit. It also doesn't compose naturally with GitOps sync — you need extra tooling or init containers to decrypt at deploy time.

**Native Kubernetes Secrets** (base64 in a manifest) are not a strategy; they're just the problem stated differently.

**The core insight that changed my approach:** a secret store *outside* the cluster means secrets survive a full cluster rebuild. No matter what happens to `etcd`, the VMs, or the ArgoCD state, the secrets are sitting on a separate VM waiting to be re-synced. That's the design I wanted.

---

## Why OpenBao + External Secrets Operator

**OpenBao** is the community-maintained open-source fork of HashiCorp Vault, created after HashiCorp moved Vault to the Business Source License. It is API-compatible with Vault, which means any tooling that talks Vault also talks OpenBao — including ESO's `vault` provider.

**External Secrets Operator** runs inside the cluster and watches `ExternalSecret` resources. When it sees one, it authenticates to the external store, fetches the value, and creates or updates a native Kubernetes `Secret`. Applications see a normal Secret; they never know (or care) where it came from.

The combination gives me:
- **One central store** that is completely outside Kubernetes
- **Read-only access** from the cluster side — ESO can pull but not push
- **Automatic sync** — if a secret changes in OpenBao, ESO reconciles it into the cluster
- **Disaster recovery alignment** — rebuild the cluster, the secrets are still there

---

## Architecture

```
OpenBao VM (bao.g-space.co.za)
  └─ KV v2 engine
       └─ secret/data/staging/*
             ├─ grafana/admin
             ├─ cloudflare/token
             ├─ renovate/github-token
             └─ s3/credentials

          ▲  AppRole auth (roleId + secretId)
          │
    ESO (in-cluster)
      └─ ClusterSecretStore  ←  references openbao-approle k8s Secret
           └─ ExternalSecret (per app)
                └─ Kubernetes Secret (consumed by pod)
```

OpenBao runs on its own VM, **not inside Kubernetes**. This is intentional and important. If the cluster goes away, OpenBao is unaffected. The VM is on its own Proxmox host, backed up by **Proxmox Backup Server** (whole-VM snapshots) and supplemented by **cron-driven Raft snapshots** so the internal state is independently recoverable even if the VM image is gone.

---

## OpenBao Configuration

### KV v2 Secret Engine

Secrets live under the `secret/` KV v2 mount. The staging path is `secret/data/staging/*`. KV v2 gives versioning for free — useful for rollback and auditing, even in a homelab.

### AppRole Auth

ESO authenticates to OpenBao using **AppRole**, which requires two pieces:

- **`role_id`** — a stable identifier for the role, treated as semi-public. This is committed to Git: `67fc1871-62db-2257-6416-852bbf189d1d`.
- **`secret_id`** — the actual credential. This is *never* in Git.

The `role_id` being public is intentional in the AppRole model. Knowing the role ID alone grants nothing — you also need the `secret_id`, which stays out of the repo entirely.

Tokens issued via this AppRole are constrained:
- **TTL:** 1 hour
- **Max TTL:** 4 hours
- **CIDR binding:** tokens are restricted to the cluster node IP range, so a leaked token is useless from outside the network

The **policy** ESO operates under is read-only:

```hcl
path "secret/data/staging/*" {
  capabilities = ["read"]
}

path "secret/metadata/staging/*" {
  capabilities = ["read"]
}
```

ESO can read secrets and their metadata. It cannot write, delete, or touch anything outside the `staging/` path.

---

## ESO Configuration

### ClusterSecretStore

The `ClusterSecretStore` is cluster-wide (not namespace-scoped), which means any namespace can reference it via an `ExternalSecret`. The store is configured with the Vault provider pointing at OpenBao's address:

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
            name: openbao-approle        # k8s Secret — NOT in Git
            namespace: external-secrets
            key: secretId
```

The `roleId` is in the YAML (and therefore in Git). The `secretRef` points to a Kubernetes Secret named `openbao-approle` in the `external-secrets` namespace — this Secret contains the actual `secret_id` and is created out-of-band.

### ExternalSecret (example)

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

ESO reconciles this every hour. If the value changes in OpenBao, the Kubernetes Secret is updated within the refresh window.

---

## The Bootstrap Challenge

This is the one place where the setup requires a manual step (or a Terraform variable).

The `openbao-approle` Kubernetes Secret must exist *before* ESO can authenticate and sync anything. But it's not in Git. The bootstrap options are:

1. **Manual:** `kubectl create secret generic openbao-approle --from-literal=secretId=<value> -n external-secrets` before the first ArgoCD sync.
2. **Terraform variable:** The `OPEN_BAO_SECRET_ID` variable is wired into the Terraform bootstrap so the Secret is created programmatically as part of `terraform apply` — the same run that provisions VMs, installs Cilium, and kicks off ArgoCD.

In practice, the Terraform path is cleaner for full rebuilds: a single `terraform apply` with the variable set handles the whole bootstrap sequence without any kubectl commands.

**This is the last manual secret in the system.** Everything else flows from it.

---

## ArgoCD Sync Waves

The ordering matters. ESO's CRDs must be installed before the ESO operator, the operator must be running before the `ClusterSecretStore` can be applied, and the store must exist before any `ExternalSecret` tries to sync. ArgoCD sync waves enforce this:

| Wave | What deploys |
|------|--------------|
| -9 | CRDs (including ESO CRDs) |
| -8 | Operators (ESO controller) |
| -6 | ClusterSecretStore |
| -5 | ExternalSecrets |
| 5+ | Applications that consume the resulting Secrets |

This ordering was discovered the hard way: during one of the cluster rebuild drills, the ESO CRDs were missing when the operator tried to install because the sync wave was set incorrectly. The wave was fixed and the drill was re-run.

---

## Known Limitations

I try to document these honestly:

- **`secret_id_ttl=0`** — the `secret_id` never expires. This is a gap: if the `secret_id` were leaked, there's no automatic expiry to limit the blast radius. The plan is to implement TTL-bound `secret_id`s with a rotation process, but it's not built yet.
- **No rotation process** — currently there's no automated workflow to rotate the `secret_id`. It would need to be rotated in OpenBao, then the `openbao-approle` Kubernetes Secret updated, then ESO would re-authenticate.
- **OpenBao configured by hand** — the OpenBao VM itself, its auth methods, policies, and KV mounts were configured manually. It's not codified with Terraform or OpenTofu. This means a fresh OpenBao rebuild would require manual re-configuration before the cluster can sync secrets. Codifying this is on the backlog.
- **No NetworkPolicy** — Cilium is deployed with Hubble enabled but no `CiliumNetworkPolicy` resources have been written yet, so there's no enforcement of which pods can reach the ESO controller or which namespaces can create `ExternalSecrets`.

---

## What I Learned

**An external secret store changes the trust model, not just the storage location.** Moving from encrypted-in-Git to an external store shifts the question from "who can decrypt this?" to "who can reach this endpoint and authenticate?". That's a better question to be asking — the answer is controllable with network policy, CIDR binding, and audit logs rather than key management.

**The bootstrap secret is the last manual step, and that's acceptable.** Every secrets strategy has a "first secret" problem. Mine is explicit: one `secret_id` injected at bootstrap time. It's documented, it's in the Terraform variable flow, and it's the only thing standing between a fresh cluster and a fully-synced secret state.

**Secrets survive cluster rebuilds — and that changes what a rebuild means.** During the drills (the most recent in November 2026 came in at ~33 minutes), one of the cleanest parts was secrets: OpenBao was already running, ESO authenticated, and secrets appeared in the cluster without any intervention. The rebuild bottlenecks were elsewhere.

**GitOps works best when the Git repo contains configuration, not credentials.** The `ClusterSecretStore` YAML is in Git. The `ExternalSecret` manifests are in Git. The `roleId` is in Git. The actual secret values are nowhere near it.
