// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

interface WebToolAccess {
  searchEnabled: boolean;
  searchProvider: string | null;
  fetchEnabled: boolean;
}

interface RuntimeSummary {
  sandboxName: string;
  sandboxPhase: string | null;
  networkLines: string[];
  filesystemLines: string[];
}

const STATIC_FILESYSTEM_LINES = [
  "filesystem/process access is sandboxed; do not assume host-level access",
];

/**
 * Resolve the agent's openclaw.json path without shelling out. OpenShell sets
 * OPENCLAW_HOME to the sandbox home (with .openclaw beneath it); fall back to
 * the process home directory.
 */
function openclawConfigPath(): string {
  const home = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  return path.join(home, ".openclaw", "openclaw.json");
}

/**
 * Read which web tools are enabled from openclaw.json. This is a static file
 * read only (no subprocess) so the gateway-loaded plugin still passes
 * OpenClaw's install-time safety scanner. Returns all-disabled on any
 * read/parse error so the runtime context degrades to deny-by-default.
 */
export function getWebToolAccess(configPath: string = openclawConfigPath()): WebToolAccess {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      tools?: {
        web?: {
          search?: { enabled?: boolean; provider?: string };
          fetch?: { enabled?: boolean };
        };
      };
    };
    const web = cfg.tools?.web;
    return {
      searchEnabled: web?.search?.enabled === true,
      searchProvider: typeof web?.search?.provider === "string" ? web.search.provider : null,
      fetchEnabled: web?.fetch?.enabled === true,
    };
  } catch {
    return { searchEnabled: false, searchProvider: null, fetchEnabled: false };
  }
}

/**
 * Build the network-policy lines, reflecting which web tools are actually
 * enabled. Deny-by-default remains the baseline for *arbitrary* access, but we
 * tell the agent the truth about the specific tools it does have — otherwise it
 * refuses to use a working web_search and never reaches the web_fetch allowlist.
 */
function buildNetworkLines(web: WebToolAccess): string[] {
  const lines = [
    "arbitrary outbound network is deny-by-default — you do NOT have unrestricted internet or host access",
    "blocked requests return proxy 403 and require an operator allowlist/policy change",
  ];
  if (web.searchEnabled) {
    const provider = web.searchProvider ? ` (provider: ${web.searchProvider})` : "";
    lines.push(
      `web search IS available: use the web_search tool${provider} for internet/web queries — it routes through an approved search API and works, so do not refuse web search`,
    );
  }
  if (web.fetchEnabled) {
    lines.push(
      "web_fetch is allowlist-only: it may ONLY retrieve operator-approved (allow-listed) URLs — never attempt arbitrary URLs; a denied fetch means the host is not on the allowlist (ask the operator to add it in OpenShell)",
    );
  }
  return lines;
}

/**
 * Resolves the active sandbox name by preferring the persisted state value
 * over the plugin configuration default.
 */
function getSandboxName(pluginConfig: NemoClawConfig): string {
  return loadState().sandboxName ?? pluginConfig.sandboxName;
}

/**
 * Returns sandbox context without invoking OpenShell subprocesses.
 *
 * The gateway-loaded plugin must pass OpenClaw's install-time safety scanner,
 * so this avoids shelling out — sandbox name comes from persisted state and
 * enabled web tools come from a static read of openclaw.json. `webAccess` is
 * injectable for testing.
 */
export function getRuntimeSummary(
  pluginConfig: NemoClawConfig,
  webAccess: WebToolAccess = getWebToolAccess(),
): RuntimeSummary {
  let sandboxName = pluginConfig.sandboxName;
  try {
    sandboxName = getSandboxName(pluginConfig);
  } catch {
    // Keep the configured default if persisted state cannot be read.
  }

  return {
    sandboxName,
    sandboxPhase: null,
    networkLines: buildNetworkLines(webAccess),
    filesystemLines: STATIC_FILESYSTEM_LINES,
  };
}

function buildRuntimeContextText(summary: RuntimeSummary): string {
  const lines = [
    "<nemoclaw-runtime>",
    `You are running inside OpenShell sandbox "${summary.sandboxName}" via NemoClaw.`,
    "Treat this as a sandboxed environment, not unrestricted host access.",
    summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
    "Network policy:",
    ...summary.networkLines.map((line) => `- ${line}`),
    "Filesystem policy:",
    ...summary.filesystemLines.map((line) => `- ${line}`),
    "Behavior:",
    "- Use the tools listed under Network policy (e.g. web_search / web_fetch) instead of assuming you have no access.",
    "- Do not claim unrestricted host or internet access; only the listed tools and allow-listed hosts are reachable.",
    "- web_fetch only works for allow-listed URLs; if a request is blocked, say it is blocked and ask the operator to adjust the allowlist/policy in OpenShell.",
    "</nemoclaw-runtime>",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

/**
 * Registers a `before_prompt_build` hook that prepends a `<nemoclaw-runtime>`
 * context block to each agent turn. Web-tool availability is re-read per turn
 * so the context reflects the live openclaw.json config.
 */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_prompt_build", () => ({
    prependContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig)),
  }));
}
