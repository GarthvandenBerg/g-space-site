---
title: Homelab Networking in Three Layers: Cilium, Cloudflare Tunnel, and NetBird
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, networking, infrastructure
summary: How I built a zero-inbound-port homelab network using Cilium eBPF as the CNI, Cloudflare Tunnel for public exposure, and NetBird WireGuard mesh for private access — with Caddy HA and Technitium DNS rounding it out.
---

**TL;DR:** My homelab Kubernetes cluster (5 Talos Linux nodes on Proxmox) exposes services through two entirely separate paths: public websites go through a Cloudflare Tunnel managed by the `cfgate` operator, while private apps like Immich are reached via a NetBird WireGuard mesh and a pair of Caddy reverse proxies running in Proxmox LXC containers with keepalived HA. The underlying CNI is **Cilium in kube-proxy replacement mode**, handling load balancing entirely in eBPF. No inbound ports are open on the home router.

## The Design Goal: Zero Inbound Ports

The single constraint that shaped every networking decision: **the home router exposes no inbound ports**. No port-forwarding, no dynamic DNS pointing at a home IP, no exposed SSH. This rules out the obvious approaches — you can't just slap a NodePort on something and call it a day.

The solution falls into three distinct layers:

1. **CNI layer** — Cilium provides in-cluster load balancing and Gateway API support.
2. **Public exposure** — Cloudflare Tunnel (`cfgate` operator) punches outbound-only connections to Cloudflare's edge.
3. **Private access** — NetBird WireGuard mesh lets trusted users reach internal apps without exposing anything publicly.

Each layer has a clear responsibility. Let me walk through each one.

---

## Layer 1 — CNI: Cilium in kube-proxy Replacement Mode

### Why Cilium

Cilium's **eBPF dataplane** replaces both `iptables` and `kube-proxy` entirely. This is the right choice for Talos Linux, which is a minimal, immutable OS — the less userspace networking plumbing to maintain, the better. Cilium also ships native **Gateway API** support and **L2 announcements** for `LoadBalancer`-type services, which eliminates the need for a separate MetalLB installation.

### Talos Prerequisites

Talos has to be told to get out of the way before Cilium can own the dataplane. Two patches are required:

```yaml
# shared-patch.yaml (excerpt)
cluster:
  network:
    cni:
      name: none        # disable built-in CNI
  proxy:
    disabled: true      # disable kube-proxy
```

With `CNI=none`, Talos does not install a CNI plugin. With `kube-proxy disabled`, the in-tree proxy never starts. Cilium fills both gaps.

### Key Cilium Configuration

```yaml
kubeProxyReplacement: true
k8sServiceHost: localhost
k8sServicePort: 7445          # Talos local API port
gatewayAPI:
  enabled: true
l2announcements:
  enabled: true
bpf:
  masquerade: true
```

`k8sServiceHost: localhost` / `k8sServicePort: 7445` is the Talos-specific wiring — Cilium talks to the local Talos API server rather than the external control-plane VIP.

### LoadBalancer IP Pool and L2 Announcements

A `CiliumLoadBalancerIPPool` carves out `192.168.2.200–192.168.2.240` for `LoadBalancer`-type services. An `L2AnnouncementPolicy` on `eth0` advertises those IPs at Layer 2 so the home router's ARP table picks them up — no BGP required.

Some assigned IPs worth noting:
- ArgoCD: `192.168.2.206`
- Grafana: `192.168.2.230`
- Prometheus: `192.168.2.231`
- Local gateway: `192.168.2.240`

### Bootstrap Order and the 300-Second Problem

Cilium is bootstrapped by **Terraform (Helm) before ArgoCD**, because ArgoCD itself needs a working pod network to run. This creates a subtle ordering problem: Cilium's Custom Resource Definitions (CRDs — `CiliumLoadBalancerIPPool`, `L2AnnouncementPolicy`, etc.) are not reliably registered by the time Terraform tries to apply them.

The fix is unglamorous but honest:

```hcl
resource "time_sleep" "wait_for_cilium_crds" {
  depends_on      = [helm_release.cilium]
  create_duration = "300s"
}
```

A 300-second `time_sleep` after the Helm install. It works. A proper solution would poll for CRD readiness, but a fixed wait is predictable and simple, and the total bootstrap time is dominated by other steps anyway.

### Limitations

