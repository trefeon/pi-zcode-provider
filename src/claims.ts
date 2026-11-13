/**
 * ZCode promotional token auto-claim, Aliyun captcha solver, and balance resolution.
 *
 * - Reads /api/v1/zcode-plan/billing/balance (active + pending plans, live model capabilities)
 * - Polls /api/v1/marketing/touch?seq=<n> for claimable promotional batches
 * - Claims via POST /api/v1/zcode-plan/billing/claim
 * - If ZCode demands Aliyun captcha attestation (code 3007), automatically runs
 *   startTracelessVerification via local headless Edge/Chrome CDP using live
 *   sceneId/prefix/region from /api/v1/client/configs and retries the claim once.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord } from "./json.ts";
import type { ZCodeCredentials } from "./keyring.ts";
import {
  FALLBACK_ZCODE_VERSION,
  ZCODE_ORIGIN,
  clientPlatformString,
  type CaptchaConfig,
} from "./version.ts";

const ZCODE_PLAN_BASE = `${ZCODE_ORIGIN}/api/v1/zcode-plan`;
const TOUCH_URL = `${ZCODE_ORIGIN}/api/v1/marketing/touch`;
const CAPTCHA_TIMEOUT_MS = 35_000;

let touchSeq = 0;

function clientLanguage(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
    return /^zh\b/i.test(locale) ? "zh-CN" : "en-US";
  } catch {
    return "en-US";
  }
}

function commonHeaders(creds: ZCodeCredentials, appVersion: string): Record<string, string> {
  return {
    "Accept": "application/json",
    "Authorization": `Bearer ${creds.jwt}`,
    "User-Agent": `ZCode/${appVersion}`,
    "X-ZCode-App-Version": appVersion,
    "X-Platform": clientPlatformString(),
    "X-Client-Language": clientLanguage(),
    ...(creds.deviceMid ? { "X-Device-Mid": creds.deviceMid } : {}),
  };
}

// ---------------------------------------------------------------------------
// Balance & active Start Plan model discovery
// ---------------------------------------------------------------------------

export interface PlanRecord {
  user_plan_id?: string;
  plan_id?: string;
  name?: string;
  status?: string;
  starts_at?: number;
  ends_at?: number;
}

export interface EntitlementBalance {
  bucket_id?: string;
  user_plan_id?: string;
  plan_id: string;
  entitlement_id?: string;
  show_name: string;
  total_units: number;
  remaining_units: number;
  used_units: number;
  expires_at: number;
  capabilities: string[];
}

export interface BalanceResult {
  plans: PlanRecord[];
  balances: EntitlementBalance[];
  serverTime: number;
}

interface ApiEnvelope {
  code: number;
  msg: string;
  data?: unknown;
}


function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function fetchEnvelope(url: string, options: RequestInit): Promise<{ status: number; ok: boolean; env: ApiEnvelope | null; raw: string }> {
  const res = await fetch(url, options);
  const raw = await res.text();
  try {
    const rec = asRecord(JSON.parse(raw));
    if (rec) {
      const code = typeof rec["code"] === "number"
        ? rec["code"]
        : typeof rec["code"] === "string" && /^\d+$/.test(rec["code"])
          ? Number(rec["code"])
          : -1;
      const msg = typeof rec["msg"] === "string" ? rec["msg"] : "";
      return { status: res.status, ok: res.ok, env: { code, msg, data: rec["data"] }, raw };
    }
  } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, env: null, raw };
}

/** Fetch current plans and token balances across all Start/promo entitlements. */
export async function fetchBalance(
  creds: ZCodeCredentials,
  appVersion = FALLBACK_ZCODE_VERSION,
): Promise<BalanceResult> {
  const url = `${ZCODE_PLAN_BASE}/billing/balance?app_version=${encodeURIComponent(appVersion)}`;
  const { status, ok, env, raw } = await fetchEnvelope(url, {
    headers: commonHeaders(creds, appVersion),
    signal: AbortSignal.timeout(10_000),
  });
  if (!ok || !env || (env.code !== 0 && env.code !== 200)) {
    const detail = env?.msg || raw.slice(0, 160) || `HTTP ${status}`;
    throw new Error(`ZCode balance failed: ${detail}`);
  }
  const data = asRecord(env.data) ?? {};
  const plans = Array.isArray(data["plans"]) ? (data["plans"] as PlanRecord[]) : [];
  const balances = Array.isArray(data["balances"]) ? (data["balances"] as EntitlementBalance[]) : [];
  const serverTime = toNum(data["server_time"]);
  return { plans, balances, serverTime };
}

