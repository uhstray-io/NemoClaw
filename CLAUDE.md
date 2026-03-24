# NemoClaw (uhstray-io fork)

Fork of [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) with sandbox DNS fixes. Upstream is an open-source stack that runs OpenClaw AI assistants inside NVIDIA OpenShell sandboxes.

**Fork repo**: https://github.com/uhstray-io/NemoClaw
**Upstream**: https://github.com/NVIDIA/NemoClaw

## What This Fork Changes

DNS resolution fix + channel integration support. Upstream NemoClaw has a known DNS issue ([#626](https://github.com/NVIDIA/NemoClaw/issues/626)). Our upstream PR: [#732](https://github.com/NVIDIA/NemoClaw/pull/732).

### Changes from upstream

| File | Change |
|---|---|
| `scripts/setup-dns-proxy.sh` | **New** — Python DNS forwarder in the sandbox pod |
| `scripts/fix-coredns.sh` | Extended to all platforms (was Colima-only) |
| `scripts/lib/runtime.sh` | Added `8.8.8.8` fallback for CoreDNS upstream resolution |
| `bin/lib/platform.js` | `shouldPatchCoredns()` returns true for all runtimes |
| `bin/lib/onboard.js` | Calls `setup-dns-proxy.sh` after sandbox creation |
| `scripts/setup.sh` | Calls `setup-dns-proxy.sh` after sandbox Ready check |
| `Dockerfile` | Loads channel configs from `nemoclaw-blueprint/config/*.json` at build time |
| `.pre-commit-config.yaml` | Added `pytest` to Pyright hook dependencies |
| `CLAUDE.md` | **New** — fork-specific development docs |

## Approach to Changes

- **Foundational fixes only** — fix root causes, never add workarounds. If something breaks, diagnose why before patching. The inference 503 was caused by DNS forwarding to `8.8.8.8` (which can't resolve k8s-internal names), not by a provider credential issue. Always find the root cause.
- **No runtime config patching** — never modify `openclaw.json` or other locked files at runtime via kubectl exec, nsenter, or chmod hacks. Configure at build time in the Dockerfile. For new integrations (Discord, Slack, etc.), add the channel definition to the Dockerfile's config generator with `"token": {"source": "env"}` — the channel activates only when the env var is present.
- **Follow upstream conventions** — match the repo's code style, security principles, and design patterns.
- **Use OpenShell mechanisms** — work with OpenShell's proxy, policies, providers, and blueprints. Don't bypass them.
- **Configuration over code** — prefer config changes to code-level workarounds.
- **No secrets in this repo** — it's public. Secrets belong in the deployment repo (nemoclaw-deploy).
- **Test before pushing** — verify inference, DNS, and web_search all work via `deploy.sh --onboard` before committing.

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

Two critical details:

1. **Bind to `10.43.0.10`** (NOT `0.0.0.0`): glibc's resolver uses connected UDP sockets that discard responses from unexpected source IPs. If bound to `0.0.0.0`, responses come from `10.200.0.1` and glibc ignores them.

2. **Forward to the CoreDNS pod IP** (NOT `8.8.8.8`): the `openshell-sandbox` binary in the pod namespace also uses DNS to reach the gateway (`openshell-0.openshell.svc.cluster.local`). Since we add `10.43.0.10` as a local address, ALL DNS in the pod goes through our proxy — including k8s-internal names. Public DNS can't resolve `*.svc.cluster.local`, so forwarding to `8.8.8.8` breaks inference routing. CoreDNS handles both k8s names (kubernetes plugin) and external names (forward plugin).

### Channel Integrations (Discord, Slack, Telegram)

Channel configs are defined in the Dockerfile's `openclaw.json` generator (the `channels` dict). Each channel reads its token from an environment variable at runtime:

```python
'discord': {'enabled': True, 'token': {'source': 'env', 'provider': 'default', 'id': 'DISCORD_BOT_TOKEN'}, ...}
```

The channel only activates when the env var is set in `/sandbox/.env`. To add a new channel:
1. Add the config entry to the Dockerfile's `channels` dict
2. Add the secret file to `nemoclaw-deploy/` (e.g., `discord-bot-token.txt`)
3. Update `deploy.sh` to read the file and inject it into `/sandbox/.env`
4. The corresponding network policy preset must be enabled in `sandboxes.json`

Never modify `openclaw.json` at runtime. Rebuild via `deploy.sh --onboard`.

### Onboard Flow

`nemoclaw onboard --non-interactive` runs these steps (see `bin/lib/onboard.js`):

1. **Preflight** — check Docker, OpenShell, ports, GPU
2. **Gateway** — destroy old, start new, verify health, patch CoreDNS, set up DNS proxy
3. **Sandbox** — build image from Dockerfile, create sandbox, wait for Ready, **set up DNS proxy**, forward dashboard port
4. **NIM** — detect/configure inference provider (cloud or local)
5. **Provider** — create OpenShell provider with NVIDIA_API_KEY
6. **OpenClaw** — launch gateway inside sandbox
7. **Policies** — apply presets from env vars

## Pre-Push Validation

**MANDATORY**: All changes must pass both unit tests AND end-to-end validation before pushing.

### Step 1: Unit Tests

```bash
npm test    # Must pass with 0 failures
```

### Step 2: Deploy and Validate

From the `nemoclaw-deploy/` directory:

```bash
./deploy.sh --onboard    # Full deploy with the change
./validate.sh            # Must report 15/15 passed
```

The validation script (`nemoclaw-deploy/validate.sh`) checks:
- **Infrastructure**: gateway, sandbox, fork source
- **DNS**: proxy running, external name resolution from sandbox
- **Inference**: provider configured, agent responds to prompts
- **Web Search**: GEMINI_API_KEY present, web search returns live results
- **Policies**: presets enabled

### Rules

1. **Never push if `validate.sh` fails.** Diagnose the root cause first.
2. **Never add workarounds.** If inference breaks, don't re-create the provider in deploy.sh — find why inference broke (e.g., DNS proxy forwarding to wrong upstream).
3. **Changes to DNS proxy (`setup-dns-proxy.sh`) are high-risk.** The proxy affects ALL name resolution in the pod, including the `openshell-sandbox` binary's connection to the gateway. Always validate inference AND DNS after changes.
4. **Changes to `onboard.js` affect the full setup flow.** Test a complete `deploy.sh --onboard` cycle, not just the modified step.

## Development

### Testing

```bash
npm install
npm test                           # Must pass — run all vitest tests
npx vitest run test/dns-proxy.test.js  # Run specific test file
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
