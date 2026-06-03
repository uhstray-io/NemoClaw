# Forge Integration — Final Executable Implementation Plan

- **Status:** Draft — not-ready; 6 gates (G-1…G-6) must close before execution
- **Date:** 2026-05-31
- **Scope:** uhstray-io NemoClaw fork — a project/workflow assistant ("Forge") running inside the deny-by-default OpenShell sandbox
- **Provenance:** Synthesized from a 5-expert panel (architecture, AI engineering, NemoClaw dev, security, networking) + a cross-challenge round + an adversarial red-team pass. Ground-truth facts verified by direct file reads (citations inline).
- **Related:** [firecrawl-web-fetch-provider.md](./firecrawl-web-fetch-provider.md)

**Verdict up front:** The original 10-feature draft is ~3–4× oversized and mis-layered. It rested on **four mechanisms that do not exist as assumed**: an event/reaction hook, a cron execution engine, an agent-facing confirmation gate, and — the red-team's critical catch — **a `registerCommand` handler that can make HTTP calls**. It cannot: `PluginCommandContext` exposes no HTTP/fetch facility, and the handler runs in the **gateway plugin process**, not the proxy-governed sandbox whose egress the presets actually control. The broker pattern is also Nous-OAuth-specific, not a generic adapter, and the cited template explicitly punts on the static-token case. This plan re-layers the MVP onto the **agent's own proxy-governed tools**, gates every state-change behind the only non-bypassable control (host broker + host-side human approval), promotes the identity split and Discord tightening from "decisions" to **prerequisites**, and keeps one unambiguous Start here.

---

## Gated open decisions — resolve before execution

These are the red-team `mustFixBeforeExecuting` items that are **decisions, not in-plan resolutions**. Each blocks the phase named. Nothing in that phase starts until the decision is recorded with the stated evidence.

| # | Gate | Why it blocks | Required resolution before proceeding | Blocks |
|---|---|---|---|---|
| **G-1 — Egress layer for Forge's network calls** | **CRITICAL.** `registerCommand` cannot make HTTP calls (`PluginCommandContext` has no client; runs in the gateway, not the proxy-governed sandbox). The whole MVP was layered here. | Until this is empirically pinned, every networked feature (#1 `/status`, #1+NocoDB, #9) is built on a surface that cannot reach the network through the preset model. | In a throwaway sandbox, empirically confirm the home for Forge's web calls is the **agent's native tools invoked in an agent turn** (governed by the L7 proxy + presets), not a gateway command handler. Record: which native tool reaches an allow-listed host through which preset, and that a `registerCommand` handler is **prompt/UX glue only** (formats a turn, never fetches). | P1 (all), P2 (all) |
| **G-2 — Read/write identity split (was OD-2)** | High. Phase 1 would ship GitHub `access: full` + git egress, and Phase 2 keeps full Discord write CRUD, while both are untrusted-content ingestion surfaces. One injection must not reach write+broker authority. | A single agent identity holding read+write tokens turns any ingested ticket/issue/message into an exfil/action path. | **Decide: split identities.** Read-only surface (status, onboarding, memory, reporting) carries only read-scoped tokens. Any write surface is a separate, separately-gated identity with actor verification. Record the split before any ingestion surface ships. | P1.3, all of P2, all writes |
| **G-3 — No destructive-action gate exists** | High. `grep` of `nemoclaw/src` for confirm/approval/destructive is empty. NocoDB-write and Discord-write are reachable by an injected prompt; an L7 path rule bounds *which* endpoint, never *whether* the action was attacker-induced. | The plan's own stated "only non-bypassable gate" (host broker + host-side human approval) does not exist yet. Shipping any write without it is a confused-deputy state-change path. | **Decide and build the gate before any write/state-change feature.** No NocoDB PATCH, no Discord-write-on-reaction, no mail-send until a host-side human-approval step exists for that action. Until then, all write features stay **read-only / suggest-only**. | P2 writes, P4, P5, #9 writes |
| **G-4 — Discord preset must be tightened first (was OD-7, "optional")** | High. Shipped `discord.yaml` grants GET/POST/PUT/PATCH on `/**`. Discord is simultaneously the untrusted **inbound** ingestion surface and the **outbound** action surface — a direct injection-to-action channel. Bot tokens are guild/role bitfields, not "read-only"; "logic-layer constraint" is bypassable by the same injection. | "Tighten later" leaves the MVP with full Discord write CRUD reachable by injected text. | **Prerequisite, not optional.** Tighten `discord.yaml` to per-path/per-method rules (outbound-post only for MVP) as an upstream PR with a `policies.test.ts` assertion **before** Discord is used as either surface. Also constrain the bot's guild role to minimum (post to the one channel). | P2.2 |
| **G-5 — NocoDB tier & resolved IP (was OD-1, now possibly self-contradictory)** | High. If NocoDB resolves to RFC1918 / host-local, it needs the `allowed_ips` block (or it ships broken at the SSRF guard) **and**, by this plan's own Proxmox logic, reaching an internal control-plane host is broadening internal egress → it should be **broker-only (Tier C)**, not a Tier B direct preset. | The MVP's flagship feature has an unresolved, potentially self-contradictory tier. | **Pin the resolved IP** (not "cloud vs host"). Then apply the rule below uniformly: **external-public** → Tier B direct read preset; **RFC1918 / host-local** → **Tier C broker-only** (same scrutiny as Proxmox), never a direct LAN preset with blanket `allowed_ips`. Record the IP and resulting tier. | P2.1 |
| **G-6 — Scheduling substrate (was OD-6)** | Medium-high. Cron is provisioned but has **no execution engine** in-tree; `registerService` is declared-but-never-invoked, gateway-resident, no timer, cannot run an LLM turn. | Every "proactive"/scheduled feature depends on a substrate that is unverified. | Phase 3 verification gate (below). If cron does not fire-and-complete a multi-tool turn, scheduling moves **host-side (host cron → Discord poke)**. Do **not** build a `registerService` polling loop (security regression). | P3, all proactive |