/** Extract live usable model IDs from balance (active, non-expired, non-exhausted buckets). */
export function activeBalanceModels(balance: BalanceResult): string[] {
  const now = balance.serverTime > 0 ? balance.serverTime : Math.trunc(Date.now() / 1000);
  const activePlans = new Set<string>();
  for (const p of balance.plans) {
    const status = String(p.status ?? "").trim().toLowerCase();
    const starts = toNum(p.starts_at);
    const ends = toNum(p.ends_at);
    if (status !== "active") continue;
    if (starts > now) continue;
    if (ends > 0 && ends <= now) continue;
    activePlans.add(`${p.user_plan_id ?? ""}\0${p.plan_id ?? ""}`);
  }

  const seen = new Set<string>();
  const models: string[] = [];
  for (const b of balance.balances) {
    const key = `${b.user_plan_id ?? ""}\0${b.plan_id ?? ""}`;
    if (balance.plans.length > 0 && !activePlans.has(key)) continue;
    const exp = toNum(b.expires_at);
    if (exp > 0 && exp <= now) continue;
    const remaining = b.remaining_units !== undefined ? toNum(b.remaining_units) : toNum(b.total_units) - toNum(b.used_units);
    if (remaining <= 0) continue;

    for (const cap of Array.isArray(b.capabilities) ? b.capabilities : []) {
      const m = String(cap).replace(/^model:/i, "").trim();
      if (!m || seen.has(m.toLowerCase())) continue;
      seen.add(m.toLowerCase());
      models.push(m);
    }
  }
  return models;
}

export function formatBalance(b: EntitlementBalance): string {
  const total = toNum(b.total_units);
  const remaining = b.remaining_units !== undefined ? toNum(b.remaining_units) : Math.max(0, total - toNum(b.used_units));
  const pct = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;
  const expires = toNum(b.expires_at) > 0 ? new Date(toNum(b.expires_at) * 1000).toISOString().slice(0, 10) : "unknown";
  const caps = Array.isArray(b.capabilities) && b.capabilities.length > 0
    ? ` [${b.capabilities.map((c) => c.replace(/^model:/, "")).join(", ")}]`
    : "";
  return `${b.show_name}${caps}: ${millions(remaining)} / ${millions(total)} tokens left (${pct}%) — expires ${expires}`;
}

// ---------------------------------------------------------------------------
// Marketing feed (/api/v1/marketing/touch)
// ---------------------------------------------------------------------------

export interface ClaimablePlan {
  plan_id: string;
  name: string;
}

function extractTouchPlans(data: unknown): ClaimablePlan[] {
  const root = asRecord(data);
  const deliveries = root?.["deliveries"];
  if (!Array.isArray(deliveries)) return [];
  const plans: ClaimablePlan[] = [];
  const seen = new Set<string>();

  for (const delivery of deliveries) {
    const ids: string[] = [];
    const names: string[] = [];
    const walk = (node: unknown, depth: number): void => {
      if (!node || typeof node !== "object" || depth > 12) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      const obj = node as Record<string, unknown>;
      const args = asRecord(obj["args"]);
      if (obj["type"] === "claim_zcode_plan" && args) {
        const pid = args["plan_id"];
        if (typeof pid === "string" && pid.trim()) ids.push(pid.trim());
      }
      const zPlan = asRecord(obj["zcode_plan"]);
      if (zPlan && typeof zPlan["name"] === "string") {
        names.push(zPlan["name"].trim());
      }
      for (const val of Object.values(obj)) walk(val, depth + 1);
    };
    walk(delivery, 0);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      plans.push({ plan_id: id, name: names[0] || id });
    }
  }
  return plans;
}

export async function fetchClaimablePlans(
  creds: ZCodeCredentials,
  appVersion = FALLBACK_ZCODE_VERSION,
): Promise<ClaimablePlan[]> {
  const url = `${TOUCH_URL}?seq=${touchSeq++}`;
  const { ok, env } = await fetchEnvelope(url, {
    headers: commonHeaders(creds, appVersion),
    signal: AbortSignal.timeout(10_000),
  });
  if (!ok || !env || env.code !== 0) return [];
  return extractTouchPlans(env.data);
}

