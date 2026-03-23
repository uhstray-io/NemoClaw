# NemoClaw (uhstray-io fork)

Fork of [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) with sandbox DNS fixes. Upstream is an open-source stack that runs OpenClaw AI assistants inside NVIDIA OpenShell sandboxes.

**Fork repo**: https://github.com/uhstray-io/NemoClaw
**Upstream**: https://github.com/NVIDIA/NemoClaw

## What This Fork Changes

This fork adds DNS resolution support for the sandbox. Upstream NemoClaw has a known issue ([#626](https://github.com/NVIDIA/NemoClaw/issues/626)) where `dns.lookup()` fails inside the sandbox because the CoreDNS service IP is unreachable from the isolated network namespace.

### Changes from upstream

| File | Change |
|---|---|
| `scripts/setup-dns-proxy.sh` | **New** — Python DNS forwarder in the sandbox pod |
| `scripts/fix-coredns.sh` | Extended to all platforms (was Colima-only) |
| `scripts/lib/runtime.sh` | Added `8.8.8.8` fallback for CoreDNS upstream resolution |
| `bin/lib/platform.js` | `shouldPatchCoredns()` returns true for all runtimes |
| `bin/lib/onboard.js` | Calls `setup-dns-proxy.sh` after sandbox creation |
| `scripts/setup.sh` | Calls `setup-dns-proxy.sh` after sandbox Ready check |
| `.pre-commit-config.yaml` | Added `pytest` to Pyright hook dependencies |

## Approach to Changes

- **Follow upstream conventions** — match the repo's code style, security principles, and design patterns.
- **Use OpenShell mechanisms** — work with OpenShell's proxy, policies, providers, and blueprints. Don't bypass them.
- **Configuration over code** — prefer config changes to code-level workarounds.
- **No secrets in this repo** — it's public. Secrets belong in the deployment repo (nemoclaw-deploy).
- **Keep changes minimal** — only fix the DNS issue. Don't refactor unrelated code.

## Architecture

### Codebase Structure

```
bin/                    # CLI plugin (Node.js/TypeScript)
  lib/
    onboard.js          # Onboard wizard (gateway, sandbox, providers, policies)
    platform.js         # Platform detection (runtime, Docker host, CoreDNS)
    policies.js         # Policy preset management
    credentials.js      # API key storage
    registry.js         # Sandbox registry
nemoclaw/               # TypeScript plugin source
  src/                  # Plugin TypeScript source
  dist/                 # Compiled output
nemoclaw-blueprint/     # Blueprint (Python)
  orchestrator/
    runner.py           # Blueprint runner (plan, apply, status, rollback)
  policies/
    openclaw-sandbox.yaml  # Base sandbox policy (deny-all default)
    presets/             # Network policy presets (discord, google, npm, etc.)
  blueprint.yaml        # Blueprint definition (profiles, components)
scripts/
  setup.sh              # Host setup (gateway, providers, sandbox)
  setup-dns-proxy.sh    # DNS proxy for sandbox (our addition)
  fix-coredns.sh        # CoreDNS forwarding fix
  nemoclaw-start.sh     # Sandbox entrypoint (runs inside sandbox)
  lib/runtime.sh        # Shell helper functions
Dockerfile              # Sandbox image (node:22-slim + OpenClaw + plugin)
test/                   # Vitest + shell tests
```

### Sandbox Network Architecture

The sandbox pod has two network namespaces:

```
Pod namespace (root):
  - eth0: 10.42.0.x (k8s pod network, can reach internet)
  - veth-h-*: 10.200.0.1 (gateway side of sandbox veth)
  - lo: 127.0.0.1 + 10.43.0.10 (added by setup-dns-proxy.sh)
  - DNS forwarder on 10.43.0.10:53 → 8.8.8.8:53

Sandbox namespace (nested, isolated):
  - veth-s-*: 10.200.0.2 (only interface)
  - Default route: via 10.200.0.1
  - /etc/resolv.conf: nameserver 10.43.0.10
  - HTTP proxy: 10.200.0.1:3128
  - Landlock + seccomp enforced
```

The sandbox process can only reach `10.200.0.1`. All HTTP/HTTPS goes through the proxy at `:3128`. DNS goes to `10.43.0.10` which routes through the veth to the pod namespace where our forwarder handles it.

### DNS Proxy Details

`setup-dns-proxy.sh` runs after sandbox creation:

1. Finds the sandbox pod via `kubectl` through the gateway container
2. Finds the pod's PID (for `nsenter`) by matching the pod hostname in `/proc`
3. Adds `10.43.0.10/32` to `lo` in the pod namespace (makes it a local address)
4. Writes `/tmp/dns-proxy.py` — a minimal Python UDP DNS forwarder
5. Launches it via `docker exec -d $CLUSTER nsenter -t $PID -n -m -- python3 /tmp/dns-proxy.py`

The forwarder binds to `10.43.0.10:53` (NOT `0.0.0.0`). This is critical: glibc's resolver uses connected UDP sockets that discard responses from unexpected source IPs. If bound to `0.0.0.0`, responses come from `10.200.0.1` and glibc ignores them.

### Onboard Flow

`nemoclaw onboard --non-interactive` runs these steps (see `bin/lib/onboard.js`):

1. **Preflight** — check Docker, OpenShell, ports, GPU
2. **Gateway** — destroy old, start new, verify health, patch CoreDNS, set up DNS proxy
3. **Sandbox** — build image from Dockerfile, create sandbox, wait for Ready, **set up DNS proxy**, forward dashboard port
4. **NIM** — detect/configure inference provider (cloud or local)
5. **Provider** — create OpenShell provider with NVIDIA_API_KEY
6. **OpenClaw** — launch gateway inside sandbox
7. **Policies** — apply presets from env vars

## Development

### Testing

```bash
npm install
npm test                           # Run all tests
npx vitest run test/dns-proxy.test.js  # Run specific test
```

Tests use vitest. Shell script tests spawn bash subprocesses. Pre-commit hooks run automatically via prek.

### Pre-commit Hooks

Managed by [prek](https://github.com/j178/prek) (configured in `.pre-commit-config.yaml`):

- **pre-commit**: whitespace, shfmt, prettier, eslint, shellcheck, SPDX headers, gitleaks
- **commit-msg**: commitlint (conventional commits)
- **pre-push**: tsc --noEmit, pyright

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`, `chore:`, etc.

### Syncing with Upstream

The fork tracks `NVIDIA/NemoClaw` main. To sync:

```bash
git remote add upstream https://github.com/NVIDIA/NemoClaw.git
git fetch upstream
git merge upstream/main
# Resolve conflicts (our changes are in scripts/, bin/lib/, test/)
```

## References

- NemoClaw Docs: https://docs.nvidia.com/nemoclaw/latest/
- OpenShell Docs: https://docs.nvidia.com/openshell/latest/
- OpenShell Repo: https://github.com/NVIDIA/OpenShell
- Discord: https://discord.gg/XFpfPv9Uvx
