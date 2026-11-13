/**
 * Self-update for pi-zcode-provider itself (when installed via omp/pi or git checkout).
 *
 * - Linked local checkout with no git remote / unmanaged install → reports "unmanaged" silently.
 * - Git checkout with remote → checks `git fetch` / fast-forward pull when requested or on interval.
 * - npm install under node_modules → checks npm registry and upgrades via `omp plugin update` / `pi update`.
 * - Opt out via OMP_ZCODE_AUTO_UPDATE=0.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "pi-zcode-provider";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const CMD_TIMEOUT_MS = 120_000;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export type InstallKind = "omp" | "pi" | "git" | "unmanaged";
export type UpdateStatus = "current" | "updated" | "failed" | "unavailable" | "throttled" | "unmanaged" | "disabled";

export interface UpdateResult {
  status: UpdateStatus;
  kind: InstallKind;
  current: string;
  latest: string | null;
  detail?: string;
}

interface UpdateState {
  checkedAt: number;
  latest: string | null;
  lastError: string | null;
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function statePath(): string {
  return join(homedir(), ".zcode", "pi-zcode-provider-update.json");
}

function readVersion(root: string): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string") {
      return raw.version.trim();
    }
  } catch { /* ignore */ }
  return "0.0.0";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectInstall(root = packageRoot()): { kind: InstallKind; version: string; root: string } {
  const version = readVersion(root);
  const normalized = resolve(root).replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.omp/") && normalized.includes("/node_modules/") && !existsSync(join(root, ".git"))) {
    return { kind: "omp", version, root };
  }
  if (normalized.includes("/.pi/") && normalized.includes("/node_modules/") && !existsSync(join(root, ".git"))) {
    return { kind: "pi", version, root };
  }
  if (existsSync(join(root, ".git"))) {
    return { kind: "git", version, root };
  }
  return { kind: "unmanaged", version, root };
}

function readState(): UpdateState {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      return {
        checkedAt: typeof r["checkedAt"] === "number" ? r["checkedAt"] : 0,
        latest: typeof r["latest"] === "string" ? r["latest"] : null,
        lastError: typeof r["lastError"] === "string" ? r["lastError"] : null,
      };
    }
  } catch { /* ignore */ }
  return { checkedAt: 0, latest: null, lastError: null };
}

function writeState(state: UpdateState): void {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch { /* ignore */ }
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
    resolve({ code: 1, output: out + "\nTimed out" });
  }, CMD_TIMEOUT_MS);
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += String(d); });
  child.on("error", (err) => {
    clearTimeout(timer);
    resolve({ code: 1, output: err.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? 1, output: out.trim() });
  });
  return promise;
}

export async function maybeAutoUpdate(options: { force?: boolean } = {}): Promise<UpdateResult> {
  if (process.env.OMP_ZCODE_AUTO_UPDATE === "0") {
    return { status: "disabled", kind: "unmanaged", current: "0.0.0", latest: null };
  }

  const info = detectInstall();
  if (info.kind === "unmanaged") {
    return { status: "unmanaged", kind: info.kind, current: info.version, latest: null };
  }

  const state = readState();
  if (!options.force && Date.now() - state.checkedAt < CHECK_TTL_MS) {
    return { status: "throttled", kind: info.kind, current: info.version, latest: state.latest };
  }

  if (info.kind === "git") {
    const remoteRes = await runCommand("git", ["remote"], info.root);
    if (remoteRes.code !== 0 || !remoteRes.output.trim()) {
      writeState({ checkedAt: Date.now(), latest: null, lastError: null });
      return { status: "unmanaged", kind: "git", current: info.version, latest: null, detail: "no git remote" };
    }
    const fetchRes = await runCommand("git", ["fetch", "--quiet"], info.root);
    if (fetchRes.code !== 0) {
      writeState({ checkedAt: Date.now(), latest: null, lastError: fetchRes.output });
      return { status: "unavailable", kind: "git", current: info.version, latest: null, detail: fetchRes.output };
    }
    const statusRes = await runCommand("git", ["status", "-sb"], info.root);
    if (!statusRes.output.includes("behind")) {
      writeState({ checkedAt: Date.now(), latest: info.version, lastError: null });
      return { status: "current", kind: "git", current: info.version, latest: info.version };
    }
    const pullRes = await runCommand("git", ["pull", "--ff-only"], info.root);
    const nextVersion = readVersion(info.root);
    writeState({ checkedAt: Date.now(), latest: nextVersion, lastError: pullRes.code === 0 ? null : pullRes.output });
    return pullRes.code === 0
      ? { status: "updated", kind: "git", current: info.version, latest: nextVersion }
      : { status: "failed", kind: "git", current: info.version, latest: null, detail: pullRes.output };
  }

  // omp / pi npm package check
  let latest: string | null = null;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "version" in body && typeof body.version === "string") {
      const candidate = body.version.trim();
      if (SEMVER_RE.test(candidate)) latest = candidate;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeState({ checkedAt: Date.now(), latest: null, lastError: msg });
    return { status: "unavailable", kind: info.kind, current: info.version, latest: null, detail: msg };
  }

  if (!latest || compareVersions(latest, info.version) <= 0) {
    writeState({ checkedAt: Date.now(), latest: latest ?? info.version, lastError: null });
    return { status: "current", kind: info.kind, current: info.version, latest: latest ?? info.version };
  }

  const cmd = info.kind === "omp" ? "omp" : "pi";
  const args = info.kind === "omp" ? ["plugin", "update", PACKAGE_NAME] : ["update", PACKAGE_NAME];
  const up = await runCommand(cmd, args, info.root);
  writeState({ checkedAt: Date.now(), latest, lastError: up.code === 0 ? null : up.output });
  return up.code === 0
    ? { status: "updated", kind: info.kind, current: info.version, latest }
    : { status: "failed", kind: info.kind, current: info.version, latest, detail: up.output };
}