// ---------------------------------------------------------------------------
// Aliyun Captcha headless CDP solver (used only when claim returns 3007)
// ---------------------------------------------------------------------------

function findBrowserExecutable(): string | null {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return null;
}

interface CdpMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

async function solveAliyunCaptchaCdp(scene: CaptchaConfig): Promise<{ param: string; region: string } | { error: string }> {
  if (!scene.enabled || !scene.sceneId) return { error: "captcha disabled or missing sceneId" };
  if (process.env.ZCODE_ATTEST === "off") return { error: "captcha solver disabled (ZCODE_ATTEST=off)" };

  const browser = findBrowserExecutable();
  if (!browser) return { error: "no Chrome/Edge binary found for captcha attestation" };

  let profileDir = "";
  try {
    profileDir = mkdtempSync(join(tmpdir(), "pi-zcode-cap-"));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "https://zcode.z.ai/cn",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const portPromise = Promise.withResolvers<number>();
    let stderrBuf = "";
    const portTimer = setTimeout(() => portPromise.reject(new Error("browser debug port timeout")), 10_000);
    child.stderr?.on("data", (chunk) => {
      stderrBuf += String(chunk);
      const match = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match?.[1]) {
        clearTimeout(portTimer);
        portPromise.resolve(Number(match[1]));
      }
    });
    child.on("error", (err) => {
      clearTimeout(portTimer);
      portPromise.reject(err);
    });

    const port = await portPromise.promise;
    // Brief wait for page target registration
    await delay(400);

    const targetsRaw = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4_000) })).json();
    const pageTarget = Array.isArray(targetsRaw)
      ? targetsRaw.find((t): t is Record<string, unknown> => asRecord(t) !== null && t["type"] === "page" && typeof t["webSocketDebuggerUrl"] === "string")
      : undefined;
    const wsUrl = pageTarget ? String(pageTarget["webSocketDebuggerUrl"]) : "";
    if (!wsUrl) return { error: "no CDP page target" };

    const ws = new WebSocket(wsUrl);
    const openDone = Promise.withResolvers<void>();
    ws.addEventListener("open", () => openDone.resolve());
    ws.addEventListener("error", () => openDone.reject(new Error("CDP WebSocket failed")));
    await openDone.promise;

    let msgId = 1;
    const pending = new Map<number, { resolve: (m: CdpMessage) => void; reject: (e: unknown) => void }>();
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CdpMessage;
        if (typeof msg.id === "number") {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            waiter.resolve(msg);
          }
        }
      } catch { /* ignore */ }
    });
    // Fast-fail in-flight CDP calls when the browser dies instead of hanging
    // until CAPTCHA_TIMEOUT_MS. The outer catch/finally handles cleanup.
    const drainPending = (why: string) => {
      for (const [, w] of pending) w.reject(new Error(why));
      pending.clear();
    };
    ws.addEventListener("close", () => drainPending("CDP WebSocket closed unexpectedly"));
    ws.addEventListener("error", () => drainPending("CDP WebSocket error"));

    const cdpCall = (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => {
      const id = msgId++;
      const waiter = Promise.withResolvers<CdpMessage>();
      pending.set(id, waiter);
      ws.send(JSON.stringify({ id, method, params }));
      return waiter.promise;
    };

    try {
      await cdpCall("Runtime.enable");
      // Wait for document ready on zcode.z.ai/cn
      await delay(1_500);

      const evalJs = `(async () => {
        const SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
        if (typeof window.initAliyunCaptcha !== "function") {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = SDK;
            s.onload = () => res();
            s.onerror = () => rej(new Error("AliyunCaptcha SDK load failed"));
            document.head.appendChild(s);
          });
        }
        window.AliyunCaptchaConfig = { region: ${JSON.stringify(scene.region)}, prefix: ${JSON.stringify(scene.prefix)} };
        const holder = document.createElement("div"); holder.id = "omp-cap-holder";
        const btn = document.createElement("button"); btn.id = "omp-cap-btn"; btn.hidden = true;
        document.body.append(holder, btn);
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: "captcha timeout" }), 18000);
          window.initAliyunCaptcha({
            SceneId: ${JSON.stringify(scene.sceneId)},
            mode: "popup",
            language: "zh-CN",
            showErrorTip: false,
            element: "#omp-cap-holder",
            button: "#omp-cap-btn",
            getInstance: (inst) => { if (typeof inst.startTracelessVerification === "function") inst.startTracelessVerification(); },
            success: (p) => { clearTimeout(timer); resolve({ param: typeof p === "string" ? p : (p && p.captchaVerifyParam) }); },
            fail: (p) => { clearTimeout(timer); resolve({ error: "fail: " + JSON.stringify(p).slice(0, 120) }); },
            onError: (p) => { clearTimeout(timer); resolve({ error: "onError: " + JSON.stringify(p).slice(0, 120) }); },
          });
        });
      })()`;

      const evalPromise = cdpCall("Runtime.evaluate", {
        expression: evalJs,
        awaitPromise: true,
        returnByValue: true,
      });
      const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
      const evalTimer = setTimeout(() => timeoutReject(new Error("CDP captcha timeout")), CAPTCHA_TIMEOUT_MS);
      const reply = await Promise.race([evalPromise, timeoutPromise]).finally(() => clearTimeout(evalTimer));
      const outer = asRecord(reply.result);
      const inner = asRecord(outer?.["result"]);
      const val = asRecord(inner?.["value"]);
      if (val && typeof val["param"] === "string" && val["param"].trim()) {
        return { param: val["param"].trim(), region: scene.region };
      }
      const errMsg = val && typeof val["error"] === "string" ? val["error"] : "empty captcha result";
      return { error: errMsg };
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Claim execution
// ---------------------------------------------------------------------------

export interface ClaimResult {
  plan_id: string;
  name: string;
  success: boolean;
  code: number;
  message: string;
  alreadyClaimed: boolean;
  captchaRequired?: boolean;
}

async function postClaim(
  creds: ZCodeCredentials,
  plan: ClaimablePlan,
  appVersion: string,
  attestation?: { param: string; region: string },
): Promise<ClaimResult> {
  const headers: Record<string, string> = {
    ...commonHeaders(creds, appVersion),
    "Content-Type": "application/json",
  };
  if (attestation) {
    headers["X-Aliyun-Captcha-Verify-Param"] = attestation.param;
    if (attestation.region) headers["X-Aliyun-Captcha-Verify-Region"] = attestation.region;
  }

  const { ok, env, raw, status } = await fetchEnvelope(`${ZCODE_PLAN_BASE}/billing/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ plan_id: plan.plan_id }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!env) {
    return {
      plan_id: plan.plan_id,
      name: plan.name,
      success: false,
      code: -1,
      message: `HTTP ${status}: ${raw.slice(0, 120)}`,
      alreadyClaimed: false,
    };
  }

  const dataMsg = asRecord(env.data)?.["message"];
  const msg = (typeof dataMsg === "string" ? dataMsg : "") || env.msg;
  const code = env.code;
  const captchaRequired = code === 3007 || /captcha/i.test(msg);

  return {
    plan_id: plan.plan_id,
    name: plan.name,
    success: code === 0 && ok,
    code,
    message: msg || (code === 0 ? "Claimed" : `code ${code}`),
    alreadyClaimed: code === 1003,
    captchaRequired,
  };
}

/**
 * Poll ZCode's marketing feed and claim any available promotional token batches.
 * Automatically solves Aliyun traceless captcha if /billing/claim returns 3007.
 */
export async function autoClaimAvailable(
  creds: ZCodeCredentials,
  options: { appVersion?: string; captcha?: CaptchaConfig | null } = {},
): Promise<ClaimResult[]> {
  const appVersion = options.appVersion ?? FALLBACK_ZCODE_VERSION;
  const plans = await fetchClaimablePlans(creds, appVersion);
  if (plans.length === 0) return [];

  const results: ClaimResult[] = [];
  for (const plan of plans) {
    try {
      let res = await postClaim(creds, plan, appVersion);
      if (res.captchaRequired && options.captcha?.enabled) {
        const solved = await solveAliyunCaptchaCdp(options.captcha);
        if ("param" in solved) {
          res = await postClaim(creds, plan, appVersion, solved);
        } else {
          res = { ...res, message: `${res.message} (auto-captcha: ${solved.error})` };
        }
      }
      results.push(res);
    } catch (err) {
      results.push({
        plan_id: plan.plan_id,
        name: plan.name,
        success: false,
        code: -1,
        message: err instanceof Error ? err.message : String(err),
        alreadyClaimed: false,
      });
    }
  }
  return results;
}
