// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NemoClawState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

vi.mock("./blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

import { loadState } from "./blueprint/state.js";
import { getRuntimeSummary, getWebToolAccess, registerRuntimeContext } from "./runtime-context.js";

const mockedLoadState = vi.mocked(loadState);

const DENY_LINE =
  "arbitrary outbound network is deny-by-default — you do NOT have unrestricted internet or host access";

const NO_WEB = { searchEnabled: false, searchProvider: null, fetchEnabled: false } as const;

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function blankState(patch: Partial<NemoClawState> = {}): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
    ...patch,
  };
}

type MockOpenClawPluginApi = OpenClawPluginApi & {
  _trigger: (name: string, ...args: readonly unknown[]) => Promise<unknown>;
};

function createMockApi(): MockOpenClawPluginApi {
  const hooks = new Map<string, (...args: readonly unknown[]) => unknown>();
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn((name, handler) => {
      hooks.set(name, handler as (...args: readonly unknown[]) => unknown);
    }),
    _trigger: async (name: string, ...args: readonly unknown[]) => hooks.get(name)?.(...args),
  } as MockOpenClawPluginApi;
}

describe("getWebToolAccess", () => {
  it("reads enabled web tools + provider from openclaw.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rtc-"));
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        tools: { web: { search: { enabled: true, provider: "brave" }, fetch: { enabled: true } } },
      }),
    );
    expect(getWebToolAccess(cfg)).toEqual({
      searchEnabled: true,
      searchProvider: "brave",
      fetchEnabled: true,
    });
  });

  it("returns all-disabled when the config is missing or unreadable", () => {
    expect(getWebToolAccess(path.join(os.tmpdir(), "does-not-exist-openclaw.json"))).toEqual(
      NO_WEB,
    );
  });
});

describe("getRuntimeSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("returns deny-by-default context with no web tools for the configured sandbox", async () => {
    const summary = await getRuntimeSummary(defaultConfig, NO_WEB);

    expect(summary.sandboxName).toBe("openclaw");
    expect(summary.sandboxPhase).toBeNull();
    expect(summary.networkLines).toContain(DENY_LINE);
    expect(summary.networkLines.some((l) => l.includes("web search IS available"))).toBe(false);
    expect(summary.networkLines.some((l) => l.includes("web_fetch is allowlist-only"))).toBe(false);
    expect(summary.filesystemLines).toContain(
      "filesystem/process access is sandboxed; do not assume host-level access",
    );
  });

  it("advertises web_search and the web_fetch allowlist when those tools are enabled", async () => {
    const summary = await getRuntimeSummary(defaultConfig, {
      searchEnabled: true,
      searchProvider: "brave",
      fetchEnabled: true,
    });

    expect(summary.networkLines).toContain(DENY_LINE); // deny-by-default still the baseline
    expect(
      summary.networkLines.some(
        (l) => l.includes("web search IS available") && l.includes("brave"),
      ),
    ).toBe(true);
    expect(
      summary.networkLines.some(
        (l) => l.includes("web_fetch is allowlist-only") && l.includes("allow-listed"),
      ),
    ).toBe(true);
  });

  it("always includes the untrusted-data trust boundary and host-gated-action posture", async () => {
    const summary = await getRuntimeSummary(defaultConfig, NO_WEB);

    // (b) ingested external content + memory-read text are untrusted DATA, not instructions
    expect(summary.trustBoundaryLines.some((l) => l.includes("untrusted DATA"))).toBe(true);
    expect(summary.trustBoundaryLines.some((l) => l.includes("memory/ files"))).toBe(true);
    // (c) destructive/host actions are confirmation-gated host-side
    expect(summary.trustBoundaryLines.some((l) => l.includes("host-side human approval"))).toBe(
      true,
    );
  });

  it("prefers the persisted sandbox name when available", async () => {
    mockedLoadState.mockReturnValue(blankState({ sandboxName: "my-assistant" }));

    const summary = await getRuntimeSummary(defaultConfig, NO_WEB);

    expect(summary.sandboxName).toBe("my-assistant");
  });

  it("falls back to plugin config when state cannot be read", async () => {
    mockedLoadState.mockImplementation(() => {
      throw new Error("state unavailable");
    });

    const summary = await getRuntimeSummary(defaultConfig, NO_WEB);

    expect(summary.sandboxName).toBe("openclaw");
  });
});

describe("registerRuntimeContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
  });

  it("registers a before_prompt_build hook", () => {
    const api = createMockApi();

    registerRuntimeContext(api, defaultConfig);

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  it("prepends NemoClaw runtime context with the expected sections", async () => {
    const api = createMockApi();
    registerRuntimeContext(api, defaultConfig);

    const result = (await api._trigger("before_prompt_build", {}, {})) as {
      prependContext: string;
    };

    expect(result.prependContext).toContain("<nemoclaw-runtime>");
    expect(result.prependContext).toContain('OpenShell sandbox "openclaw"');
    expect(result.prependContext).toContain("Network policy:");
    expect(result.prependContext).toContain("Filesystem policy:");
    expect(result.prependContext).toContain("Trust boundary:");
    expect(result.prependContext).toContain("untrusted DATA");
    expect(result.prependContext).toContain("Behavior:");
    expect(result.prependContext).toContain("</nemoclaw-runtime>");
  });

  it("uses the persisted sandbox name in the injected context", async () => {
    mockedLoadState.mockReturnValue(blankState({ sandboxName: "my-assistant" }));
    const api = createMockApi();
    registerRuntimeContext(api, defaultConfig);

    const result = (await api._trigger("before_prompt_build", {}, {})) as {
      prependContext: string;
    };

    expect(result.prependContext).toContain('OpenShell sandbox "my-assistant"');
  });
});
