# ZCode Start Plan — Reverse-Engineered Protocol Notes

> Derived from ZCode Desktop 3.18.2 (`app.asar`, `resources/glm/zcode.cjs`, `resources/config/provider/zcode-builtin.json`) and live traffic observation on 2026-11-14.
> Not an official or documented integration. Z.ai can change this at any time.

## Endpoints

| Purpose | Method & URL |
|---|---|
| Inference (Anthropic SSE) | `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` |
| Plan & bucket balance | `GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ver>` |
| Claim promo batch | `POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim` |
| Marketing feed (banners) | `GET https://zcode.z.ai/api/v1/marketing/touch?seq=<n>` |
| Client configs & captcha | `GET https://zcode.z.ai/api/v1/client/configs?app_version=<ver>&platform=<plat>` |
| Electron latest version | `GET https://zcode.z.ai/api/v1/releases/electron/manifest?platform=<plat>&channel=1` |

## Authentication

`Authorization: Bearer <jwt>` from `~/.zcode/v2/credentials.json` → `zcodejwttoken`:

1. If prefixed with `enc:v2:os:`, AES-256-GCM encrypted using the 32-byte key stored in OS keyring:
   - Service: `"ZCode Credential Encryption"`
   - Account: `sha256(resolve("~/.zcode/v2/credentials.json")).hex`
   - Native binding: `@napi-rs/keyring` inside `ZCode/resources/app.asar.unpacked/node_modules/@napi-rs/keyring-<platform>/`
2. Format: `enc:v2:os:<version>:<iv_b64url>.<tag_b64url>.<ciphertext_b64url>`
3. Device ID (`X-Device-Mid` / `metadata.user_id.device_id`): read from `~/.zcode/v2/telemetry-state.json` or `onboarding-record.json`.

## Risk-Control Gate (Anti-405/3012)

Unrecognized requests return HTTP 405 `{"code":3012,"msg":"request has been blocked due to unusual activity."}`. Passing requires:

1. **Exactly 3 `system` text blocks** (a 4th block triggers `3012`):
   - Block 1: `"You are ZCode, an interactive agent"` (`cache_control: { type: "ephemeral" }`)
   - Block 2: `STABLE_SECTION_0 + "\n\n" + STABLE_SECTION_1` (Agent Identity / Harness / Security notice + `# ZCode Desktop Context`, `cache_control: { type: "ephemeral" }`)
   - Block 3: `"\n\n" + [DYNAMIC_BEHAVIOR, ENVIRONMENT, "You are powered by the model named zai-api/<model>.", CONTEXT_MANAGEMENT, ...ownerSystem].join("\n\n")` (`cache_control: { type: "ephemeral" }`)
2. **Context prefix as first `user` message:**
   `{ "role": "user", "content": [{ "type": "text", "text": "<system-reminder>Today's date is YYYY-MM-DD.</system-reminder>" }] }`
3. **`metadata.user_id` JSON string:**
   `"{\"device_id\":\"<uuid>\",\"account_uuid\":\"\",\"session_id\":\"<session-uuid>\"}"`
4. **`cache_control` pinning:**
   - Strip `cache_control` from all tools and all earlier message blocks.
   - Set `cache_control: { type: "ephemeral" }` only on the last block of the last non-system message.
5. **Z.ai tool replay quirks:**
   - Merge consecutive `toolResult` turns into a single `user` message containing all `tool_result` blocks.
   - Include `id: toolCallId` alongside `tool_use_id: toolCallId` on each `tool_result` block.
   - Partition `assistant` content so all non-`tool_use` blocks precede `tool_use` blocks; omit unsigned `thinking` blocks.
6. **ZCode Desktop attribution headers:**
   - `Authorization: Bearer <jwt>`, `anthropic-version: 2023-06-01`, `HTTP-Referer: https://zcode.z.ai`
   - `User-Agent: ZCode/<appVersion> ai-sdk/anthropic/3.0.81`
   - `X-ZCode-App-Version: <appVersion>`, `X-Title: Z Code@cli`, `X-Release-Channel: production`
   - `X-Client-Language: en-US|zh-CN`, `X-Client-Timezone: <IANA>`, `X-ZCode-Agent: glm`
   - `X-Platform: <process.platform>-<process.arch>`, `X-Os-Category: windows|macos|linux`, `X-Os-Version: <os.release()>`
   - `X-Device-Mid: <deviceMid>`, `x-session-id: <session-uuid>`
   - `x-request-id: <uuid4>`, `x-zcode-trace-id: <uuid4>`, `x-zcode-session-type: main`, `x-zcode-query-source: main_turn`
   - Send NO `anthropic-beta` / Claude Code / third-party agent headers.

## Live Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `3012` | 405 | Risk-control block (spoof/version mismatch) or Aliyun edge firewall IP hold |
| `3009` | 429 | Model concurrency limit exceeded (Start Plan allows 1 concurrent turn per account) |
| `3007` | 400 | Aliyun captcha verification required on `/billing/claim` (`X-Aliyun-Captcha-Verify-Param`) |
| `3006` | 400 | Requested model not enabled on the active Start Plan |
| `1005` / `1113` | 200 | Quota exhausted / no active token package (returns HTTP 200 JSON body, not SSE) |
| `1004` | 400 | Account not currently eligible for promo claim (or stale `X-ZCode-App-Version`) |
| `1003` | 200 | Promo plan already claimed |
| `1001` | 401 | Expired or invalid JWT |

## Captcha & Promo Claim Flow

1. `GET /api/v1/client/configs?app_version=<ver>&platform=<plat>` supplies live `data.configs.captcha` (`enabled`, `prefix`, `region`, `sceneId`) and `data.builtinModels`.
2. `GET /api/v1/marketing/touch?seq=<n>` returns `data.deliveries[]` containing `action.type === "claim_zcode_plan"` and `args.plan_id`.
3. `POST /api/v1/zcode-plan/billing/claim` with `{ "plan_id": "<id>" }`. If response is `3007`, load `https://zcode.z.ai/cn` + `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`, run `initAliyunCaptcha({ SceneId, ... })` + `inst.startTracelessVerification()`, and retry with `X-Aliyun-Captcha-Verify-Param` and `X-Aliyun-Captcha-Verify-Region`.
