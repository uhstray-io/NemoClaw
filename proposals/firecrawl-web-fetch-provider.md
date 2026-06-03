# Proposal: Self-hosted Firecrawl as the OpenClaw `web_fetch` provider

- **Status:** Draft / for review
- **Date:** 2026-05-30
- **Scope:** uhstray-io NemoClaw fork (candidate for upstream PR)
- **Related:** `scripts/generate-openclaw-config.py`, `nemoclaw/src/runtime-context.ts`,
  `nemoclaw-blueprint/policies/presets/`, the host tool-gateway broker
  (`agents/hermes/host/tool-gateway-broker.ts`)

## Summary

Give OpenClaw's `web_fetch` a Firecrawl fallback for JavaScript-rendered and
bot-protected pages, **without** a Nous subscription and **without** breaking the
sandbox's deny-by-default egress model. Firecrawl runs as operator-owned infrastructure;
the agent never holds Firecrawl's key and never gains arbitrary egress.

## Background: what `web_fetch` does today

OpenClaw's built-in `web_fetch` tool is keyless and extracts content locally with
Mozilla Readability. From `scripts/generate-openclaw-config.py`:

```python
tools_web["fetch"] = {"enabled": True, "useTrustedEnvProxy": True, "readability": True}
```

- `readability: True` — fetch pulls raw HTML and runs Readability *inside the sandbox*
  to strip it to article text. No API key, no external provider.
- `useTrustedEnvProxy: True` — the HTTP request is forced **through OpenShell's L7 proxy**.
- The L7 proxy is the egress authority — an unlisted `host:port` returns proxy 403.
  That is the "allowlist-only" behavior described in `nemoclaw/src/runtime-context.ts`.

Readability's limitation: no JavaScript rendering and no anti-bot handling. The
Cloudflare "Just a moment" challenge that `runtime-context.ts` already warns about is
exactly what Readability cannot resolve. Firecrawl closes that gap.

## Key findings that shape this plan

1. **OpenClaw's Firecrawl provider config lives under `plugins.entries.firecrawl.config.webFetch.*`**
   — the *same* "provider config moved out of `tools.web.*`" shape this fork already
   handles for Brave web search (`plugins.entries.brave.config.webSearch.apiKey`).
   Firecrawl is the **fallback**: Readability runs first, Firecrawl is invoked only when
   Readability fails. The keyless fast path is preserved.

2. **`webFetch.baseUrl` explicitly accepts `http://` for loopback / private-network /
   `.local` / `.internal` / `.localhost` targets.** This means OpenClaw `web_fetch` can
   point its Firecrawl provider straight at `http://host.openshell.internal:<port>` — a
   self-hosted instance reachable only through the host gateway.

3. **The Dockerfile already lets `host.openshell.internal` through the `web_fetch` SSRF
   guard** (Patch 2b). The host-gateway choke point this plan relies on is already wired.

4. **Schema gotcha — openclaw#20442.** The legacy `tools.web.fetch.firecrawl` path is
   rejected by OpenClaw's strict config schema. We **must** use the `plugins.entries`
   shape or `openclaw config validate` fails and the image build aborts — the same
   failure mode the fork already fixed for the Brave inline-`apiKey` shape. The issue also
   notes a second, behavioral bug where the Firecrawl fallback may not fire even when
   configured; this must be verified at runtime before calling the work done.

## Goal and egress model

Two control layers are required for true deny-by-default. Missing the second one quietly
reopens arbitrary egress through Firecrawl.

| Layer | Control | Mechanism |
| --- | --- | --- |
| A. Sandbox to Firecrawl | Sandbox reaches *only* the Firecrawl endpoint | New blueprint policy preset allow-listing one `host.openshell.internal:<port>` path (mirror `nous-web.yaml`) |
| B. Firecrawl to internet | Firecrawl can scrape only approved hosts (else it is an open relay) | Firecrawl's own container egress forced through an allowlist, or operator-owned-but-open with the trade-off documented |

