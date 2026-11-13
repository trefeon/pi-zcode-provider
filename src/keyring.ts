/**
 * ZCode credential reader — supports enc:v2:os: (AES-256-GCM via OS keyring) and plaintext.
 *
 * Reads from: %USERPROFILE%\.zcode\v2\credentials.json
 * Key via:    Windows Credential Manager / macOS Keychain (@napi-rs/keyring)
 *             Service: "ZCode Credential Encryption"
 *             Account: sha256(credentialsFilePath).hex
 */

import { createHash, createDecipheriv } from "node:crypto";
import { accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);

const CRED_SERVICE = "ZCode Credential Encryption";
const ZCODE_DATA_DIR = join(homedir(), ".zcode", "v2");
const CRED_FILE = resolve(join(ZCODE_DATA_DIR, "credentials.json"));

/** Canonical sha256 of the credentials file path, used as the keyring account. */
const credAccount = createHash("sha256").update(CRED_FILE).digest("hex");

let cachedOsKey: Buffer | null = null;

function findKeyringNative(): string | null {
  const username = process.env.USERNAME ?? process.env.USER ?? "";
  const candidates: string[] = [
    join(homedir(), "AppData", "Local", "Programs", "ZCode", "resources", "app.asar.unpacked", "node_modules", "@napi-rs", "keyring-win32-x64-msvc", "keyring.win32-x64-msvc.node"),
    ...(username ? [`C:\\Users\\${username}\\AppData\\Local\\Programs\\ZCode\\resources\\app.asar.unpacked\\node_modules\\@napi-rs\\keyring-win32-x64-msvc\\keyring.win32-x64-msvc.node`] : []),
    "/Applications/ZCode.app/Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
    "/Applications/ZCode.app/Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-x64/keyring.darwin-x64.node",
    join(homedir(), "Applications", "ZCode.app", "Contents", "Resources", "app.asar.unpacked", "node_modules", "@napi-rs", "keyring-darwin-arm64", "keyring.darwin-arm64.node"),
    join(homedir(), "Applications", "ZCode.app", "Contents", "Resources", "app.asar.unpacked", "node_modules", "@napi-rs", "keyring-darwin-x64", "keyring.darwin-x64.node"),
  ];
  for (const p of candidates) {
    try {
      accessSync(p);
      return p;
    } catch {
      // try next path
    }
  }
  return null;
}

interface KeyringEntry {
  getPassword(): string | null;
}

interface KeyringNative {
  Entry?: new (service: string, account: string) => KeyringEntry;
  AsyncEntry?: new (service: string, account: string) => KeyringEntry;
}

function isKeyringNative(v: unknown): v is KeyringNative {
  return v !== null && typeof v === "object";
}

function loadOsKey(): Buffer | null {
  if (cachedOsKey) return cachedOsKey;
  const nativePath = findKeyringNative();
  if (!nativePath) return null;

  try {
    const native: unknown = require(nativePath);
    if (!isKeyringNative(native)) return null;
    const EntryClass = native.Entry ?? native.AsyncEntry;
    if (typeof EntryClass !== "function") return null;

    const entry = new EntryClass(CRED_SERVICE, credAccount);
    const pw = entry.getPassword();
    if (!pw) return null;
    cachedOsKey = Buffer.from(pw, "base64url");
    return cachedOsKey;
  } catch {
    return null;
  }
}

function decryptV2(key: Buffer, val: string): string | null {
  if (!val.startsWith("enc:v2:os:")) return null;
  try {
    const inner = val.slice("enc:v2:os:".length);
    const colonIdx = inner.indexOf(":");
    if (colonIdx === -1) return null;
    const dotParts = inner.slice(colonIdx + 1).split(".");
    if (dotParts.length !== 3) return null;
    const [iv, tag, data] = dotParts.map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !data) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function readDeviceMid(): string {
  for (const filename of ["telemetry-state.json", "onboarding-record.json"]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(ZCODE_DATA_DIR, filename), "utf8"));
      if (parsed && typeof parsed === "object" && "deviceMid" in parsed && typeof parsed.deviceMid === "string") {
        const trimmed = parsed.deviceMid.trim();
        if (trimmed) return trimmed;
      }
    } catch {
      // non-fatal, try next file
    }
  }
  return "";
}

export interface ZCodeCredentials {
  /** zcodejwttoken — authenticates Start Plan completions, balance, and claim. */
  jwt: string;
  /** X-Device-Mid device identifier. */
  deviceMid: string;
}

/** Decode JWT exp claim in ms (0 if unreadable / missing). */
export function jwtExpiryMs(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = parts[1];
    if (!payload) return 0;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims && typeof claims === "object" && "exp" in claims) {
      const exp = Number(claims.exp);
      return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    }
  } catch {
    // ignore malformed claims
  }
  return 0;
}

export function isJwtExpired(jwt: string): boolean {
  const exp = jwtExpiryMs(jwt);
  return exp > 0 && Date.now() > exp;
}

/** Load ZCode Desktop credentials. Throws if no active session found. */
export function loadCredentials(): ZCodeCredentials {
  const envJwt = process.env.ZCODE_JWT_TOKEN?.trim();
  const envMid = process.env.ZCODE_DEVICE_MID?.trim();
  if (envJwt) {
    return { jwt: envJwt, deviceMid: envMid || readDeviceMid() };
  }

  let rawCreds: unknown;
  try {
    rawCreds = JSON.parse(readFileSync(CRED_FILE, "utf8"));
  } catch {
    throw new Error(
      "ZCode credentials not found. Open ZCode Desktop and sign in first, or set ZCODE_JWT_TOKEN.",
    );
  }

  if (!rawCreds || typeof rawCreds !== "object" || !("zcodejwttoken" in rawCreds)) {
    throw new Error("zcodejwttoken not found in ~/.zcode/v2/credentials.json.");
  }
  const rawJwt = rawCreds.zcodejwttoken;
  if (typeof rawJwt !== "string" || !rawJwt.trim()) {
    throw new Error("zcodejwttoken is empty in ~/.zcode/v2/credentials.json.");
  }

  let jwt: string | null = null;
  if (rawJwt.startsWith("enc:v2:os:")) {
    const key = loadOsKey();
    if (!key) {
      throw new Error(
        "Cannot unlock ZCode OS keyring. Ensure ZCode Desktop is installed or set ZCODE_JWT_TOKEN.",
      );
    }
    jwt = decryptV2(key, rawJwt);
  } else if (rawJwt.startsWith("enc:")) {
    // Unknown ciphertext version (e.g. a future enc:v3): fail loudly instead of
    // sending the ciphertext blob as a bearer token and getting confusing 401s.
    throw new Error(
      `Unrecognised ZCode credential format (${rawJwt.split(":").slice(0, 2).join(":")}…). Update ZCode Desktop or set ZCODE_JWT_TOKEN.`,
    );
  } else {
    jwt = rawJwt;
  }

  if (!jwt || !jwt.trim()) {
    throw new Error("Failed to decrypt ZCode JWT token.");
  }

  return { jwt: jwt.trim(), deviceMid: envMid || readDeviceMid() };
}