**Additional `mustFix` items resolved inline (not gates):**

- **redact() is not an injection filter** (red-team, confirmed): `redact.ts` is a secret/credential redactor. The claim "on-ingest redaction blocks stored-injection re-feed" was **false and is removed**. Memory writes still route through `redact()` for *secret* hygiene, but stored-injection is mitigated separately via **content-provenance tagging** (treat memory-sourced text as untrusted data) and the advisory trust-boundary in `runtime-context.ts`. See P0.3 and Section 5.
- **`before_tool_call` reliability** (red-team, confirmed at :378-380): demoted from "defense-in-depth layer" to "**unverified, best-effort, no-op-on-version-drift**." It is given the same empirical-verification requirement as cron (P0.4) and is **never counted as a control** anywhere in the plan.

---

## 0. Ground truth (verified against the tree)

These facts override any conflicting claim in the source assessments. Confirmed by direct file reads, cited inline.

| Fact | Evidence | Consequence |
|---|---|---|
| **`registerCommand` handlers expose NO HTTP/fetch and run in the GATEWAY process**, not the proxy-governed sandbox. `PluginCommandContext` = `{senderId, channel, isAuthorizedSender, args, commandBody, config, from, to, accountId}`; `PluginCommandResult` = `{text, mediaUrl, mediaUrls}`. The only in-tree handler does string/status work. | `index.ts:81–99,349` | **The MVP cannot do "REST fetches in a registerCommand handler."** Networked work belongs to the **agent's native tools in an agent turn** (proxy + preset governed). `registerCommand` is **prompt/UX glue only.** |
| Plugin exposes **exactly two hooks** (`before_tool_call`, `before_prompt_build`) + three registrations (`registerCommand`, `registerProvider`, `registerService`). **No message/reaction/event hook.** | `index.ts:160,166,189–191` | All "react-to-X" / "keyword-trigger" features have **no native event mechanism.** |
| The only in-tree `before_tool_call` use blocks **secrets in memory-file writes** (#1233): inspects file-write params, **not HTTP egress**, synchronous allow/block (`BeforeToolCallResult = params \| block \| blockReason`). **Registration is try/catch-wrapped and becomes a silent no-op if the hook contract drifts.** | `index.ts:341,374–421` (no-op note at :378–380) | A `before_tool_call` gate **cannot ask a human**, does not see a NocoDB `PATCH`, and **is not even guaranteed to fire.** Never counted as a control. |
| `registerService` exists as `PluginService { id, start, stop }` — **declared, never invoked** in `register()`; only mocked in tests. No timer primitive. `start()` runs **in the gateway load path** (safety-scanner-gated), plain TS, **cannot run an LLM turn.** | `index.ts:145–149,191` (not in `register()` at :343+) | registerService is **as unverified as cron**, in the most-privileged process, and is **not a scheduler.** |
| **Cron is provisioned and persisted but has no execution engine in this repo.** Refs: dir creation (`Dockerfile.base:120`), backup/restore (`commands.mdx:200`, `nemoclaw-start.sh:2486`), secret-scanner path (`secret-scanner.ts:118`), shields immutable-state (`shields/index.ts:315`). **No code reads or runs `schedule.json`.** | grep, above | Cron is **PROVISIONED + UNVERIFIED-as-execution-engine.** Every scheduled feature is gated on an empirical proof it fires *and* completes a tool-using turn without the documented hang. |
| Policy schema `protocol` enum is **exactly `["rest","websocket"]`.** No SSH / IMAP / SMTP / raw-TCP / unix-socket. | `schemas/policy-preset.schema.json:51` | Proxmox SSH (:22), Proton Bridge (IMAP/SMTP), Podman socket are **structurally inexpressible** — infeasible. |
| `host.openshell.internal` endpoints require an `allowed_ips: [10/8,172.16/12,192.168/16]` block or the **SSRF guard rejects them at runtime** (passes schema, fails live). | `local-inference.yaml:13–20`; schema `allowed_ips` at `:57` | Any privately-resolving host preset written like `github.yaml` **ships broken.** Drives G-5. |
| `github.yaml` = `access: full`, **no per-method rules** (also whitelists `/usr/bin/git` to github.com:443). `jira.yaml` = GET/POST on `/**` (no PATCH). `discord.yaml` = GET/POST/PUT/PATCH on `/**` + scoped DELETE. | preset files | GitHub **cannot be method-scoped at the preset layer** (token-scope + identity split instead). **`discord.yaml` already grants full write CRUD** — a liability (G-4). |
| The host broker is a **Nous OAuth refresh-token rotation broker**: `grant_type=refresh_token`, `x-nous-refresh-token`, `*.nousresearch.com`, `timingSafeEqual`, `STRIPPED_SECRET_HEADERS`, fixed Nous gateways on `:11436`. | `tool-gateway-broker.ts:307,315,155–180,84`; `managed-tool-gateway-matrix.json` | Static-token services **do not fit.** A new broker is **net-new host credential-custody code** owned by `nemoclaw-deploy`. The firecrawl proposal's broker section is **hardwired to Nous and defers the keyed/static-token case** — it is **not** a static-token recipe. |
| **No confirmation / approval / destructive-action gate exists.** `grep nemoclaw/src` for confirm/approval/destructive is empty. | confirmed | The draft's "destructive actions require confirmation" describes **a control that does not exist** (G-3). Build at host layer, never in a prompt. |
| `redact.ts` is a **secret/credential redactor** (`redact`, `redactForLog`) — **not an instruction filter.** | `src/lib/security/redact.ts` | "On-ingest redaction blocks stored-injection" is **false.** Stored injection needs provenance tagging + untrusted-data treatment, not the secret redactor. |

---

## 1. Resolved conflicts (stated + why)

1. **Where does in-sandbox feature code live?** — **RESOLVED, re-layered after red-team.** Three distinct layers, never conflated: (a) **Agent native tools in an agent turn** = the *only* surface that can make egress through the L7 proxy + presets — **this is where all of Forge's network reads/writes happen.** (b) **`registerCommand` handler** = deterministic, testable, but **prompt/UX glue only** (formats/seeds a turn, applies `redact()` to text it returns, gates on `isAuthorizedSender`) — it does **not** fetch. (c) **`docs-to-skills.py`** = operator-facing guidance, used **only for Onboarding (#10)**. *Why the change:* the prior draft put "REST fetches" in `registerCommand`; `PluginCommandContext` has no HTTP facility and runs in the gateway, not the sandbox — confirmed at `index.ts:81–99`.
2. **Confirmation-gate mechanism?** — **RESOLVED toward Security.** `before_tool_call` is synchronous deny-only, HTTP-blind, **and may silently no-op** (`:378–380`). The only non-bypassable gate is **(i) L7-policy deny of the write verb/path** and **(ii) a host-side broker requiring host-side human approval.** `before_tool_call` is **not** counted as a control (G-3).
3. **Cron status?** — **RESOLVED: PROVISIONED + UNVERIFIED-AS-EXECUTION-ENGINE.** Gate every scheduled feature on a throwaway-sandbox proof. Until proven, scheduling is **host-side** (G-6, P3).
4. **registerService as the scheduler fallback?** — **RESOLVED: NO.** Unused, gateway-resident, no timer, cannot run an LLM turn. A polling loop in `start()` is a **security regression.** Prefer host-side scheduling.
5. **Proxmox direct-IP preset = "feasible-with-changes"?** — **RESOLVED: NO.** A direct preset to a LAN control-plane IP with RFC1918 `allowed_ips` broadens internal egress. **Host-broker-only or dropped.** SSH path infeasible (no transport). **This same rule now governs NocoDB (G-5).**
6. **Discord preset breadth.** — **RESOLVED, hardened.** Shipped `discord.yaml` grants GET/POST/PUT/PATCH `/**`. Tightening is **a prerequisite (G-4)**, not optional: Discord is both the untrusted inbound and the outbound action surface. Bot tokens are role bitfields, not "read-only"; logic-layer constraint is bypassable.
7. **Proton verdict** — **RESOLVED: infeasible-as-specified.** Undocumented, SRP-authenticated, E2E-encrypted web API → a preset yields ciphertext; Bridge is host-only IMAP/SMTP (no transport). **Drop Proton. Deliver via Discord.**
8. **GitHub read-scoping** — **RESOLVED:** not expressible (`access: full`, no method rules; git egress whitelisted). **Read-scope at the token layer (read-only PAT) AND under the read-only identity (G-2)** — token scope alone does not stop injected-text-driven exfil via GETs/git, so the identity split is the real control.

---

## 2. Re-scoped feasibility tiers

Each feature is a **layer stack**. Network work always lands on the **agent-native-tool layer** (per G-1); `registerCommand` only formats the turn.

### Tier A — Feasible in-sandbox now (verified mechanisms, ≤1 new read preset)

| Feature | Layers | Notes |
|---|---|---|
| **#10 Onboarding assistant** | `skill` (docs-to-skills) | The single legitimate `docs-to-skills` use. Operator guidance; zero egress beyond GitHub; zero blast radius. Cannot *drive* a local Podman env (host-only) — it instructs. **FIRST deliverable.** |
| **#5 Memory log + `/distill` (manual)** | `registerCommand` (UX glue) + `memory` (file I/O via agent tools) | Manual trigger. Writes routed through `redact()` for **secret** hygiene. **Stored-injection** mitigated by content-provenance tagging + trust-boundary text (not redact). Auto-distill deferred to scheduler gate; recursive distill needs idempotency+provenance spec. |
| **#1 Dashboard `/status` — GitHub-only** | `registerCommand` (formats turn) + **agent web/git tool** + existing `github.yaml` (+ read-only PAT, **read-only identity**) | On-demand only, in an agent turn. Read-only at network layer **but a prompt-injection ingestion surface** — rendered PR/issue text is untrusted DATA; redact output. **Ships only after G-1 + G-2.** |

### Tier B — Feasible-with-changes (build a new layer, all upstream-PR-able)

| Feature | Layers | Changes required |
|---|---|---|
| **#1 Dashboard — + NocoDB** | + `policy-preset` (`nocodb.yaml`) + `config-generator` (placeholder) + agent tool | **Only if NocoDB is external-public (G-5).** If RFC1918/host-local → **Tier C broker-only.** Read preset = **GET-only on the data path**; any write is a **separate** preset/token under the **write identity** and is blocked until G-3's gate exists. |
| **#4 Outbound Discord relay** + **#9 GitHub-only weekly summary** | `channel` (native Discord, **tightened per G-4**) + `registerCommand` (formats) | Outbound only. Reverse/reaction half **deferred** (no event hook). #9 covers the GitHub subset only; NocoDB/health/mail parts inherit harder tiers. |
| **#3 DevOps — Containerfile/compose lint only** | `registerCommand` + agent local-file parse | Static validation only. Build/run/exec/restart are host-only (Tier C/D). |
| **#8 Learning — suggest-only** | `registerCommand` + `web_search` (existing) + allow-listed content-host preset | Read/suggest only. Calendar-write half drops with Proton. Lowest priority. |

### Tier C — Needs a host-side broker (net-new host code in `nemoclaw-deploy`, ONE at a time)

| Feature | Why | What it takes |
|---|---|---|
| **NocoDB (if RFC1918/host-local)** | Reaching an internal host = internal-egress broadening (G-5, same rule as Proxmox) | Read-only host broker, not a direct LAN preset. |
| **#2 Calendar reminders** | Proton Calendar is host-only/E2E-encrypted | Effectively infeasible via Proton (Tier D). If any calendar source is a real HTTPS REST API, a read-only broker + preset. |
| **#6 Health monitoring** | Ubuntu VM state, Podman vulns, Proxmox load are **host-only** | A **read-only** host broker per source. Proxmox = read-only API role token behind a broker. **Cut from MVP** (3 host integrations). |
| **#9 Full reporting** | Fan-in of NocoDB + host health + mail | Inherits least-feasible input. GitHub→Discord subset is Tier B; the rest waits on brokers. |
| **Proxmox read-only metrics** | HTTPS:8006 exists but reaching a LAN control plane widens egress | Host broker scoped read-only at the source, NOT a direct-IP sandbox preset. |

**Broker reality (all of Tier C):** The Nous broker does **not** generalize (OAuth-refresh-specific). The firecrawl proposal's broker section is **hardwired to Nous and defers the keyed/static-token case** — it is a dual-layer-egress *concept* reference, **not a static-token recipe.** Each new broker is **net-new secure-service design**: opaque-token custody, `STRIPPED_SECRET_HEADERS`, `timingSafeEqual`, for a **static-token** read-only upstream. **Build exactly one first**, prove it, then template. Owned by `nemoclaw-deploy`, not the fork image. **v1 brokers are read-only — no write/restart endpoint (enforced in broker code, per G-3/OD-5).**

### Tier D — Infeasible in-sandbox (drop, or reframe entirely host-side)

| Feature | Why infeasible | What it would take |
|---|---|---|
| **#7 Incident playbook (keyword → restart)** | **Triple-blocked:** (a) no event/keyword hook; (b) container restart needs host Podman socket — no transport in schema; (c) untrusted text → destructive action = textbook confused deputy; "pre-approved" = auto-approval, worst case. | **CUT.** Future remediation = host-side runbook the agent only *requests*, with **human approval on the host.** Agent never holds restart capability. **Brokers must not add a restart endpoint (enforced in code).** |
| **Podman socket (build/run/exec/restart)** | Unix socket, no FQDN:port, schema can't express it; sandbox has no engine. | Operator-run `podman system service` (HTTPS REST) on host + broker — host infra, deploy-owned. Only **Containerfile lint + Trivy-DB-against-tarball** is sandbox-feasible. |
| **Proxmox SSH (:22)** | No SSH transport in schema. | Reframe as Proxmox REST (Tier C broker) or host-side. |
| **Proton Bridge (IMAP:1143/SMTP:1025)** | No IMAP/SMTP transport; host-only; E2E-encrypted web API. | Drop. Relay via Discord. |
| **System notifications** | Sandbox is not the host. | Relay via Discord. |

---

## 3. Layer map (every workstream → exactly one NemoClaw layer)

| Workstream | Layer | Apply-time | Upstream-PR-able? |
|---|---|---|---|
| Onboarding guide | `skill` (docs-to-skills) | rebuild/export | Yes if generic; else fork |
| **Network reads/writes (GitHub, NocoDB, Discord, content)** | **agent native tools in an agent turn** (L7-proxy + preset governed) | runtime (turn) | N/A (mechanism) |
| `/status`, `/distill`, lint, summary command UX | **`registerCommand`** (deterministic TS, **glue only — no fetch**) | image rebuild | Yes (with tests) |
| Daily log / weekly distill files | `memory` (agent file tools + provenance tags) | runtime (file I/O) | N/A (data) |
| `nocodb.yaml`, `content-source.yaml`, `trivy-db.yaml`, registry preset | `policy-preset` | **runtime** (`sandbox policy add`) or rebuild | Yes (with `policies.test.ts`) |
| **Tighten `discord.yaml` to per-path (prerequisite, G-4)** | `policy-preset` | rebuild | Yes (touches shipped/tested file) |
| Credential placeholders (`openshell:resolve:env:*`) | `config-generator` | **build-time only** (hash-locked) | Yes (with generator tests) |
| Outbound posting | **native `channel`** (Discord) | runtime | N/A (existing) |
| Truthful integration text + **untrusted-data trust boundary + memory-provenance note** | `runtime-context.ts` | image rebuild | Yes (static reads only) |
| Proxmox/Podman/Proton/NocoDB-if-internal custody | **`broker`** (net-new host code, read-only v1) | host deploy | Matrix-generalization = upstream; service config = fork |
| Scheduling | **`external-host`** (host cron → Discord) until cron proven | host deploy | N/A |
| Container/VM control | **`external-host`** (host runbook + human approval) | host deploy | N/A |

> **`cron` and `registerService` are intentionally NOT assigned as a layer for any feature.** Cron is provisioned-but-unproven (P3 gate); `registerService` is rejected (Conflict 4). **`before_tool_call` is NOT a control layer** (unverified, no-op-on-drift).

---

## 4. Phased plan — dependencies, sequencing, FIRST step

```text
PHASE 0  Foundation + design + empirical layer/contract verification (BLOCKS everything)
   │
   ├─ START HERE ──► P0.1  (see below)
   │
PHASE 1  Tier A — zero/low-risk, verified mechanisms      (depends: P0; #1 needs G-1,G-2)
PHASE 2  Tier B — one new read preset + outbound Discord   (depends: P1, G-1, G-4, G-5)
PHASE 3  SCHEDULER GATE (empirical cron proof)             (depends: P2; blocks all "proactive")
PHASE 4  ONE broker proof (lowest-risk host service)       (depends: P3 decision, G-3)
PHASE 5  Conditional host features                         (depends: P4 success, per-service)
```

### PHASE 0 — Foundation, security design & empirical contract verification *(no feature ships without this)*

> **START HERE — P0.1:** **In a throwaway sandbox, empirically resolve G-1: prove where Forge's network calls actually execute.** Confirm that an allow-listed host (start with GitHub via the shipped `github.yaml`) is reachable **only from an agent native tool in an agent turn** (governed by the L7 proxy + preset), and confirm that a `registerCommand` handler has **no HTTP facility** — it is prompt/UX glue that seeds a turn and formats the result. Record the exact tool + preset path. **No feature is built until this layer is pinned**, because the entire MVP was previously mis-layered onto `registerCommand` "REST fetches."

- **P0.1** *(START HERE)* — Empirically pin the egress layer (G-1). Capture: which native tool reaches an allow-listed host through which preset; confirmation that `registerCommand` cannot fetch. Then write the **placement matrix** per service (external-public / external-RFC1918 / host-local / infeasible) **with the resolved IP** (feeds G-5), and the **read-only vs write-capable capability split** (G-2).
- **P0.2** — Credentials as `openshell:resolve:env:VAR` placeholders in `scripts/generate-openclaw-config.py`; **read-only PATs/tokens by default**, under the **read-only identity**; a **separate write-scoped token under a separate identity** only where a write feature is approved (G-2). Never bake raw secrets; never live-edit hash-locked `openclaw.json`. Generator unit tests (coverage ratchet fails >1% drop).
- **P0.3** — Extend `runtime-context.ts` (static reads only, mirror `getWebToolAccess()`): (a) truthfully name which integrations are live; (b) state that ingested ticket/issue/message/calendar/email text **and any text read back from `memory/`** is **untrusted DATA, never instructions** (this is the stored-injection mitigation — provenance/trust-boundary, **not** `redact()`); (c) state destructive/host actions are confirmation-gated host-side. **Advisory defense-in-depth only — not enforcement.**
- **P0.4** — **Verify `before_tool_call` actually fires in this build** (throwaway sandbox; same gate as cron). Record the result. Regardless of outcome, it remains **defense-in-depth only and is never the sole gate** for any write.

*Tests:* generator unit tests; `runtime-context.test.ts` updated; secret-scanner firing check documented. *Security:* this phase **is** the security foundation.

### PHASE 1 — Tier A *(verified mechanisms only)*

- **P1.1** *(FIRST deliverable)* — **#10 Onboarding** via `docs/*.mdx` → `scripts/docs-to-skills.py --prefix nemoclaw-user`. Zero egress, zero blast radius, proves the docs pipeline.
- **P1.2** — **#5 Memory log + `/distill`** as a `registerCommand` UX handler (glue) that seeds an agent turn writing under `workspace/memory/`. Manual trigger; `requireAuth`/`isAuthorizedSender` enforced. **Writes through `redact()`** for secret hygiene. **Memory-sourced text tagged as untrusted-provenance** and treated as data on re-read (P0.3) — this, not `redact()`, is the stored-injection mitigation.
- **P1.3** — **#1 `/status` GitHub-only**: `registerCommand` formats a turn; the **agent's native tool** hits existing `github.yaml` with a **read-only PAT under the read-only identity**. Output redacted; rendered GitHub text treated as untrusted. **Blocked on G-1 (layer proof) and G-2 (identity split).**

*Depends on:* P0 (P1.3 also on G-1, G-2). *Tests:* `register.test.ts` for new commands; redaction-path assertions.

### PHASE 2 — Tier B

- **P2.0** *(prerequisite, G-4)* — **Tighten `discord.yaml`** to per-path/per-method rules (outbound-post only for MVP) as an upstream PR with a `policies.test.ts` assertion; minimize the bot's guild role. **Must land before P2.2.**
- **P2.1** — **#1 + NocoDB** *(only if G-5 resolves to external-public)*: author `nocodb.yaml` (read = **GET-only on the data path**; add `allowed_ips` only if the resolved IP is RFC1918 **and** G-5 still permits a direct preset — otherwise route to Tier C broker). Any **write** = separate PATCH-on-status-field preset + write token under the write identity, **disabled until G-3's host approval gate exists.** `policies.test.ts` per preset. Generator placeholder(s).
- **P2.2** — **#4 outbound relay + #9 GitHub-weekly-summary**: native Discord `channel` (**tightened, post-P2.0**), **outbound only.** Reverse/reaction half explicitly deferred (no event hook; needs verified actor identity).
- **P2.3** — **#3 Containerfile/compose lint** and **#8 suggest-only** as low-priority `registerCommand` + agent-tool features.

*Depends on:* P1, G-1, G-4 (P2.2), G-5 (P2.1). *Tests:* per-preset `policies.test.ts`; generator tests.

### PHASE 3 — SCHEDULER GATE *(blocks every "proactive" feature)*

- **P3.1** — In a **throwaway sandbox**, empirically prove whether OpenClaw runtime executes `.openclaw/cron/schedule.json` AND whether a cron-fired job can **complete a multi-tool-call agent turn without the documented tool-use hang.**
  - **PASS** → scheduled features (auto-distill, weekly summary push, Discord poll) may use cron.
  - **FAIL** → scheduling moves **host-side** (host cron → poke agent via Discord channel). **Do NOT** fall back to a `registerService` polling loop (gateway-resident, scanner-risk, no LLM in loop, security regression).

*Depends on:* P2. *Output:* documented, reproducible verification result.

### PHASE 4 — ONE broker proof

- **P4.1** — Pick the **single lowest-risk** read-only host service (likely NocoDB-if-internal or Proxmox read-only metrics). Build a host-side broker in `nemoclaw-deploy`: dual-layer egress (sandbox→broker allow-list AND broker→world allow-list), opaque sandbox token, broker holds the **read-only-scoped** real credential, strips secret headers, `timingSafeEqual` token check. **Treat as net-new secure-service design — the firecrawl proposal defers the static-token case, so there is no in-repo recipe.** **v1 broker is read-only; no write/restart endpoint, enforced in code (G-3/OD-5).** State-changing actions require G-3's host-side human approval before they exist at all.

*Depends on:* P3 scheduling decision (so polling has a home), G-3. *Do not parallelize brokers.*

### PHASE 5 — Conditional host features *(only after P4 proves the pattern)*

- **#6 health (read-only)**, **#8 calendar-block**, **#9 full reporting** — each gated individually on its read-only broker + the scheduler decision + (for any write/notify) G-3's approval gate. **#7 stays CUT.** Mail-send (if ever) requires a **fixed operator recipient allow-list at the broker** + redacted body + host approval (exfil control).

---

## 5. Security controls — inline per workstream

| Workstream | Token scope / identity | Secret custody | Destructive-action gating | Injection / confused-deputy mitigation |
|---|---|---|---|---|
| **`/status` GitHub** | read-only PAT, **read-only identity (G-2)** | `openshell:resolve:env`; never logged (`redact`) | N/A (read) | Egress only via agent tool through `github.yaml` (G-1); rendered PR/issue text = untrusted DATA; redact output; trust-boundary in `runtime-context.ts` |
| **NocoDB read** | read-only token, read-only identity | placeholder; hash-lock integrity | N/A | **Direct preset only if external-public (G-5);** else broker. GET-only; ticket bodies are data, never instructions |
| **NocoDB write** *(blocked until G-3)* | **separate** write token, **write identity** | placeholder; distinct from read | **DOES NOT SHIP until a host-side human-approval gate exists (G-3).** An L7 PATCH-path rule bounds *which* endpoint, never *whether* attacker-induced — it is **not** a sufficient gate | Never copy jira/discord `/**` shape; write only via the gated host path |
| **Memory** | none (file I/O) | n/a | N/A | **Writes through `redact()` for SECRETS only.** Stored-injection mitigated by **provenance tagging + untrusted-data trust boundary** (`runtime-context.ts`), **not** `redact()` (it is a secret redactor). Recursive distill needs idempotency+provenance before auto-mode |
| **Discord outbound** | bot token, **minimum guild role**, rewritten at proxy | `openshell:resolve:env:DISCORD_BOT_TOKEN` | N/A | **`discord.yaml` MUST be tightened to outbound-post-only first (G-4)** — bot tokens are role bitfields, "logic-layer" constraint is bypassable; redact all posts |
| **Discord reaction→write** *(deferred)* | write token, write identity | placeholder | Blocked until G-3 gate | No event hook exists; needs **verified reacting-user ID against operator allow-list**; if identity not reliably obtainable, **do not ship** |
| **Host brokers (NocoDB-internal / Proxmox / etc.)** | read-only source role | opaque sandbox token; **broker holds real cred, strips secret headers, `timingSafeEqual`** | **No write/restart endpoint in v1 brokers — enforced in code;** restart = host runbook + **human approval on host** | Dual-layer egress; broker allow-lists exact paths/methods; net-new custody code reviewed |
| **Mail send** *(if ever)* | n/a | broker | host approval (G-3) | **Fixed operator recipient allow-list at broker** (never agent-chosen); redacted body — exfil channel |
| **All output** | — | — | — | Route every Discord post / report / memory write / error through `redact()`/`redactForLog()`; **structured redacted action log** (actor, verb+path, time, result) for every state-changing call |

**Non-negotiables:**

- The **only non-bypassable gate** is L7-policy-deny (reachable HTTPS writes) + host-side human approval (host actions, G-3). A prompt or `before_tool_call` "ask first" is bypassable and **`before_tool_call` may silently no-op** (`index.ts:378–380`) — **never the sole control.**
- **All Forge network calls go through the agent's proxy-governed native tools (G-1)** — never a `registerCommand` handler (no HTTP facility; gateway-resident).
- **Never mutate `openclaw.json` at runtime** — shields tamper-detection compromises the sandbox. Credentials/tools via generator + `deploy.sh --onboard`; presets via `nemoclaw sandbox policy add` (runtime-OK).
- **Use documented commands only** (`sandbox recover`/`exec`/`doctor`/`logs`/`status`) — never `pkill`/`docker kill`/hand-run `nemoclaw-start`.

---

## 6. Tests & upstream-PR-ability

**Per change:**

- **Presets** → a `test/policies.test.ts` assertion of host/port/protocol/methods/`allowed_ips` (mirror the existing `11436` broker and `local-inference` assertions). Includes the **`discord.yaml` tightening** (G-4) and any new `nocodb.yaml`.
- **`registerCommand` handlers** → `register.test.ts`-style command-wiring tests + redaction-path unit tests + an assertion that the handler performs **no egress** (glue-only).
- **Generator** → unit coverage for each new `openshell:resolve:env` placeholder (coverage ratchet **fails on >1% drop**).
- **`runtime-context.ts`** → update `runtime-context.test.ts`; static-reads-only (must pass the install-time safety scanner — **no subprocess in load/prompt-build paths**). Assert the untrusted-data + memory-provenance text is present.
- **Memory** → redaction-on-write (secret) assertions + provenance-tag-on-write assertions.
- **Empirical gates (P0.1 G-1, P0.4 before_tool_call, P3 cron)** → documented, reproducible throwaway-sandbox results checked into the deploy repo's notes.
- Run `npm test` (root) **and** `cd nemoclaw && npm test`; `npm run typecheck:cli` + plugin `tsc`; `make check`. No real NVIDIA/external API calls in unit tests (mock them). Test agent/tool behavior in the **TUI** (the `--local`/gateway-routed path hangs on tool use).

**Upstream-PR-able (clean PRs from a feature branch off `main`, with tests):** new external read presets (`nocodb.yaml`, content-source, `trivy-db.yaml`, registry); generator credential placeholders; the **`discord.yaml` tightening**; a **generalized** broker-matrix extension; the injection/trust-boundary + memory-provenance additions to `runtime-context.ts`.

**Fork-only / `nemoclaw-deploy`-owned:** uhstray-specific service configs; host-side broker *services* (Proxmox/Podman/Proton/NocoDB-internal); host crontab; Forge-specific workspace `AGENTS.md`.

**Keep the fork mergeable:** Forge `registerCommand` glue and presets are additive/low-conflict; keep generic mechanisms separable from uhstray-specific config. (`CLAUDE.md` remains the recurring type-conflict on every `git merge upstream/main` — keep the fork file.)

---

## 7. What was cut, deferred, and dropped (so it isn't quietly re-added)

- **CUT entirely:** **#7 incident playbook** (untrusted trigger → destructive host action; triple-blocked; auto-approval is worst-case). A host broker fixes only the transport blocker — the no-event-hook and confused-deputy problems remain; **brokers must not add a restart endpoint.**
- **DROPPED (structurally infeasible):** Proxmox **SSH**, Proton **Bridge** (IMAP/SMTP), Podman **socket** — no transport in the schema; **system notifications** — sandbox is not the host; **Proton web API** — E2E-encrypted/SDK-gated (relay via Discord).
- **DEFERRED behind gates:** all "proactive"/scheduled behavior → **Phase 3 cron gate (G-6)**; all host data sources (#6 health, Proxmox metrics, #9 full reporting) → **Phase 4 broker proof**; Discord reverse-interaction → event-mechanism + verified actor identity; **all writes (NocoDB PATCH, Discord write, mail) → G-3 host-approval gate.**
- **DO NOT treat as available:** a `before_tool_call` confirmation gate (also may silently no-op); a `registerService` scheduler; a generic broker matrix; a `registerCommand` handler that makes HTTP calls; `redact()` as an injection filter; an inbound webhook path to the sandbox (no inbound network).

---

**Net shape:** prove the egress layer first (the MVP was mis-layered onto a no-HTTP gateway handler) → a 3-feature MVP on verified mechanisms run as agent turns (Onboarding, manual Memory+`/distill`, on-demand GitHub `/status` under a read-only identity) → tighten Discord + one new read preset + outbound Discord → a hard scheduler-verification gate → one proven read-only broker, with **every write blocked behind a real host-side approval gate** before any host feature. Realistic for one assistant, security-first, and upstream-PR-able.

---

## Key files for the executing team

- `nemoclaw/src/index.ts` — hooks + registrations; **`PluginCommandContext`/`PluginCommandResult` at :81–99 (NO HTTP facility)**; `PluginService` at :145; `before_tool_call` at :374 with **no-op-on-drift note at :378–380**
- `nemoclaw/src/runtime-context.ts` — the only behavior hook; extend for integration truth + untrusted-data trust boundary + memory provenance
- `scripts/generate-openclaw-config.py` — credential placeholders, build-time, hash-locked
- `scripts/docs-to-skills.py` — operator skills only (Onboarding)
- `nemoclaw-blueprint/policies/presets/` — `github.yaml` (access:full + git egress), `jira.yaml`, `discord.yaml` (**wide — tighten, G-4**), `local-inference.yaml` (`allowed_ips` template); new `nocodb.yaml` here
- `schemas/policy-preset.schema.json` — protocol enum `rest|websocket` at :51; `allowed_ips` at :57
- `agents/hermes/host/tool-gateway-broker.ts` + `managed-tool-gateway-matrix.json` — Nous-OAuth broker (pattern reference, **not** a static-token recipe)
- `proposals/firecrawl-web-fetch-provider.md` — dual-layer-egress concept; **its broker section is hardwired to Nous and defers the static-token case**
- `src/lib/security/redact.ts` — **secret/credential redactor only (NOT an injection filter)**; mandatory output/memory secret hygiene
- `test/policies.test.ts`, `nemoclaw/src/security/secret-scanner.ts:118` (cron-as-memory-path), `Dockerfile.base:120` (cron dir provisioned, no execution engine)