## Decisions to confirm before implementing

1. **Key custody.** Keyless self-hosted Firecrawl (`USE_DB_AUTHENTICATION=false`,
   simplest) vs. keyed (`CRW_API_KEY`, host-held). Keyed needs the broker (Phase 4) so the
   sandbox never sees the key.
2. **Where Firecrawl runs.** Docker-host compose stack (recommended — matches the
   `host.openshell.internal` model the repo already uses) vs. a separate VM. Firecrawl is
   heavy: it needs Redis, a worker, and a Playwright service — not a single container.
3. **Consumer.** OpenClaw `web_fetch` (primary) vs. also the Hermes agent's native `web`
   backend (the broker matrix already does Firecrawl there; it would just need the
   `upstream` repointed).

**Recommendation:** Tier 1 — keyless, on a host compose stack, OpenClaw consumer, with
Layer-B egress lockdown. Smallest correct change. Add the keyed broker tier only if key
custody is required.

## Phase 0 — Verify the one runtime unknown (blocking)

Confirm **how OpenClaw's Firecrawl plugin issues its API call**: does the call to
`webFetch.baseUrl` route through the same trusted-env-proxy / L7 path that Patch 2b carves
out for `host.openshell.internal`, or does the plugin fetch directly? If it bypasses the
L7 proxy, Layer A is not policy-enforced and the design changes.

- How: read the compiled `openclaw` dist Firecrawl plugin
  (`/usr/local/lib/node_modules/openclaw/dist`, where the Dockerfile patches already
  classify the dist), or probe in the TUI. Per the fork notes, `openclaw agent --local`
  hangs on tool-use prompts — test tool behavior in the TUI.

## Phase 1 — Stand up self-hosted Firecrawl (deploy repo)

Host-services territory — this belongs in `nemoclaw-deploy`, not the plugin image.

- Add a Firecrawl `docker-compose` stack (api + worker + redis + playwright-service),
  bound to the Docker host gateway so it resolves as `host.openshell.internal:<port>` from
  the sandbox (Firecrawl default API port `3002`, endpoint `POST /v1/scrape`).
- **Layer B:** put the Firecrawl worker behind an egress allowlist (compose network plus
  the same L7 proxy, or an explicit URL allow/deny in Firecrawl config) so it cannot
  scrape arbitrary hosts. Document what it is allowed to reach.
- Keyless (`USE_DB_AUTHENTICATION=false`) or set `CRW_API_KEY` per decision 1.

## Phase 2 — Egress policy preset (this repo)

New `nemoclaw-blueprint/policies/presets/firecrawl-self.yaml`, modeled on `nous-web.yaml`:

- Allow `host: host.openshell.internal` on the Firecrawl port, `enforcement: enforce`.
- `allowed_ips` restricted to the RFC1918 host-gateway ranges (keeps OpenShell SSRF
  protection blocking other private destinations — copy the `nous-web.yaml` comment and
  ranges verbatim).
- `rules:` allow only the Firecrawl scrape path (`POST /v1/scrape`, `/v1/scrape/**`), not a
  wildcard.

## Phase 3 — Wire the OpenClaw provider (this repo)

