/**
 * Yahoo token encryption — deterministic, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decryptToken,
  encryptToken,
  YahooTokenCryptoError,
  yahooCryptoStatus,
} from "../lib/providers/yahoo/crypto";

const KEY_ENV = { YAHOO_TOKEN_ENCRYPTION_KEY: "a".repeat(64) } as unknown as NodeJS.ProcessEnv;

describe("yahoo token crypto", () => {
  it("round-trips a token through AES-256-GCM", () => {
    const secret = "AaBbCc.long.refresh.token.value-123";
    const envelope = encryptToken(secret, KEY_ENV);
    assert.notEqual(envelope, secret);
    assert.equal(envelope.split(".").length, 3);
    assert.equal(decryptToken(envelope, KEY_ENV), secret);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptToken("same", KEY_ENV);
    const b = encryptToken("same", KEY_ENV);
    assert.notEqual(a, b);
    assert.equal(decryptToken(a, KEY_ENV), "same");
    assert.equal(decryptToken(b, KEY_ENV), "same");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const env = encryptToken("tok", KEY_ENV);
    const [iv, tag, ct] = env.split(".") as [string, string, string];
    const flipped = ct[0] === "A" ? "B" : "A";
    const tampered = `${iv}.${tag}.${flipped}${ct.slice(1)}`;
    assert.throws(() => decryptToken(tampered, KEY_ENV), YahooTokenCryptoError);
  });

  it("fails when decrypting with a different key", () => {
    const env = encryptToken("tok", KEY_ENV);
    const otherKey = { YAHOO_TOKEN_ENCRYPTION_KEY: "b".repeat(64) } as unknown as NodeJS.ProcessEnv;
    assert.throws(() => decryptToken(env, otherKey), YahooTokenCryptoError);
  });

  it("refuses to encrypt with no key configured", () => {
    assert.throws(() => encryptToken("x", {} as NodeJS.ProcessEnv), YahooTokenCryptoError);
  });

  it("yahooCryptoStatus names the missing env var, never a value", () => {
    assert.deepEqual(yahooCryptoStatus({} as NodeJS.ProcessEnv), {
      configured: false,
      missing: ["YAHOO_TOKEN_ENCRYPTION_KEY"],
    });
    assert.equal(yahooCryptoStatus(KEY_ENV).configured, true);
  });

  it("accepts a passphrase (hashed to 32 bytes) as well as a raw key", () => {
    const env = { YAHOO_TOKEN_ENCRYPTION_KEY: "a short human passphrase" } as unknown as NodeJS.ProcessEnv;
    const e = encryptToken("tok", env);
    assert.equal(decryptToken(e, env), "tok");
  });
});
