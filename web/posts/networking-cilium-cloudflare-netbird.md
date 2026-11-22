---
title: "Homelab Networking in Three Layers: Cilium, Cloudflare Tunnel, and NetBird"
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, networking, infrastructure
summary: How I built a zero-inbound-port homelab network using Cilium eBPF as the CNI, Cloudflare Tunnel for public exposure, and a NetBird WireGuard mesh for private access, with Caddy HA and Technitium DNS rounding it out.
---

**TL;DR:** My homelab Kubernetes cluster (five **Talos Linux** nodes on **Proxmox**) exposes services through two entirely separate paths. **Public websites** go through a **Cloudflare Tunnel** managed by the `cfgate` operator. **Private apps** such as Immich are reached over a **NetBird WireGuard mesh** and a pair of **Caddy** reverse proxies running in Proxmox LXC containers with **keepalived** HA. The CNI is **Cilium in kube-proxy replacement mode**, doing load balancing in eBPF. **No inbound ports are open on the home router.**

*Note: IP addresses in this post are generalized (`192.168.<lan>.x`) rather than copied from my real network.*

## The Design Goal: Zero Inbound Ports

One constraint shaped every decision: **the home router exposes no inbound ports.** No port-forwarding, no dynamic DNS pointing at a home IP, no exposed SSH. That rules out the obvious shortcut of putting a NodePort on a service and forwarding it.

The design has three layers:

1. **CNI layer:** Cilium provides in-cluster load balancing, Gateway API support, and LoadBalancer IPs.
2. **Public exposure:** Cloudflare Tunnel (via the `cfgate` operator) makes **outbound-only** connections to Cloudflare's edge.
3. **Private access:** a NetBird WireGuard mesh lets trusted users reach internal apps without exposing anything publicly.

---

## Layer 1 — CNI: Cilium in kube-proxy Replacement Mode

### Why Cilium

Cilium's **eBPF dataplane** replaces `kube-proxy` and most `iptables`-based service routing. That suits Talos Linux, a minimal immutable OS, because there is less userspace networking plumbing to maintain. Cilium also provides native **Gateway API** support and **L2 announcements** for `LoadBalancer` services, which removes the need for a separate MetalLB install.

### Talos Prerequisites

Talos must be told not to install its own CNI or kube-proxy before Cilium can own the dataplane:

```yaml
# shared-patch.yaml (excerpt)
cluster:
  network:
    cni:
      name: none        # do not install a built-in CNI
  proxy:
    disabled: true      # do not run kube-proxy
```

### Key Cilium Configuration

```yaml
kubeProxyReplacement: true
k8sServiceHost: localhost
k8sServicePort: 7445          # KubePrism local API endpoint
gatewayAPI:
  enabled: true
l2announcements:
  enabled: true
bpf:
  masquerade: true
```

`localhost:7445` is **KubePrism**, Talos's built-in local load balancer for the **Kubernetes API**. Pointing Cilium at it means the agent can reach the API server on every node without depending on the external control-plane VIP, which matters during bootstrap and node restarts.

### LoadBalancer IP Pool and L2 Announcements

A `CiliumLoadBalancerIPPool` reserves a block of addresses at the top of the LAN subnet (`192.168.<lan>.200–240`) for `LoadBalancer` services. A `CiliumL2AnnouncementPolicy` advertises those IPs via ARP on the node's primary interface, so the home router and other LAN clients can reach them. **No BGP is required.**

Internal services such as ArgoCD, Grafana, and Prometheus each get a stable IP from this pool.

### Bootstrap Order and the 300-Second Problem

Cilium is installed by **Terraform (Helm) before ArgoCD**, because ArgoCD needs a working pod network. This creates an ordering problem: Cilium's CRDs (`CiliumLoadBalancerIPPool`, `CiliumL2AnnouncementPolicy`, and others) are not reliably registered when Terraform tries to apply resources that use them.

The fix is unglamorous:

```hcl
resource "time_sleep" "wait_for_cilium_crds" {
  depends_on      = [helm_release.cilium]
  create_duration = "300s"
}
```

A fixed **300-second** wait after the Helm install. A proper solution would poll for CRD readiness, but a fixed delay is predictable and simple, and total bootstrap time is dominated by other steps anyway.

### Limitations

