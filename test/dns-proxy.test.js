// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SETUP_DNS_PROXY = path.join(import.meta.dirname, "..", "scripts", "setup-dns-proxy.sh");
const RUNTIME_SH = path.join(import.meta.dirname, "..", "scripts", "lib", "runtime.sh");

describe("setup-dns-proxy.sh", () => {
  it("exists and is executable", () => {
    const stat = fs.statSync(SETUP_DNS_PROXY);
    expect(stat.isFile()).toBe(true);
    // Check executable bit (owner)
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("sources runtime.sh successfully", () => {
    const result = spawnSync("bash", ["-lc", `source "${RUNTIME_SH}"; echo ok`], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("exits with error when no gateway container is found", () => {
    // Run the script with a fake docker that returns no containers
    const result = spawnSync("bash", ["-lc", `
      docker() {
        case "$1" in
          ps) echo "" ;;
          *) command docker "$@" 2>/dev/null ;;
        esac
      }
      export -f docker
      bash "${SETUP_DNS_PROXY}" nonexistent-gateway
    `], {
      encoding: "utf-8",
      env: { ...process.env, SETUP_DNS_PROXY, DOCKER_HOST: "unix:///nonexistent" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Could not find/i);
  });

  it("uses correct iptables DNAT target for sandbox subnet", () => {
    // Verify the script references the expected sandbox subnet and CoreDNS IP
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain('SANDBOX_SUBNET="10.200.0.0/24"');
    expect(content).toContain('COREDNS_SERVICE_IP="10.43.0.10"');
  });

  it("uses idempotent iptables operations", () => {
    // Verify the script checks before adding rules (iptables -C before -A/-I)
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("iptables -t \"$table\" -C \"$chain\"");
  });

  it("falls back to public DNS when CoreDNS pod IP is unavailable", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain('COREDNS_POD_IP="8.8.8.8"');
  });
});
