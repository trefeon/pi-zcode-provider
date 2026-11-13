/**
 * Live ZCode Desktop version, client config, captcha scene, and model catalog sync.
 *
 * Ensures pi-zcode-provider automatically tracks ZCode Desktop updates without manual edits:
 *   1. Reads locally installed ZCode Desktop version (app.asar package.json).
 *   2. Checks ZCode's live Electron release manifest:
 *      GET https://zcode.z.ai/api/v1/releases/electron/manifest?platform=<plat>&channel=1
 *      and picks the highest semver (fallback: FALLBACK_ZCODE_VERSION).
 *   3. Fetches /api/v1/client/configs for live captcha scene (sceneId/prefix/region)
 *      and builtinModels specs + builtin_provider_config_json URL.
 *   4. Caches results in ~/.zcode/pi-zcode-provider-runtime.json (6h TTL) so startup is instant.
 */

import { mkdirSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FALLBACK_ZCODE_VERSION = "3.18.2";
export const ZCODE_ORIGIN = "https://zcode.z.ai";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  region: string;
  sceneId: string;
}

export interface ZCodeModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  efforts: Array<"low" | "high" | "max">;
  supportsImage: boolean;
}

export interface ZCodeRuntimeConfig {
  appVersion: string;
  checkedAt: number;
  captcha: CaptchaConfig | null;
  models: ZCodeModelSpec[];
  startPlanModelIds: string[];
}

const DEFAULT_MODELS: ZCodeModelSpec[] = [
  {
    id: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash (ZCode)",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    efforts: ["low", "high", "max"],
    supportsImage: true,
  },
  {
    id: "GLM-5.3",
    name: "GLM-5.3 (ZCode)",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    efforts: ["low", "high", "max"],
    supportsImage: false,
  },
  {
    id: "GLM-5.2",
    name: "GLM-5.2 (ZCode)",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    efforts: ["high", "max"],
    supportsImage: false,
  },
  {
    id: "GLM-5-Turbo",
    name: "GLM-5-Turbo (ZCode)",
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    efforts: [],
    supportsImage: false,
  },
];

const DEFAULT_START_MODEL_IDS = ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"];