In `scripts/generate-openclaw-config.py`, right after the `tools_web["fetch"]` block. Use
the `plugins.entries` shape — **not** `tools.web.fetch.firecrawl` (openclaw#20442):

```python
if env.get("NEMOCLAW_WEB_FETCH_FIRECRAWL", "") == "1":
    fc = (
        config.setdefault("plugins", {})
        .setdefault("entries", {})
        .setdefault("firecrawl", {})
    )
    fc["enabled"] = True
    fc.setdefault("config", {})["webFetch"] = {
        "baseUrl": env.get(
            "NEMOCLAW_FIRECRAWL_BASE_URL", "http://host.openshell.internal:3002"
        ),
        "onlyMainContent": True,
        # apiKey only in keyed/brokered mode:
        # "apiKey": "openshell:resolve:env:FIRECRAWL_API_KEY",
    }
```

- Keep `readability: True`. Firecrawl is the fallback when Readability fails, so the
  keyless fast path stays and Firecrawl is paid for only on hard pages.
- Gate behind a new build arg `NEMOCLAW_WEB_FETCH_FIRECRAWL` (plus
  `NEMOCLAW_FIRECRAWL_BASE_URL`), mirroring how `NEMOCLAW_WEB_SEARCH_ENABLED` flows.

## Phase 4 — Broker the key (Tier 2, only if keyed)

If decision 1 is keyed, do not place `FIRECRAWL_API_KEY` in the sandbox. Reuse the existing
broker pattern (`agents/hermes/host/tool-gateway-broker.ts` plus
`managed-tool-gateway-matrix.json`), which already strips `x-firecrawl-api-key` from
sandbox requests and injects real auth upstream. That broker is currently hardwired to
Nous OAuth token-minting, so a static key needs a new `auth.mode: "static"` branch (inject
from a host-held `FIRECRAWL_API_KEY`) alongside the OAuth path, plus a matrix entry such as
`{ service: "firecrawl", upstream: "http://localhost:3002", auth: { mode: "static" } }`.
Then point `webFetch.baseUrl` at `http://host.openshell.internal:11436/firecrawl`. This is
the most invasive piece — it touches a security-sensitive shared file — so do it only if
key custody is required.

## Phase 5 — Runtime context truthfulness (this repo)

`nemoclaw/src/runtime-context.ts` already reads `fetch.enabled` and is mostly fine. Refine
the failure-mode wording: with Firecrawl in the path, a site 403 / Cloudflare challenge may
now be *handled* by Firecrawl rather than surfaced, so the existing "report the site 403,
do not ask to allow-list" guidance should mention the Firecrawl fallback. Keep it truthful
per the fork's core rule — a misleading prompt makes the agent refuse working tools.

## Phase 6 — Tests and gates (this repo)

- `test/generate-openclaw-config.test.ts`: assert the `plugins.entries.firecrawl.config.webFetch`
  shape when the build arg is set, and that it is **absent by default** (do not regress the
  keyless default — there is already a test for the keyless `web_fetch` case).
- `test/policies.test.ts`: assert the `firecrawl-self` preset allow-lists only the
  host-gateway scrape path.
- Run `openclaw config validate` against the generated config (the build already does this)
  to prove openclaw#20442 does not bite — the entire reason for using the `plugins.entries`
  shape.
- `npm test` (root) plus the plugin tests, and `npm run typecheck:cli` / the plugin `tsc`.

## Risks and rollback

- **Biggest risk: Layer B omitted.** Firecrawl becomes an open egress relay, silently
  defeating deny-by-default. Treat the Phase 1 egress lockdown as non-optional, not a
  follow-up.
- **openclaw#20442 behavioral bug.** The Firecrawl fallback may not trigger even when
  configured. Phase 0 / TUI testing must confirm the fallback actually fires on a JS page
  before this is considered done.
- **Rollback is clean.** The build arg defaults off, so the config reverts to today's
  keyless Readability-only `web_fetch`. No runtime mutation of the hash-locked
  `openclaw.json`.

## Net assessment

This is mostly a **generator + policy-preset** change in this repo (Phases 2, 3, 5, 6) plus
a **host compose stack** in the deploy repo (Phase 1), reusing infrastructure that already
exists (the host-gateway SSRF patch, the broker pattern, the preset shape). The
keyed/brokered tier (Phase 4) is the only heavy lift and is optional.

## Sources

- OpenClaw Firecrawl docs: <https://docs.openclaw.ai/tools/firecrawl>
- OpenClaw web-fetch docs: <https://docs.openclaw.ai/tools/web-fetch>
- openclaw#20442 (config-schema rejection + fallback bug):
  <https://github.com/openclaw/openclaw/issues/20442>
- Firecrawl self-hosting guide: <https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md>
