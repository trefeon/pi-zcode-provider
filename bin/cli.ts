#!/usr/bin/env bun
/**
 * pi-zcode-provider CLI — balance check, manual claim, version/model sync, and stream smoke-test.
 * Usage:
 *   bun run bin/cli.ts balance             — show active plans & token balance
 *   bun run bin/cli.ts claim               — check & claim promotional token batches
 *   bun run bin/cli.ts models              — sync live version & list available Start Plan models
 *   bun run bin/cli.ts status              — show runtime version, JWT validity, device id
 *   bun run bin/cli.ts update              — check for and apply plugin updates now
 *   bun run bin/cli.ts test [model-id]     — smoke-test streaming (default: GLM-5.3-Flash)
 */

import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { activeBalanceModels, autoClaimAvailable, fetchBalance, formatBalance } from "../src/claims.ts";
import { ZCODE_START_URL } from "../src/dress.ts";
import { isJwtExpired, loadCredentials } from "../src/keyring.ts";
import { streamZCodeTurn } from "../src/stream.ts";
import { maybeAutoUpdate } from "../src/update.ts";
import { resolveModelSpec, syncRuntimeConfig } from "../src/version.ts";

const cmd = process.argv[2] ?? "balance";

// Self-update needs no ZCode credentials — dispatch before the credential gate so
// a credential-less machine can still update the plugin.
if (cmd === "update") {
  const up = await maybeAutoUpdate({ force: true });
  console.log(`pi-zcode-provider (${up.kind}) v${up.current}: ${up.status}${up.latest ? ` (latest ${up.latest})` : ""}${up.detail ? ` — ${up.detail}` : ""}`);
  process.exit(up.status === "failed" ? 1 : 0);
}

let creds: ReturnType<typeof loadCredentials>;
try {
  creds = loadCredentials();
} catch (err) {
  console.error(`No ZCode credentials found: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Set ZCODE_JWT_TOKEN or sign in with ZCode Desktop first.");
  process.exit(1);
}
const runtime = await syncRuntimeConfig({ jwt: creds.jwt, deviceMid: creds.deviceMid });

if (cmd === "balance") {
  const { plans, balances } = await fetchBalance(creds, runtime.appVersion);
  console.log(`ZCode appVersion=${runtime.appVersion}`);
  for (const p of plans) {
    console.log(`Plan: ${p.name ?? p.plan_id} (${p.status ?? "unknown"})`);
  }
  if (balances.length === 0) {
    console.log("No active token buckets.");
  } else {
    for (const b of balances) console.log(" ", formatBalance(b));
  }
} else if (cmd === "claim") {
  console.log(`Checking marketing feed (appVersion=${runtime.appVersion})...`);
  const results = await autoClaimAvailable(creds, {
    appVersion: runtime.appVersion,
    captcha: runtime.captcha,
  });
  if (results.length === 0) {
    console.log("Nothing claimable right now.");
  } else {
    for (const r of results) {
      const icon = r.success ? "✓" : r.alreadyClaimed ? "○" : "✗";
      console.log(`${icon} ${r.name} (${r.plan_id}): ${r.message}`);
    }
  }
} else if (cmd === "models" || cmd === "refresh") {
  const fresh = await syncRuntimeConfig({ jwt: creds.jwt, deviceMid: creds.deviceMid, force: true });
  const bal = await fetchBalance(creds, fresh.appVersion);
  const activeIds = activeBalanceModels(bal);
  console.log(`ZCode v${fresh.appVersion} | Captcha: ${fresh.captcha?.enabled ? fresh.captcha.sceneId : "off"}`);
  console.log("Active balance models:", activeIds.join(", ") || "(none)");
  console.log("Catalog specs:");
  for (const m of fresh.models) {
    console.log(`  - ${m.id}: ctx=${m.contextWindow} maxOut=${m.maxTokens} img=${m.supportsImage} reasoning=${m.reasoning}`);
  }
} else if (cmd === "status") {
  const expired = isJwtExpired(creds.jwt);
  console.log(`ZCode appVersion=${runtime.appVersion} | JWT=${expired ? "EXPIRED" : "valid"} | deviceMid=${creds.deviceMid || "(none)"}`);
  if (expired) process.exit(1);
} else if (cmd === "test") {
  const targetId = process.argv[3] ?? "GLM-5.3-Flash";
  const spec = resolveModelSpec(targetId, runtime.models);
  console.log(`Smoke-testing ${spec.id} (v${runtime.appVersion})...`);
  const fakeModel = {
    id: spec.id,
    name: spec.name,
    api: "zcode-start-plan-api",
    provider: "zcode",
    baseUrl: ZCODE_START_URL,
    reasoning: spec.reasoning,
    input: spec.supportsImage ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  } as unknown as Model;

  const stream = streamZCodeTurn(
    fakeModel,
    {
      systemPrompt: ["Be terse."],
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }], timestamp: Date.now() }],
    },
    { maxTokens: 256, reasoning: "low" as Effort },
    {
      credentials: () => creds,
      appVersion: () => runtime.appVersion,
      sessionId: crypto.randomUUID(),
    },
  );

  for await (const ev of stream) {
    if (ev.type === "text_delta") process.stdout.write(ev.delta);
    else if (ev.type === "thinking_delta") process.stdout.write(`[think:${ev.delta}]`);
  }
  const finalMsg = await stream.result();
  console.log(`\nDone. stopReason=${finalMsg.stopReason} input=${finalMsg.usage.input} output=${finalMsg.usage.output}`);
  if (finalMsg.stopReason === "error") {
    console.error("Error:", finalMsg.errorMessage);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${cmd}. Use: balance | claim | models | refresh | status | update | test [model-id]`);
  process.exit(1);
}
