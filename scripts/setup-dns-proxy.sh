#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix sandbox DNS by routing DNS traffic from the sandbox network to CoreDNS.
#
# Problem: The sandbox runs on 10.200.0.0/24 and its /etc/resolv.conf points
# to CoreDNS at 10.43.0.10 (the k3s service IP). That IP is unreachable from
# the sandbox subnet — packets to it route through the gateway (10.200.0.1)
# but the gateway drops them because there's no NAT rule for DNS.
#
# Fix: Add iptables DNAT rules on the gateway so DNS queries from the sandbox
# network destined for 10.43.0.10:53 are forwarded to the actual CoreDNS pod
# IP. This bridges the subnet gap using the gateway as a DNS router.
#
# This script complements fix-coredns.sh, which fixes CoreDNS *forwarding*
# (making CoreDNS resolve external names). This script fixes CoreDNS
# *reachability* (making the sandbox able to reach CoreDNS at all).
#
# Run this after `openshell gateway start` and after fix-coredns.sh.
#
# Usage: ./scripts/setup-dns-proxy.sh [gateway-name] [sandbox-name]

set -euo pipefail

GATEWAY_NAME="${1:-}"
SANDBOX_NAME="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

# Subnet the sandbox lives on (OpenShell default)
SANDBOX_SUBNET="10.200.0.0/24"
# CoreDNS service IP that the sandbox's /etc/resolv.conf points to
COREDNS_SERVICE_IP="10.43.0.10"

# ── Find the gateway container ──────────────────────────────────────

if [ -z "${DOCKER_HOST:-}" ]; then
  if docker_host="$(detect_docker_host)"; then
    export DOCKER_HOST="$docker_host"
  fi
fi

CLUSTERS="$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' 2>/dev/null || true)"
CLUSTER="$(select_openshell_cluster_container "$GATEWAY_NAME" "$CLUSTERS" || true)"

if [ -z "$CLUSTER" ]; then
  if [ -n "$GATEWAY_NAME" ]; then
    echo "ERROR: Could not find gateway container for '$GATEWAY_NAME'."
  else
    echo "ERROR: Could not find any openshell cluster container."
  fi
  exit 1
fi

# ── Discover CoreDNS pod IP ─────────────────────────────────────────

COREDNS_POD_IP="$(docker exec "$CLUSTER" kubectl get endpoints kube-dns \
  -n kube-system -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"

if [ -z "$COREDNS_POD_IP" ]; then
  echo "WARNING: Could not discover CoreDNS pod IP. CoreDNS may not be running yet."
  echo "Falling back to DNAT directly to public DNS (8.8.8.8)."
  COREDNS_POD_IP="8.8.8.8"
fi

echo "Setting up sandbox DNS routing: ${SANDBOX_SUBNET} → ${COREDNS_SERVICE_IP}:53 → ${COREDNS_POD_IP}:53"

# ── Add iptables rules (idempotent) ─────────────────────────────────
#
# These rules intercept DNS traffic from the sandbox subnet destined for
# the CoreDNS service IP (10.43.0.10) and DNAT it to the actual CoreDNS
# pod IP. MASQUERADE ensures the return path works.

add_rule() {
  local table="$1" chain="$2"
  shift 2
  # Check if rule already exists (-C), add (-I for PREROUTING, -A for others) if not
  if ! docker exec "$CLUSTER" iptables -t "$table" -C "$chain" "$@" 2>/dev/null; then
    if [ "$chain" = "PREROUTING" ] || [ "$chain" = "POSTROUTING" ]; then
      docker exec "$CLUSTER" iptables -t "$table" -A "$chain" "$@"
    else
      docker exec "$CLUSTER" iptables -t "$table" -I "$chain" "$@"
    fi
  fi
}

# DNAT: sandbox → 10.43.0.10:53 → CoreDNS pod IP (UDP)
add_rule nat PREROUTING \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_SERVICE_IP" -p udp --dport 53 \
  -j DNAT --to-destination "${COREDNS_POD_IP}:53"

# DNAT: sandbox → 10.43.0.10:53 → CoreDNS pod IP (TCP)
add_rule nat PREROUTING \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_SERVICE_IP" -p tcp --dport 53 \
  -j DNAT --to-destination "${COREDNS_POD_IP}:53"

# MASQUERADE return traffic so CoreDNS pod can reply
add_rule nat POSTROUTING \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_POD_IP" -p udp --dport 53 \
  -j MASQUERADE

add_rule nat POSTROUTING \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_POD_IP" -p tcp --dport 53 \
  -j MASQUERADE

# Allow forwarding DNS from sandbox network
add_rule filter FORWARD \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_POD_IP" -p udp --dport 53 -j ACCEPT

add_rule filter FORWARD \
  -s "$SANDBOX_SUBNET" -d "$COREDNS_POD_IP" -p tcp --dport 53 -j ACCEPT

echo "DNS routing configured."

# ── Verify (optional, if sandbox name provided) ─────────────────────

if [ -n "$SANDBOX_NAME" ]; then
  POD="$(docker exec "$CLUSTER" kubectl get pods -o name 2>/dev/null \
    | grep -- "$SANDBOX_NAME" | head -1 | sed 's|pod/||' || true)"

  if [ -n "$POD" ]; then
    echo "Verifying DNS from sandbox '$SANDBOX_NAME'..."
    DNS_TEST="$(docker exec "$CLUSTER" kubectl exec "$POD" -- \
      python3 -c "import socket; socket.getaddrinfo('google.com', 443)" 2>&1 || true)"
    if echo "$DNS_TEST" | grep -q "addrinfo"; then
      echo "DNS resolution verified: sandbox can resolve external names."
    else
      echo "WARNING: DNS verification inconclusive. Test manually:"
      echo "  nemoclaw $SANDBOX_NAME connect"
      echo "  python3 -c \"import socket; print(socket.getaddrinfo('google.com', 443))\""
    fi
  fi
fi