Hubble (Cilium's flow visibility and observability layer) is enabled but not yet used for flow analysis or policy generation. More importantly: **no `NetworkPolicy` or `CiliumNetworkPolicy` resources have been written yet**. The pod network is flat — any pod can reach any other pod. This is a known gap and a planned next step.

---

## Layer 2 — Public Exposure: Cloudflare Tunnel via cfgate

### Why Cloudflare Tunnel

Cloudflare Tunnel (`cloudflared`) opens an outbound-only persistent connection from inside the cluster to Cloudflare's global network. Requests arrive at Cloudflare's edge, travel through the tunnel, and hit your service — with no inbound port on your router and no exposed home IP. It's the cleanest solution to the zero-inbound-port constraint for public traffic.

### How cfgate Works

The **`cfgate.io` operator** extends the standard Kubernetes Gateway API with Cloudflare-specific resources:

- `CloudflareTunnel` — provisions the tunnel itself
- `GatewayClass` / `Gateway` — the cfgate-managed gateway that HTTPRoutes attach to
- `CloudflareDNS` — automatically syncs DNS records for every route attached to the gateway

`cloudflared` runs as a `Deployment` with **2 replicas** inside the cluster, so the tunnel itself is redundant. HTTPRoutes attach to the cfgate `Gateway` exactly as they would to any other Gateway API implementation.

The `CloudflareDNS` resource deserves a mention: it reads the hostnames from the attached `Gateway` routes and creates or updates the corresponding DNS records in Cloudflare automatically. No manual DNS management.

### What Goes Through the Tunnel

Only **public-facing websites** — including this blog — use the Cloudflare Tunnel path. Apps like Immich and ArgoCD are intentionally *not* exposed publicly. Immich handles personal photos; ArgoCD has cluster-admin access. Neither should be on the public internet.

Renovate manages the `cloudflare/cloudflared` container image version via an inline annotation:

```yaml
# renovate: datasource=docker depName=cloudflare/cloudflared
image: cloudflare/cloudflared:2025.x.x
```

PR-based image updates mean the tunnel image never drifts without a review.

---

## Layer 3 — Private Access: NetBird + Caddy HA

### NetBird: WireGuard Mesh VPN

**NetBird** is a managed WireGuard mesh VPN. Friends and family install the NetBird client, and they get access to private apps (Immich, primarily) without any of them needing to know what a VPN config file looks like. Exit nodes on the NetBird mesh also expose the home LAN and VLANs (management, Proxmox, TrueNAS) for my own remote access.

This replaced the previous **KubeSpan** setup, which was a WireGuard overlay that stretched across a cloud control-plane node and the home nodes. When all nodes moved fully on-premises, KubeSpan was removed — NetBird now handles private connectivity entirely outside the cluster.

### Caddy: Reverse Proxy in Proxmox LXC

Caddy runs in **Alpine LXC containers on Proxmox** — deliberately *outside* Kubernetes. Kubernetes networking is not stable during cluster rebuilds; a reverse proxy that depends on the cluster would be unavailable exactly when you might need it most. LXC containers on Proxmox are simpler, lighter, and outlast cluster rebuilds.

A custom Docker image packages Caddy with the Cloudflare DNS plugin baked in. The image is built, exported, and uploaded to Proxmox as an **LXC template**, so new containers are consistent and reproducible.

TLS certificates are issued via **Cloudflare DNS-01 challenge** — Caddy calls the Cloudflare API to prove domain ownership, which works even for internal hostnames that are never publicly reachable. The Cloudflare API token lives in an `envfile` on the LXC host, `chmod 600`.

### High Availability: keepalived VRRP

Two Caddy LXC containers run in parallel with **keepalived** providing a VRRP virtual IP:

- VIP: `192.168.70.244/24`
- Primary: priority `101` (active)
- Secondary: priority `100` (standby)
- Health check: `pidof caddy` — if the Caddy process disappears, keepalived fails over

This means a single LXC container going down (for maintenance, Proxmox host reboot, or failure) does not take private access offline. The failover is transparent to NetBird clients.

### Internal DNS: Technitium

A **Technitium DNS cluster** handles internal name resolution. Internal hostnames (the ones Caddy terminates) resolve to `192.168.70.244` (the Caddy VIP). External hostnames resolve normally via Cloudflare.

Uptime Kuma on the QDevice monitors the full user path — DNS → Caddy → Immich — and fires Discord alerts if any segment breaks.

---

## Trade-offs and Lessons

**Caddy outside Kubernetes was the right call.** It adds a small operational boundary to manage (LXC containers vs. a Deployment), but the resilience benefit during cluster rebuilds is real. During a timed rebuild drill in November 2026, private access via Caddy/NetBird remained up for the entire ~33 minutes the cluster was down.

**The 300-second sleep is a known smell.** It works, but a proper solution polls for CRD readiness. It's on the list.

**No NetworkPolicy yet.** This is the most significant security gap. With Hubble enabled, the next step is to use flow data to generate a least-privilege policy baseline. Flat pod networks are fine in a homelab during active development; they're not acceptable long-term.

**cfgate simplifies a lot.** Managing a Cloudflare Tunnel manually involves syncing config files and DNS records. The cfgate operator reduces it to `HTTPRoute` resources and a `CloudflareDNS` object — a clean GitOps-friendly interface.

---

## Summary

| Layer | Technology | Purpose |
|---|---|---|
| CNI | Cilium (eBPF, kube-proxy replacement) | In-cluster L4 LB, Gateway API, L2 IPs |
| Public | Cloudflare Tunnel + cfgate operator | Zero-inbound-port public websites |
| Private | NetBird WireGuard + Caddy HA LXC | Friends/family and self remote access |
| DNS | Technitium (internal) + Cloudflare (external) | Name resolution across both paths |

The overall design keeps the blast radius of any single component failure small: the cluster can be rebuilt without touching NetBird or Caddy; Cloudflare Tunnel is stateless and recovers with the cluster; and the two-replica Caddy HA setup means LXC maintenance doesn't interrupt private access. It's not a production network, but the patterns are ones I'd carry into a professional infrastructure role without hesitation.