export function defaultCachePath(): string {
  return join(homedir(), ".zcode", "pi-zcode-provider-runtime.json");
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function maxSemver(candidates: string[]): string {
  let best = FALLBACK_ZCODE_VERSION;
  for (const c of candidates) {
    const m = c.trim().match(SEMVER_RE);
    if (!m) continue;
    if (compareSemver(m[0], best) > 0) best = m[0];
  }
  return best;
}

/** Read locally installed ZCode Desktop version from its app.asar header/package.json without unpacking it. */
export function readLocalZCodeVersion(): string | null {
  const username = process.env.USERNAME ?? process.env.USER ?? "";
  const candidates = [
    join(homedir(), "AppData", "Local", "Programs", "ZCode", "resources", "app.asar"),
    ...(username ? [`C:\\Users\\${username}\\AppData\\Local\\Programs\\ZCode\\resources\\app.asar`] : []),
    "/Applications/ZCode.app/Contents/Resources/app.asar",
    "/opt/ZCode/resources/app.asar",
  ];
  for (const asarPath of candidates) {
    let fd: number | null = null;
    try {
      fd = openSync(asarPath, "r");
      const hdr = Buffer.alloc(16);
      if (readSync(fd, hdr, 0, 16, 0) < 16) continue;
      const headerSize = hdr.readUInt32LE(4);
      const strSize = hdr.readUInt32LE(12);
      if (strSize <= 0 || strSize > 8_000_000) continue;
      const jsonBuf = Buffer.alloc(strSize);
      readSync(fd, jsonBuf, 0, strSize, 16);
      const parsed: unknown = JSON.parse(jsonBuf.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || !("files" in parsed)) continue;
      const files = parsed.files as Record<string, unknown>;
      const pkgEntry = files["package.json"];
      if (!pkgEntry || typeof pkgEntry !== "object" || !("offset" in pkgEntry) || !("size" in pkgEntry)) continue;
      const offset = Number(pkgEntry.offset);
      const size = Number(pkgEntry.size);
      if (!Number.isFinite(offset) || !Number.isFinite(size) || size <= 0 || size > 65536) continue;
      const pkgBuf = Buffer.alloc(size);
      readSync(fd, pkgBuf, 0, size, 8 + headerSize + offset);
      const pkg: unknown = JSON.parse(pkgBuf.toString("utf8"));
      if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
        const m = pkg.version.trim().match(SEMVER_RE);
        if (m) return m[0];
      }
    } catch {
      // try next path
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return null;
}

function electronManifestPlatform(): string {
  const p = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const a = process.arch === "arm64" ? "aarch64" : process.arch === "ia32" ? "x86" : "x86_64";
  return `${p}-${a}`;
}

export function clientPlatformString(): string {
  return `${process.platform}-${process.arch}`;
}

function readCachedConfig(cachePath = defaultCachePath()): ZCodeRuntimeConfig | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!raw || typeof raw !== "object" || !("appVersion" in raw) || typeof raw.appVersion !== "string") return null;
    const rec = raw as Record<string, unknown>;
    return {
      appVersion: rec["appVersion"] as string,
      checkedAt: typeof rec["checkedAt"] === "number" ? rec["checkedAt"] : 0,
      captcha: (rec["captcha"] as CaptchaConfig | null) ?? null,
      models: Array.isArray(rec["models"]) && rec["models"].length > 0 ? (rec["models"] as ZCodeModelSpec[]) : DEFAULT_MODELS,
      startPlanModelIds: Array.isArray(rec["startPlanModelIds"]) ? (rec["startPlanModelIds"] as string[]) : DEFAULT_START_MODEL_IDS,
    };
  } catch {
    return null;
  }
}

function writeCachedConfig(cfg: ZCodeRuntimeConfig, cachePath = defaultCachePath()): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch {
    // non-fatal cache write failure
  }
}

/** Memoized local-ASAR version read: the value cannot change mid-process, and
 * currentRuntimeConfig runs per stream request — re-reading the asar header
 * (openSync/readSync across up to 4 candidate paths) each time blocked the event loop. */
let cachedLocalVersion: string | null | undefined; // undefined = not yet read

/** Fast synchronous snapshot (no network): env override > disk cache > local ZCode ASAR > fallback. */
export function currentRuntimeConfig(cachePath = defaultCachePath()): ZCodeRuntimeConfig {
  const envVer = process.env.ZCODE_APP_VERSION?.trim();
  const cached = readCachedConfig(cachePath);
  if (cachedLocalVersion === undefined) cachedLocalVersion = readLocalZCodeVersion();
  const localVer = cachedLocalVersion;
  const appVersion = envVer || maxSemver([
    ...(cached ? [cached.appVersion] : []),
    ...(localVer ? [localVer] : []),
    FALLBACK_ZCODE_VERSION,
  ]);
  return {
    appVersion,
    checkedAt: cached?.checkedAt ?? 0,
    captcha: cached?.captcha ?? null,
    models: cached?.models ?? DEFAULT_MODELS,
    startPlanModelIds: cached?.startPlanModelIds ?? DEFAULT_START_MODEL_IDS,
  };
}

