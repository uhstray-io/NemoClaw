#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Fix sandbox DNS by running a lightweight DNS forwarder in the sandbox pod.
#
# Problem: The sandbox runs in an isolated network namespace (10.200.0.0/24).
# Its /etc/resolv.conf points to the k3s CoreDNS service IP (10.43.0.10), but
# DNS packets from the sandbox route through the pod namespace — where the
# CoreDNS service IP is not locally handled. The result: dns.lookup() fails
# with EAI_AGAIN for every outbound request.
#
# Fix: Run a Python DNS forwarder in the sandbox pod's root namespace that:
#   1. Adds 10.43.0.10 as a local address on lo (so packets from the sandbox
#      are delivered locally instead of forwarded)
#   2. Listens on 0.0.0.0:53 (UDP) and forwards to public DNS (8.8.8.8)
#
# The sandbox's existing resolv.conf (nameserver 10.43.0.10) works without
# modification — the forwarder intercepts the traffic transparently.
#
# Requires: sandbox must be in Ready state. Run after sandbox creation.
#
# Usage: ./scripts/setup-dns-proxy.sh [gateway-name] <sandbox-name>

set -euo pipefail

GATEWAY_NAME="${1:-}"
SANDBOX_NAME="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

if [ -z "$SANDBOX_NAME" ]; then
  echo "Usage: $0 [gateway-name] <sandbox-name>"
  exit 1
fi

# CoreDNS service IP that the sandbox's /etc/resolv.conf points to
COREDNS_SERVICE_IP="10.43.0.10"
DNS_UPSTREAM="8.8.8.8"

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

# ── Find the sandbox pod ────────────────────────────────────────────

kctl() {
  docker exec "$CLUSTER" kubectl "$@"
}

POD="$(kctl get pods -n openshell -o name 2>/dev/null \
  | grep -- "$SANDBOX_NAME" | head -1 | sed 's|pod/||' || true)"

if [ -z "$POD" ]; then
  echo "ERROR: Could not find pod for sandbox '$SANDBOX_NAME'."
  exit 1
fi

echo "Setting up DNS proxy in pod '$POD' (${COREDNS_SERVICE_IP} → ${DNS_UPSTREAM})..."

# ── Step 1: Add CoreDNS service IP as local address ─────────────────
#
# The sandbox sends DNS to 10.43.0.10 (per resolv.conf). By adding this
# IP as a local address in the pod namespace, packets from the sandbox
# are delivered to a local process instead of being forwarded out.

kctl exec -n openshell "$POD" -- \
  ip addr add "${COREDNS_SERVICE_IP}/32" dev lo 2>/dev/null || true

# ── Step 2: Start DNS forwarder ─────────────────────────────────────
#
# A minimal Python UDP DNS forwarder. Listens on 0.0.0.0:53, forwards
# to 8.8.8.8:53. Runs as a background daemon in the pod namespace.

# Kill any existing DNS proxy
kctl exec -n openshell "$POD" -- \
  sh -c "pkill -f 'python3.*dns-proxy' 2>/dev/null || true"
sleep 1

# Write the DNS proxy script to the pod
kctl exec -n openshell "$POD" -- sh -c "cat > /tmp/dns-proxy.py << 'DNSPROXY'
import socket, threading, sys, os

UPSTREAM = (os.environ.get('DNS_UPSTREAM', '8.8.8.8'), 53)

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('0.0.0.0', 53))
print('dns-proxy: 0.0.0.0:53 -> {}:{}'.format(UPSTREAM[0], UPSTREAM[1]), flush=True)

def forward(data, addr):
    try:
        f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        f.settimeout(5)
        f.sendto(data, UPSTREAM)
        r, _ = f.recvfrom(4096)
        sock.sendto(r, addr)
        f.close()
    except Exception as e:
        print('dns-proxy err: {}'.format(e), flush=True)

while True:
    d, a = sock.recvfrom(4096)
    threading.Thread(target=forward, args=(d, a), daemon=True).start()
DNSPROXY"

# Launch it as a background daemon
kctl exec -n openshell "$POD" -- \
  bash -c "nohup python3 -u /tmp/dns-proxy.py > /tmp/dns-proxy.log 2>&1 &"
sleep 2

# Verify it started
LOG="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.log 2>/dev/null || true)"
if echo "$LOG" | grep -q "dns-proxy:"; then
  echo "DNS proxy started: $LOG"
else
  echo "WARNING: DNS proxy may not have started. Log: $LOG"
fi

# ── Step 3: Verify DNS from sandbox ─────────────────────────────────

echo "Verifying DNS from sandbox '$SANDBOX_NAME'..."
DNS_TEST="$(kctl exec -n openshell "$POD" -- \
  nsenter --net="/var/run/netns/sandbox-*" -- \
  python3 -c "import socket; socket.getaddrinfo('google.com', 443)" 2>&1 || true)"

if echo "$DNS_TEST" | grep -q "addrinfo\|google"; then
  echo "DNS resolution verified: sandbox can resolve external names."
else
  echo "NOTE: Automated verification inconclusive (nsenter may not work)."
  echo "  Test manually: nemoclaw $SANDBOX_NAME connect"
  echo "  Then: python3 -c \"import socket; print(socket.getaddrinfo('google.com', 443))\""
fi
