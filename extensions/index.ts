/**
 * pi-zcode-provider — Pi/OMP extension entry point.
 *
 * Registers provider "zcode" with:
 *   - Direct ZCode Start Plan API (no app-server required)
 *   - Full ZCode Desktop request spoofing (live version, 3-block prompt, attribution headers)
 *   - Credentials from ~/.zcode/v2/credentials.json (enc:v2:os: keyring) or ZCODE_JWT_TOKEN
 *   - Live model catalog sync from billing/balance + client/configs + zcode-builtin
 *   - Periodic background auto-claim of promotional tokens (+ headless captcha solver on 3007)
 *   - Self-update support (git/npm/omp) and live ZCode version sync
 */

import type { AssistantMessageEventStream, Context, Effort, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { activeBalanceModels, autoClaimAvailable, fetchBalance, formatBalance } from "../src/claims.ts";
import { ZCODE_START_URL } from "../src/dress.ts";
import { isJwtExpired, loadCredentials, type ZCodeCredentials } from "../src/keyring.ts";
import { streamZCodeTurn } from "../src/stream.ts";
import { maybeAutoUpdate } from "../src/update.ts";
import {
  currentRuntimeConfig,
  resolveModelSpec,
  syncRuntimeConfig,
  type ZCodeModelSpec,
  type ZCodeRuntimeConfig,
} from "../src/version.ts";

const PROVIDER_ID = "zcode";
const ZCODE_CUSTOM_API = "zcode-start-plan-api";
const CLAIM_INTERVAL_MS = 30 * 60 * 1000;
const SUBCOMMANDS = ["balance", "claim", "models", "status", "refresh", "update"];

interface ModelDeclaration {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinking?: {
    mode: "anthropic-adaptive";
    efforts: Effort[];
  };
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function toProviderModel(spec: ZCodeModelSpec): ModelDeclaration {
  return {
    id: spec.id,
    name: spec.name,
    api: ZCODE_CUSTOM_API,
    reasoning: spec.reasoning,
    ...(spec.reasoning && spec.efforts.length > 0
      ? { thinking: { mode: "anthropic-adaptive" as const, efforts: spec.efforts.map((e) => e as Effort) } }
      : {}),
    input: spec.supportsImage ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  };
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI) {
    try {
      ctx.ui.notify(message, level);
      return;
    } catch { /* fallback below */ }
  }
  if (level === "error") console.error(message);
  else console.log(message);
}

export default function register(pi: ExtensionAPI): void {
  const sessionId = crypto.randomUUID();
  let runtime: ZCodeRuntimeConfig = currentRuntimeConfig();
  let cachedCreds: ZCodeCredentials | null = null;
  let lastClaimAt = 0;
  let claimInFlight: Promise<void> | null = null;

  const getCreds = (): ZCodeCredentials => {
    // Re-read on demand if missing or expired (so re-signing in ZCode Desktop works with no reload)
    if (!cachedCreds || isJwtExpired(cachedCreds.jwt)) {
      cachedCreds = loadCredentials();
    }
    return cachedCreds;
  };

  try {
    cachedCreds = loadCredentials();
  } catch {
    // Allow extension to load cleanly so /zcode status explains what is missing
  }

  const refreshAll = async (): Promise<ModelDeclaration[]> => {
    let creds: ZCodeCredentials | null = null;
    try {
      creds = getCreds();
    } catch {
      creds = null;
    }

    runtime = await syncRuntimeConfig({
      jwt: creds?.jwt,
      deviceMid: creds?.deviceMid,
    });

    if (creds && !isJwtExpired(creds.jwt)) {
      try {
        const balance = await fetchBalance(creds, runtime.appVersion);
        const liveIds = activeBalanceModels(balance);
        if (liveIds.length > 0) {
          return liveIds.map((id) => toProviderModel(resolveModelSpec(id, runtime.models)));
        }
      } catch {
        // Fallback to configured Start Plan models
      }
    }

    const fallbackIds = runtime.startPlanModelIds.length > 0
      ? runtime.startPlanModelIds
      : ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"];
    return fallbackIds.map((id) => toProviderModel(resolveModelSpec(id, runtime.models)));
  };

  const runBackgroundClaim = (ctx?: ExtensionContext, force = false): void => {
    if (!force && Date.now() - lastClaimAt < CLAIM_INTERVAL_MS) return;
    if (claimInFlight) return;

    claimInFlight = (async () => {
      try {
        const creds = getCreds();
        if (isJwtExpired(creds.jwt)) return;
        runtime = await syncRuntimeConfig({ jwt: creds.jwt, deviceMid: creds.deviceMid });
        lastClaimAt = Date.now();
        const results = await autoClaimAvailable(creds, {
          appVersion: runtime.appVersion,
          captcha: runtime.captcha,
        });
        for (const r of results) {
          if (r.success) {
            notify(ctx, `[pi-zcode] Claimed ${r.name}: ${r.message}`, "info");
          }
        }
      } catch {
        // Silent background fail — never disrupt startup
      } finally {
        claimInFlight = null;
      }
    })();
  };

  const initialModels = (
    runtime.startPlanModelIds.length > 0 ? runtime.startPlanModelIds : ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]
  ).map((id) => toProviderModel(resolveModelSpec(id, runtime.models)));

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: ZCODE_START_URL,
    api: ZCODE_CUSTOM_API,
    apiKey: "zcode-start-plan",
    models: initialModels,
    fetchDynamicModels: async () => refreshAll(),
    streamSimple: (model: Model, context: Context, options?: SimpleStreamOptions) =>
      streamZCodeTurn(model, context, options ?? {}, {
        credentials: getCreds,
        appVersion: () => runtime.appVersion,
        sessionId,
      }) as unknown as AssistantMessageEventStream,
  });

  const handleBalance = async (ctx: ExtensionCommandContext): Promise<void> => {
    try {
      const creds = getCreds();
      runtime = await syncRuntimeConfig({ jwt: creds.jwt, deviceMid: creds.deviceMid });
      const { plans, balances } = await fetchBalance(creds, runtime.appVersion);
      if (balances.length === 0 && plans.length === 0) {
        notify(ctx, "No active ZCode plans or token buckets found.", "info");
        return;
      }
      const lines: string[] = [];
      for (const p of plans) {
        lines.push(`Plan: ${p.name ?? p.plan_id} (${p.status ?? "unknown"})`);
      }
      for (const b of balances) {
        lines.push(`  • ${formatBalance(b)}`);
      }
      notify(ctx, lines.join("\n"), "info");
    } catch (err) {
      notify(ctx, `ZCode balance error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const handleClaim = async (ctx: ExtensionCommandContext): Promise<void> => {
    try {
      const creds = getCreds();
      runtime = await syncRuntimeConfig({ jwt: creds.jwt, deviceMid: creds.deviceMid, force: true });
      const results = await autoClaimAvailable(creds, {
        appVersion: runtime.appVersion,
        captcha: runtime.captcha,
      });
      lastClaimAt = Date.now();
      if (results.length === 0) {
        notify(ctx, "No claimable ZCode promotional tokens right now.", "info");
        return;
      }
      const lines = results.map((r) => {
        const icon = r.success ? "✓" : r.alreadyClaimed ? "○" : "✗";
        return `${icon} ${r.name} (${r.plan_id}): ${r.message}`;
      });
      notify(ctx, lines.join("\n"), results.some((r) => r.success) ? "info" : "warning");
    } catch (err) {
      notify(ctx, `ZCode claim error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  pi.registerCommand("zcode", {
    description: "ZCode Start Plan status, balance, promo token claim, and sync",
    getArgumentCompletions: (prefix: string) =>
      SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim().toLowerCase())).map((s) => ({
        value: s,
        label: s,
      })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "balance";
      if (sub === "balance") {
        await handleBalance(ctx);
      } else if (sub === "claim") {
        await handleClaim(ctx);
      } else if (sub === "models" || sub === "refresh") {
        const models = await refreshAll();
        notify(
          ctx,
          `ZCode v${runtime.appVersion} synced — active models: ${models.map((m) => m.id).join(", ")}`,
          "info",
        );
      } else if (sub === "update") {
        const up = await maybeAutoUpdate({ force: true });
        notify(
          ctx,
          `pi-zcode-provider (${up.kind}) v${up.current}: ${up.status}${up.latest ? ` (latest ${up.latest})` : ""}${up.detail ? ` — ${up.detail}` : ""}`,
          up.status === "failed" ? "error" : "info",
        );
      } else if (sub === "status") {
        try {
          const creds = getCreds();
          const expired = isJwtExpired(creds.jwt);
          notify(
            ctx,
            `ZCode appVersion=${runtime.appVersion} | JWT=${expired ? "EXPIRED" : "valid"} | deviceMid=${creds.deviceMid || "(none)"}`,
            expired ? "warning" : "info",
          );
        } catch (err) {
          notify(ctx, err instanceof Error ? err.message : String(err), "error");
        }
      } else {
        notify(ctx, `Usage: /zcode <${SUBCOMMANDS.join(" | ")}>`, "info");
      }
    },
  });

  pi.registerCommand("zcode-balance", {
    description: "Show ZCode Start Plan token balance",
    handler: async (_args: string, ctx: ExtensionCommandContext) => handleBalance(ctx),
  });

  pi.registerCommand("zcode-claim", {
    description: "Check for and claim available ZCode promotional tokens",
    handler: async (_args: string, ctx: ExtensionCommandContext) => handleClaim(ctx),
  });

  // Periodic background sync + auto-claim on interactive sessions
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      runBackgroundClaim(ctx, false);
      void maybeAutoUpdate().then((res) => {
        if (res.status === "updated") {
          notify(ctx, `[pi-zcode] Updated ${res.current} → ${res.latest}. Run /reload to activate.`, "info");
        }
      }).catch(() => {});
    });
  }
}