**Hubble** (Cilium's flow-visibility layer) is enabled but not yet used for flow analysis or policy generation. More importantly, **no `NetworkPolicy` or `CiliumNetworkPolicy` resources exist yet.** The pod network is flat, so any pod can reach any other pod. This is a known gap and the next planned security step.

---

## Layer 2 — Public Exposure: Cloudflare Tunnel via cfgate

### Why Cloudflare Tunnel

`cloudflared` opens a persistent **outbound-only** connection from the cluster to Cloudflare's network. Requests hit Cloudflare's edge, travel through the tunnel, and reach the service. There is no inbound router port and no exposed home IP, which makes it a clean fit for the zero-inbound-port constraint.

### How cfgate Works

The **`cfgate.io` operator** extends the Kubernetes **Gateway API** with Cloudflare-specific resources:

- `CloudflareTunnel`: provisions the tunnel
- `GatewayClass` / `Gateway`: the cfgate-managed gateway that `HTTPRoute`s attach to
- `CloudflareDNS`: syncs DNS records for the routes attached to the gateway

`cloudflared` runs as a **Deployment with 2 replicas**, so the tunnel connector is redundant. `HTTPRoute`s attach to the cfgate `Gateway` exactly as they would to any other Gateway API implementation, and `CloudflareDNS` creates or updates the matching DNS records automatically.

### What Goes Through the Tunnel

Only **public-facing websites**, including this blog. Apps like Immich and ArgoCD are intentionally **not** exposed publicly: Immich holds personal photos and ArgoCD has cluster-admin reach.

**Renovate** tracks the `cloudflare/cloudflared` image version through an inline annotation, so image updates arrive as reviewable pull requests:

```yaml
# renovate: datasource=docker depName=cloudflare/cloudflared
image: cloudflare/cloudflared:<pinned-version>
```

---

## Layer 3 — Private Access: NetBird + Caddy HA

### NetBird: WireGuard Mesh VPN

**NetBird** is a managed **WireGuard** mesh VPN. Friends and family install the client and get access to private apps (mainly Immich) without handling VPN config files. NetBird exit nodes also expose the home LAN and VLANs (management, Proxmox, TrueNAS) for my own remote administration.

NetBird replaced the earlier **KubeSpan** setup, a WireGuard overlay that stretched across a cloud control-plane node and the home nodes. Once all nodes moved on-premises, KubeSpan was removed and NetBird took over private connectivity **outside the cluster**.

### Caddy: Reverse Proxy in Proxmox LXC

Caddy runs in **Alpine LXC containers on Proxmox**, deliberately *outside* Kubernetes. Cluster networking is unstable during rebuilds, and a proxy that depends on the cluster would disappear exactly when it is most useful. LXC containers are lighter and outlast cluster rebuilds.

A custom Docker image packages Caddy with the **Cloudflare DNS plugin**. The image is exported and uploaded to Proxmox as an **LXC template**, so new containers are consistent and reproducible.

TLS certificates are issued with the **Cloudflare DNS-01 challenge**: Caddy uses the Cloudflare API to prove domain ownership, which works for internal hostnames that are never publicly reachable. The API token is stored in an `envfile` on the LXC host with `chmod 600`.

### High Availability: keepalived VRRP

Two Caddy containers run in parallel with **keepalived** providing a **VRRP** virtual IP:

- **Virtual IP:** one address on the private services subnet
- **Primary:** priority `101` (active)
- **Secondary:** priority `100` (standby)
- **Health check:** `pidof caddy`; if the Caddy process disappears, keepalived fails over

A single LXC container going down (maintenance, host reboot, or failure) does not take private access offline, and failover is transparent to NetBird clients.

### Internal DNS: Technitium

A **Technitium DNS cluster** handles internal name resolution. Internal hostnames that Caddy terminates resolve to the Caddy VIP; external hostnames resolve normally via Cloudflare.

**Uptime Kuma** (running on the QDevice) monitors the full user path (DNS → Caddy → Immich) and sends Discord alerts if any segment breaks.

---

## Trade-offs and Lessons

- **Caddy outside Kubernetes was the right call.** It adds an operational boundary (LXC containers instead of a Deployment), but the proxy and NetBird layers stayed up during the November 2026 rebuild drill (~33 minutes). *Backends running inside the cluster, such as Immich, were unavailable until the rebuild finished*, but the access layer never needed to be rebuilt.
- **The 300-second sleep is a known smell.** It works, but polling for CRD readiness is the proper fix.
- **No NetworkPolicy yet.** This is the most significant security gap. The plan is to use Hubble flow data to generate a least-privilege baseline.
- **cfgate simplifies a lot.** Managing a tunnel manually means syncing config files and DNS records. With cfgate it reduces to `HTTPRoute` resources plus a `CloudflareDNS` object, a GitOps-friendly interface.

---

## Summary

| Layer | Technology | Purpose |
|---|---|---|
| CNI | Cilium (eBPF, kube-proxy replacement) | In-cluster L4 load balancing, Gateway API, L2 IPs |
| Public | Cloudflare Tunnel + cfgate operator | Zero-inbound-port public websites |
| Private | NetBird WireGuard + Caddy HA (LXC) | Friends/family and my own remote access |
| DNS | Technitium (internal) + Cloudflare (external) | Name resolution across both paths |

The design keeps the **blast radius** of any single component small: the cluster can be rebuilt without touching NetBird or Caddy, Cloudflare Tunnel is stateless and recovers with the cluster, and the two-node Caddy HA pair means LXC maintenance does not interrupt private access. It is not a production network, but these are patterns I would carry into a professional infrastructure role.
