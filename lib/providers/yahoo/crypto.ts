/**
 * Application-layer encryption for Yahoo OAuth tokens.
 *
 * The repo has no prior secret-at-rest pattern (Supabase snapshots are public
 * league data stored as plaintext jsonb; every other secret is env-only). Yahoo
 * refresh tokens are long-lived credentials to a real person's account, so they
 * are NOT stored in the clear.
 *
 * Scheme: AES-256-GCM (authenticated) using `node:crypto`, matching this repo's
 * zero-dependency posture (same choice as `lib/http-auth.ts`).
 *
 *   YAHOO_TOKEN_ENCRYPTION_KEY  — 32 bytes, provided as base64 or hex, or any
 *                                 passphrase (hashed to 32 bytes with SHA-256).
 *
 * Ciphertext envelope (single string, DB-friendly):
 *   base64(iv[12]) "." base64(authTag[16]) "." base64(ciphertext)
 *
 * The key never appears in logs, responses, or the database. Decryption failure
 * throws `YahooTokenCryptoError` — callers treat that as "connection unusable,
 * re-authorization required", never as an empty success.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class YahooTokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooTokenCryptoError";
  }
}

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export interface YahooCryptoConfig {
  configured: boolean;
  /** Env var name when missing — never the value. */
  missing: string[];
}

/** Report whether an encryption key is present, without revealing it. */
export function yahooCryptoStatus(env: NodeJS.ProcessEnv = process.env): YahooCryptoConfig {
  const raw = env.YAHOO_TOKEN_ENCRYPTION_KEY?.trim();
  return raw
    ? { configured: true, missing: [] }
    : { configured: false, missing: ["YAHOO_TOKEN_ENCRYPTION_KEY"] };
}

function resolveKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.YAHOO_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new YahooTokenCryptoError(
      "YAHOO_TOKEN_ENCRYPTION_KEY is not set; refusing to store Yahoo tokens.",
    );
  }
  // Accept a proper 32-byte key in base64 or hex; otherwise derive one
  // deterministically from the passphrase so operators cannot foot-gun a
  // short or weak key into a raw AES key.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    /* not base64 */
  }
  return createHash("sha256").update(raw).digest();
}

/** Encrypt a token string. Returns the DB-friendly envelope. */
export function encryptToken(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = resolveKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

/** Decrypt an envelope produced by {@link encryptToken}. Throws on tampering. */
export function decryptToken(envelope: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = resolveKey(env);
  const parts = envelope.split(".");
  if (parts.length !== 3) {
    throw new YahooTokenCryptoError("Malformed Yahoo token ciphertext envelope.");
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    // Wrong key, corrupted row, or tampering — all indistinguishable and all
    // mean the same thing operationally.
    throw new YahooTokenCryptoError(
      "Yahoo token could not be decrypted (wrong YAHOO_TOKEN_ENCRYPTION_KEY or corrupted record).",
    );
  }
}
