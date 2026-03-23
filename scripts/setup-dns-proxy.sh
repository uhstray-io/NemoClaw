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
# Fix: Run a Python DNS forwarder in the sandbox pod's namespace that:
#   1. Adds 10.43.0.10 as a local address on lo (so packets from the sandbox
#      are delivered locally instead of forwarded)
#   2. Listens on 0.0.0.0:53 (UDP) and forwards to public DNS (8.8.8.8)
#
# The sandbox's existing resolv.conf (nameserver 10.43.0.10) works without
# modification — the forwarder intercepts the traffic transparently.
#
# The DNS proxy is launched via `docker exec -d` + `nsenter` from the gateway
# container, which keeps it alive as a persistent background process.
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

# ── Helper: kubectl via gateway ─────────────────────────────────────

kctl() {
  docker exec "$CLUSTER" kubectl "$@"
}

# ── Find the sandbox pod and its PID ────────────────────────────────

POD="$(kctl get pods -n openshell -o name 2>/dev/null \
  | grep -- "$SANDBOX_NAME" | head -1 | sed 's|pod/||' || true)"

if [ -z "$POD" ]; then
  echo "ERROR: Could not find pod for sandbox '$SANDBOX_NAME'."
  exit 1
fi

# Get the pod's init PID as seen from the gateway container (for nsenter)
POD_PID="$(docker exec "$CLUSTER" sh -c "
  # Find PID that has the pod's hostname in its UTS namespace
  for pid in /proc/[0-9]*/ns; do
    p=\${pid%/ns}; p=\${p##*/}
    if [ -f /proc/\$p/root/etc/hostname ] 2>/dev/null; then
      hn=\$(cat /proc/\$p/root/etc/hostname 2>/dev/null)
      if [ \"\$hn\" = \"$POD\" ]; then
        echo \$p
        break
      fi
    fi
  done
" 2>/dev/null || true)"

if [ -z "$POD_PID" ]; then
  echo "WARNING: Could not find pod PID via hostname. Trying kubectl..."
  # Fallback: use kubectl exec to find a PID we can nsenter into
  POD_PID="$(kctl exec -n openshell "$POD" -- sh -c 'echo $$' 2>/dev/null || true)"
fi

if [ -z "$POD_PID" ]; then
  echo "ERROR: Could not determine pod PID for nsenter."
  exit 1
fi

echo "Setting up DNS proxy in pod '$POD' (pid=$POD_PID, ${COREDNS_SERVICE_IP} → ${DNS_UPSTREAM})..."

# ── Step 1: Add CoreDNS service IP as local address ─────────────────

kctl exec -n openshell "$POD" -- \
  ip addr add "${COREDNS_SERVICE_IP}/32" dev lo 2>/dev/null || true

# ── Step 2: Write DNS proxy script to the pod ───────────────────────

kctl exec -n openshell "$POD" -- sh -c "cat > /tmp/dns-proxy.py << 'DNSPROXY'
import socket, threading, os

UPSTREAM = (os.environ.get('DNS_UPSTREAM', '8.8.8.8'), 53)

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('10.43.0.10', 53))

with open('/tmp/dns-proxy.pid', 'w') as pf:
    pf.write(str(os.getpid()))

with open('/tmp/dns-proxy.log', 'w') as log:
    log.write('dns-proxy: 10.43.0.10:53 -> {}:{} pid={}\n'.format(
        UPSTREAM[0], UPSTREAM[1], os.getpid()))

def forward(data, addr):
    try:
        f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        f.settimeout(5)
        f.sendto(data, UPSTREAM)
        r, _ = f.recvfrom(4096)
        sock.sendto(r, addr)
        f.close()
    except Exception:
        pass

while True:
    d, a = sock.recvfrom(4096)
    threading.Thread(target=forward, args=(d, a), daemon=True).start()
DNSPROXY"

# ── Step 3: Kill any existing DNS proxy ─────────────────────────────

OLD_PID="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.pid 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kctl exec -n openshell "$POD" -- kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

# ── Step 4: Launch DNS proxy via docker exec -d (persistent) ────────
#
# Using `docker exec -d` (detached) + `nsenter` to enter the pod's
# network and mount namespaces. This creates a persistent process that
# survives after the script exits — unlike kubectl exec which kills
# child processes on session end.

docker exec -d "$CLUSTER" \
  nsenter -t "$POD_PID" -n -m -- \
  python3 -u /tmp/dns-proxy.py

sleep 2

# ── Step 5: Verify ──────────────────────────────────────────────────

LOG="$(kctl exec -n openshell "$POD" -- cat /tmp/dns-proxy.log 2>/dev/null || true)"
if echo "$LOG" | grep -q "dns-proxy:"; then
  echo "DNS proxy started: $LOG"
else
  echo "WARNING: DNS proxy may not have started. Log: $LOG"
fi