function parseBuiltinModels(rawList: unknown): ZCodeModelSpec[] {
  if (!Array.isArray(rawList)) return [];
  const specs: ZCodeModelSpec[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["modelId"] === "string" ? rec["modelId"].trim() : "";
    if (!id) continue;
    const name = typeof rec["name"] === "string" && rec["name"].trim() ? rec["name"].trim() : id;
    const contextWindow = typeof rec["contextWindow"] === "number" && rec["contextWindow"] > 0 ? rec["contextWindow"] : 200_000;
    const maxTokens = typeof rec["maxCompletionTokens"] === "number" && rec["maxCompletionTokens"] > 0 ? rec["maxCompletionTokens"] : 64_000;
    const caps = rec["capabilities"] && typeof rec["capabilities"] === "object" ? (rec["capabilities"] as Record<string, unknown>) : {};
    const supportsImage = caps["vision"] === true;
    const reasoningObj = rec["reasoning"] && typeof rec["reasoning"] === "object" ? (rec["reasoning"] as Record<string, unknown>) : {};
    const levels = reasoningObj["levels"] && typeof reasoningObj["levels"] === "object"
      ? Object.keys(reasoningObj["levels"] as Record<string, unknown>).filter(
          (k): k is "low" | "high" | "max" => k === "low" || k === "high" || k === "max",
        )
      : [];
    specs.push({
      id,
      name: `${name} (ZCode)`,
      contextWindow,
      maxTokens,
      reasoning: levels.length > 0,
      efforts: levels,
      supportsImage,
    });
  }
  return specs;
}

function extractStartPlanIdsFromBuiltinJson(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const cfg = root["config"] && typeof root["config"] === "object" ? (root["config"] as Record<string, unknown>) : null;
  const mRules = cfg?.["modelConfigRules"] && typeof cfg["modelConfigRules"] === "object"
    ? (cfg["modelConfigRules"] as Record<string, unknown>)
    : null;
  const bpm = Array.isArray(mRules?.["builtinProviderModelRules"]) ? mRules["builtinProviderModelRules"] : [];
  const ids: string[] = [];
  for (const rule of bpm) {
    if (!rule || typeof rule !== "object") continue;
    const r = rule as Record<string, unknown>;
    if (r["providerId"] !== "account:zai-start-plan") continue;
    const ruleCfg = r["config"] && typeof r["config"] === "object" ? (r["config"] as Record<string, unknown>) : null;
    if (ruleCfg?.["enabled"] === false) continue;
    if (typeof r["modelId"] === "string" && r["modelId"].trim()) ids.push(r["modelId"].trim());
  }
  return ids;
}

let inflightSync: Promise<ZCodeRuntimeConfig> | null = null;

