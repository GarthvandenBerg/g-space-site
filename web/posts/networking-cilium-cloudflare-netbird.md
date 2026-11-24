---
title: "Homelab Networking in Three Layers: Cilium, Cloudflare Tunnel, and NetBird"
date: 2026-11-22
readTime: 9
tags: homelab, kubernetes, networking, infrastructure
summary: How I built a zero-inbound-port network using Cilium eBPF, Cloudflare Tunnels for public sites, and a NetBird WireGuard mesh for family access.
---

When setting up a homelab, the easiest way to access your services from the internet is logging into your home router and forwarding port 80 and 443 to a local server. 

I decided on day one that I was not going to do that. Opening inbound ports on your home router exposes your public IP address to the entire internet, which means anyone running a port scanner can see your setup and start hammering away at your firewall.

Instead, I set a strict rule for this lab: zero open inbound ports on the router. 

Everything public goes through outbound Cloudflare Tunnels. Everything private goes through an encrypted NetBird WireGuard mesh. And inside the cluster, Cilium replaces kube-proxy entirely using eBPF.

Here is how the networking fits together across the three layers, and why separating internal access from public sites makes running a homelab so much safer.

## Layer 1: Cilium with eBPF inside the cluster

Inside Kubernetes, I run Cilium as the CNI in full `kubeProxyReplacement: true` mode. 

Standard Kubernetes uses kube-proxy, which manages thousands of iptables rules in the Linux kernel to route traffic between services and pods. That works, but it adds a lot of legacy userspace baggage. Cilium uses eBPF to route packets directly in the kernel, bypassing iptables completely.

Because I run Talos Linux, getting Cilium to take over networking is simple. In my machine config patches, I tell Talos not to install a default CNI and to disable kube-proxy:

```yaml
cluster:
  network:
    cni:
      name: none
  proxy:
    disabled: true
```

Inside Cilium's Helm configuration, I point it at `localhost:7445`. That port is KubePrism, a built-in local proxy in Talos that load balances traffic to the Kubernetes API. Pointing Cilium at KubePrism means every node can talk to the API server locally even during early boot before the cluster network has finished settling.

### L2 announcements instead of MetalLB

Usually, if you want your Kubernetes `LoadBalancer` services to have reachable IP addresses on your home LAN, you install MetalLB. 

With Cilium, you don't need MetalLB. Cilium has built-in Layer 2 announcements. 

I give Cilium an IP pool at the top of my local subnet (`192.168.2.200` to `.240`). When an internal service like ArgoCD or Grafana asks for a load balancer IP, Cilium hands it an address from that pool and advertises it on the local network using ARP. My home router and laptop can reach the services directly without needing any BGP configuration.

### The 300-second sleep in Terraform

Terraform installs Cilium via Helm before ArgoCD can run, because ArgoCD needs pod networking to communicate.

The problem is that Cilium's custom resource definitions take a minute or two to register with the Kubernetes API after the Helm release finishes. When Terraform tried to apply dependent resources right away, it would crash because the CRDs weren't ready.

My fix was putting a 300-second `time_sleep` block right after the Cilium installation in Terraform. It is not elegant, but a five-minute hard wait is completely reliable and prevents intermittent bootstrap failures.

## Layer 2: Public sites through Cloudflare Tunnel

For public-facing websites like this blog, I use Cloudflare Tunnels managed by the `cfgate` Kubernetes operator.

A `cloudflared` deployment runs inside the cluster with two replicas. The moment the pods boot, they establish an outbound HTTPS connection to Cloudflare's edge network. When a visitor goes to my website, Cloudflare terminates the connection on their edge, checks DDoS protection, and forwards the request down the existing tunnel to my cluster.

The `cfgate` operator makes this completely declarative using the Kubernetes Gateway API. I define a normal Gateway and attach `HTTPRoute` resources to it. A `CloudflareDNS` resource automatically creates the matching DNS records on Cloudflare without me having to touch the Cloudflare web dashboard.

Crucially, only public websites use this tunnel. Internal tools like ArgoCD and personal services like Immich never get attached to Cloudflare Tunnels. 

## Layer 3: Private access with NetBird and Caddy

For private services, like family members accessing our Immich photo library, I use NetBird.

NetBird is a managed WireGuard mesh network. Instead of having family members wrestle with raw WireGuard configuration files and QR codes, they just install the NetBird app, log in, and get secure peer-to-peer access to the home network.

### Caddy in an LXC container for high availability

Instead of running my reverse proxy inside Kubernetes, I run Caddy in Alpine Linux LXC containers on Proxmox, completely outside the cluster.

Running Caddy outside Kubernetes is a lifesaver during disaster recovery drills. When I wipe the Kubernetes cluster to time a rebuild, Caddy and NetBird stay running. The private networking layer never drops, and as soon as the cluster workloads boot back up, Caddy starts routing traffic to them again.

I run two Caddy containers in an active-standby pair using `keepalived` for VRRP failover:

- Primary Caddy: priority 101
- Secondary Caddy: priority 100
- Virtual IP: a single floating IP address on the services subnet

If the primary Caddy container crashes or the Proxmox host reboots for updates, `keepalived` notices that the Caddy PID is gone and shifts the virtual IP to the secondary container instantly. 

For SSL certificates, Caddy uses the Cloudflare DNS-01 challenge. It talks to the Cloudflare API to prove domain ownership and grabs trusted Let's Encrypt certificates for internal hostnames that are never exposed to the public internet.

Internal name resolution is handled by a Technitium DNS cluster running in my lab. External lookups go to Cloudflare, while internal names resolve straight to the Caddy virtual IP.

## What is still missing

The biggest gap in my current network is that internal pod communication is completely flat. 

I have Cilium installed and Hubble running for network observability, but I haven't written strict `CiliumNetworkPolicy` manifests yet. That means any pod in any namespace can currently talk to any other pod across the cluster. Writing least-privilege policies to isolate namespaces is my next major security task.

## Why this setup works

Separating networking into three distinct layers keeps the blast radius of any failure tiny.

If the Kubernetes cluster dies, the NetBird VPN and Caddy proxy keep running without missing a beat.

If an attacker probes my home IP, there are literally zero open ports to scan.

And for public sites, Cloudflare handles the inbound traffic and forwards it through an outbound tunnel, keeping my home network completely hidden from the public internet.
