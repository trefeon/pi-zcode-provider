# pi-zcode-provider

OMP/Pi extension: use your **ZCode / Z.ai Start Plan** directly in [Oh My Pi](https://omp.sh) and [pi](https://github.com/earendil-works/pi) — no running ZCode desktop app or `zcodex` server required, with live version/catalog sync and automatic promotional token claiming.

## What this does differently

| Feature | this extension | `D4NZ-jpg/pi-zcode-provider` | `rizquuula/omp-zcode-provider` | `cefege/omp-zai-coding-plan` |
|---|---|---|---|---|
| Direct Start Plan API | ✅ | ❌ (Coding Plan key only) | ❌ (bridges `zcodex` daemon) | ❌ (Coding Plan key only) |
| `enc:v2:os:` OS keyring decrypt | ✅ | ❌ | N/A | ❌ |
| Auto-sync live ZCode version & models | ✅ | ❌ | N/A | ❌ |
| Auto-claim promo tokens (+ captcha CDP) | ✅ | ❌ | ❌ | ❌ |
| Full ZCode Desktop request spoofing | ✅ | ❌ | N/A | ❌ |
| Works on both OMP + pi | ✅ | ❌ (pi-only) | ❌ (omp-only) | ❌ (omp-only) |

## Install

```sh
# OMP — from GitHub:
omp plugin install github:trefeon/pi-zcode-provider

# Pi — from GitHub:
pi install git:https://github.com/trefeon/pi-zcode-provider
```

Reload an existing OMP session with `/reload`, then run `/model zcode/GLM-5.3-Flash`.

## Credentials

Resolved in this order:

1. `ZCODE_JWT_TOKEN` env var (+ optional `ZCODE_DEVICE_MID`)
2. `~/.zcode/v2/credentials.json` → `zcodejwttoken`, decrypted via Windows Credential Manager / macOS Keychain using ZCode Desktop's bundled `@napi-rs/keyring` native module

If ZCode Desktop is signed in on the machine, no manual token setup is needed.

## Auto-Sync & Auto-Update

- **ZCode version & model sync (`src/version.ts`):** Reads your local ZCode Desktop `app.asar` version, checks `https://zcode.z.ai/api/v1/releases/electron/manifest` for newer releases, and pulls `/api/v1/client/configs` (live model specs, `builtin_provider_config_json`, and Aliyun captcha scene). Cached 6 hours in `~/.zcode/pi-zcode-provider-runtime.json`. Override via `ZCODE_APP_VERSION`.
- **Live balance filtering (`src/claims.ts`):** `fetchDynamicModels` reads `/api/v1/zcode-plan/billing/balance` and registers the models your active, non-expired, non-exhausted plan buckets actually allow.
- **Promo token auto-claim (`src/claims.ts`):** Checks `/api/v1/marketing/touch` on `session_start` (throttled to every 30 minutes) and claims any available `claim_zcode_plan` batches. If `/billing/claim` requests Aliyun captcha attestation (code `3007`), it spawns headless Edge/Chrome via CDP to solve `startTracelessVerification` and retries once (disable via `ZCODE_ATTEST=off`).
- **Plugin self-update (`src/update.ts`):** Checks npm / git remote on interactive session starts (disable via `OMP_ZCODE_AUTO_UPDATE=0`).

## Commands

| Command | Description |
|---|---|
| `/zcode balance` or `/zcode-balance` | Show active ZCode plans and token balances |
| `/zcode claim` or `/zcode-claim` | Poll marketing feed and claim available promotional tokens |
| `/zcode models` / `/zcode refresh` | Force-sync ZCode version, configs, and balance models |
| `/zcode status` | Show synced `appVersion`, JWT expiry status, and `deviceMid` |
| `/zcode update` | Check/apply plugin self-update |

## CLI & Tests

```sh
bun run bin/cli.ts balance             # show plans & remaining token quota
bun run bin/cli.ts claim               # check & claim promotional batches
bun run bin/cli.ts models              # force-sync version, captcha config, models
bun run bin/cli.ts test GLM-5.3-Flash  # smoke-test streaming SSE turn
bun test                               # run unit test suite
```

## Protocol & Security

> The ZCode Start Plan integration was derived from ZCode Desktop 3.18.2 and live wire traffic. Z.ai may change or restrict it at any time.

- No credentials are stored in this repository.
- See [`PROTOCOL.md`](./PROTOCOL.md) for the full Start Plan wire specification (3-block system prompt, `<system-reminder>` context prefix, `metadata.user_id`, tail-only `cache_control`, Z.ai `tool_result.id` quirk, error codes, manifest/captcha endpoints).

## License

MIT