/** Refresh version, captcha scene, and live ZCode model metadata when cache TTL has elapsed (or force=true). */
export async function syncRuntimeConfig(options: {
  jwt?: string;
  deviceMid?: string;
  force?: boolean;
  cachePath?: string;
} = {}): Promise<ZCodeRuntimeConfig> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const base = currentRuntimeConfig(cachePath);
  if (!options.force && Date.now() - base.checkedAt < CACHE_TTL_MS && base.models.length > 0) {
    return base;
  }
  if (inflightSync && !options.force) return inflightSync;

  const task = (async (): Promise<ZCodeRuntimeConfig> => {
    const versionCandidates = [base.appVersion];
    const localVer = readLocalZCodeVersion();
    if (localVer) versionCandidates.push(localVer);

    // 1. Live ZCode Electron release manifest (unauthenticated YAML)
    try {
      const mUrl = new URL("/api/v1/releases/electron/manifest", ZCODE_ORIGIN);
      mUrl.searchParams.set("platform", electronManifestPlatform());
      mUrl.searchParams.set("channel", "1");
      if (options.deviceMid) mUrl.searchParams.set("device_mid", options.deviceMid);
      const res = await fetch(mUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const text = await res.text();
        const match = text.match(/^version:\s*["']?(\d+\.\d+\.\d+)["']?/m);
        if (match?.[1]) versionCandidates.push(match[1]);
      }
    } catch {
      // network offline — keep local/cached version
    }

    const appVersion = process.env.ZCODE_APP_VERSION?.trim() || maxSemver(versionCandidates);
    let captcha: CaptchaConfig | null = base.captcha;
    let models: ZCodeModelSpec[] = base.models;
    let startPlanModelIds: string[] = base.startPlanModelIds;

    // 2. Live /api/v1/client/configs for captcha scene, builtinModels, and CDN builtin config URL
    try {
      const cUrl = new URL("/api/v1/client/configs", ZCODE_ORIGIN);
      cUrl.searchParams.set("app_version", appVersion);
      cUrl.searchParams.set("platform", clientPlatformString());
      const headers: Record<string, string> = {
        "User-Agent": `ZCode/${appVersion}`,
        "X-ZCode-App-Version": appVersion,
        "X-Platform": clientPlatformString(),
      };
      if (options.jwt) headers["Authorization"] = `Bearer ${options.jwt}`;
      if (options.deviceMid) headers["X-Device-Mid"] = options.deviceMid;

      const res = await fetch(cUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const env: unknown = await res.json();
        if (env && typeof env === "object" && "data" in env && env.data && typeof env.data === "object") {
          const data = env.data as Record<string, unknown>;
          const configs = data["configs"] && typeof data["configs"] === "object"
            ? (data["configs"] as Record<string, unknown>)
            : null;
          const cap = configs?.["captcha"] && typeof configs["captcha"] === "object"
            ? (configs["captcha"] as Record<string, unknown>)
            : null;
          if (cap && typeof cap["sceneId"] === "string" && cap["sceneId"].trim()) {
            captcha = {
              enabled: cap["enabled"] === true,
              sceneId: cap["sceneId"].trim(),
              prefix: typeof cap["prefix"] === "string" && cap["prefix"].trim() ? cap["prefix"].trim() : "no8xfe",
              region: typeof cap["region"] === "string" && cap["region"].trim() ? cap["region"].trim() : "sgp",
            };
          }

          const parsedModels = parseBuiltinModels(data["builtinModels"]);
          if (parsedModels.length > 0) {
            // Merge so default known entries (like GLM-5.2 / GLM-5-Turbo) aren't lost
            const byId = new Map<string, ZCodeModelSpec>();
            for (const m of DEFAULT_MODELS) byId.set(m.id.toLowerCase(), m);
            for (const m of parsedModels) byId.set(m.id.toLowerCase(), m);
            models = [...byId.values()];
          }

          // 3. Optional CDN builtin_provider_config_json for start-plan rules
          const cdnUrl = typeof configs?.["builtin_provider_config_json"] === "string"
            ? configs["builtin_provider_config_json"].trim()
            : "";
          if (cdnUrl.startsWith("https://")) {
            try {
              const rCdn = await fetch(cdnUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
              if (rCdn.ok) {
                const cdnJson: unknown = await rCdn.json();
                const ids = extractStartPlanIdsFromBuiltinJson(cdnJson);
                if (ids.length > 0) startPlanModelIds = ids;
              }
            } catch {
              // keep cached startPlanModelIds
            }
          }
        }
      }
    } catch {
      // keep cached/default values
    }

    const updated: ZCodeRuntimeConfig = {
      appVersion,
      checkedAt: Date.now(),
      captcha,
      models,
      startPlanModelIds,
    };
    writeCachedConfig(updated, cachePath);
    return updated;
  })();

  inflightSync = task.finally(() => {
    if (inflightSync === task) inflightSync = null;
  });
  return inflightSync;
}

/** Find model metadata for a model ID (case-insensitive), synthesizing reasonable defaults if unknown. */
export function resolveModelSpec(id: string, models: readonly ZCodeModelSpec[]): ZCodeModelSpec {
  const lower = id.toLowerCase();
  const found = models.find((m) => m.id.toLowerCase() === lower);
  if (found) return found;
  const is1m = lower.includes("5.3") || lower.includes("5.2");
  return {
    id,
    name: `${id} (ZCode)`,
    contextWindow: is1m ? 1_000_000 : 200_000,
    maxTokens: is1m ? 128_000 : 64_000,
    reasoning: is1m,
    efforts: is1m ? ["low", "high", "max"] : [],
    supportsImage: lower.includes("flash") || lower.includes("5v"),
  };
}
