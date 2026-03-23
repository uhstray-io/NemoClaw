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

  it("exits with usage when no sandbox name provided", () => {
    const result = spawnSync("bash", ["-lc", `
      bash "${SETUP_DNS_PROXY}" nemoclaw
    `], {
      encoding: "utf-8",
      env: { ...process.env, SETUP_DNS_PROXY },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Usage:/i);
  });

  it("references CoreDNS service IP and upstream DNS", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain('COREDNS_SERVICE_IP="10.43.0.10"');
    expect(content).toContain('DNS_UPSTREAM="8.8.8.8"');
  });

  it("adds CoreDNS service IP as local address in pod", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("ip addr add");
    expect(content).toContain("COREDNS_SERVICE_IP");
  });

  it("deploys a Python DNS forwarder to the pod", () => {
    const content = fs.readFileSync(SETUP_DNS_PROXY, "utf-8");
    expect(content).toContain("dns-proxy.py");
    expect(content).toContain("socket.SOCK_DGRAM");
    expect(content).toContain("kctl exec");
  });
});
