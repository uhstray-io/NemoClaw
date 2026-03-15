#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, "scripts");
const CREDS_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");

function run(cmd, opts = {}) {
  spawnSync("bash", ["-c", cmd], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
}

// ── Credential management ─────────────────────────────────────────

function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCredential(key, value) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const creds = loadCredentials();
  creds[key] = value;
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function getCredential(key) {
  // env var takes priority, then saved creds
  if (process.env[key]) return process.env[key];
  const creds = loadCredentials();
  return creds[key] || null;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureApiKey() {
  let key = getCredential("NVIDIA_API_KEY");
  if (key) {
    process.env.NVIDIA_API_KEY = key;
    return;
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NVIDIA API Key required                           │");
  console.log("  │                                                     │");
  console.log("  │  1. Go to https://build.nvidia.com                 │");
  console.log("  │  2. Sign in with your NVIDIA account               │");
  console.log("  │  3. Click any model → 'Get API Key'                │");
  console.log("  │  4. Paste the key below (starts with nvapi-)       │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  key = await prompt("  NVIDIA API Key: ");

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    process.exit(1);
  }

  saveCredential("NVIDIA_API_KEY", key);
  process.env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

async function ensureGithubToken() {
  let token = getCredential("GITHUB_TOKEN");
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  // Try gh CLI
  try {
    token = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return;
    }
  } catch {}

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (for container images)      │");
  console.log("  │                                                     │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)      │");
  console.log("  │  Option B: Paste a PAT with read:packages scope    │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  token = await prompt("  GitHub Token: ");

  if (!token) {
    console.error("  Token required for deploy.");
    process.exit(1);
  }

  saveCredential("GITHUB_TOKEN", token);
  process.env.GITHUB_TOKEN = token;
  console.log("");
  console.log("  Token saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

// ── Commands ──────────────────────────────────────────────────────

async function setup() {
  await ensureApiKey();
  run(`bash "${SCRIPTS}/setup.sh"`);
}

async function deploy(instanceName) {
  await ensureApiKey();
  await ensureGithubToken();

  const name = instanceName || "nemoclaw";
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execSync("which brev", { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execSync("brev ls 2>&1", { encoding: "utf-8" });
    exists = out.includes(name);
  } catch {}

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${name} --gpu "${gpu}"`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  console.log("  Waiting for SSH...");
  run(`brev shell ${name} -- echo ready`, { stdio: "ignore" });

  console.log("  Syncing NemoClaw to VM...");
  run(`brev copy ${name} "${ROOT}" --dest /home/ubuntu/nemoclaw`);

  console.log("  Running brev-setup.sh...");
  run(`brev shell ${name} -- bash -c 'cd /home/ubuntu/nemoclaw && NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY}" GITHUB_TOKEN="${process.env.GITHUB_TOKEN}" bash scripts/brev-setup.sh'`);

  const tgToken = getCredential("TELEGRAM_BOT_TOKEN");
  if (tgToken) {
    console.log("  Starting services...");
    run(`brev shell ${name} -- bash -c 'cd /home/ubuntu/nemoclaw && NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY}" TELEGRAM_BOT_TOKEN="${tgToken}" bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Deploy complete. Connect:");
  console.log(`    brev shell ${name}`);
  console.log("");
}

async function start() {
  await ensureApiKey();
  run(`bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
}

function status() {
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function help() {
  console.log(`
  nemoclaw — NemoClaw CLI

  Usage:
    nemoclaw setup                 Set up locally (gateway, providers, sandbox)
    nemoclaw deploy [name]         Deploy to a Brev VM and start services
    nemoclaw start                 Start services (JensenClaw, Telegram, tunnel)
    nemoclaw stop                  Stop all services
    nemoclaw status                Show service status

  Credentials are prompted on first use, then saved securely
  in ~/.nemoclaw/credentials.json (mode 600).

  Quick start:
    npm install nemoclaw
    npx nemoclaw setup
`);
}

// ── Dispatch ──────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  switch (cmd) {
    case "setup":   await setup(); break;
    case "deploy":  await deploy(args[0]); break;
    case "start":   await start(); break;
    case "stop":    stop(); break;
    case "status":  status(); break;
    case "--help":
    case "-h":
    case "help":
    case undefined: help(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exit(1);
  }
})();
