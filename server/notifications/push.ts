/**
 * Web Push implementation (RFC 8291 / Web Push protocol) with zero
 * dependencies: VAPID JWT signing + aes128gcm payload encryption via node:crypto.
 */

import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function hasVapidKeys(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

/** Raw uncompressed EC point (65 bytes, 0x04-prefixed) from an spki DER key. */
function rawPublicPoint(spkiDer: Buffer): Buffer {
  const b = spkiDer;
  const idx = b.lastIndexOf(Buffer.from([0x04]));
  if (idx >= 0 && b.length - idx === 65) return b.subarray(idx);
  // fallback: last 65 bytes
  return b.subarray(b.length - 65);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function derToRawSignature(der: Buffer): Buffer {
  // DER: 30 len 02 rlen r 02 slen s
  let offset = 2;
  if (der[offset] !== 0x02) throw new Error("bad DER");
  const rlen = der[offset + 1]!;
  let r = der.subarray(offset + 2, offset + 2 + rlen);
  offset += 2 + rlen;
  if (der[offset] !== 0x02) throw new Error("bad DER");
  const slen = der[offset + 1]!;
  let s = der.subarray(offset + 2, offset + 2 + slen);
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  r = Buffer.alloc(32 - r.length).fill(0).length === 0 ? r : Buffer.concat([Buffer.alloc(32 - r.length), r]);
  s = Buffer.alloc(32 - s.length).fill(0).length === 0 ? s : Buffer.concat([Buffer.alloc(32 - s.length), s]);
  return Buffer.concat([r, s]);
}

function vapidJwt(endpointUrl: URL): string {
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    Buffer.from(JSON.stringify({
      aud: endpointUrl.origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: config.vapidSubject,
    }))
  );
  const data = `${header}.${claims}`;
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(config.vapidPrivateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const sig = crypto.sign("sha256", Buffer.from(data), privateKey);
  const raw = derToRawSignature(sig);
  return `${data}.${base64url(raw)}`;
}

function encryptPayload(sub: PushSubscription, payload: unknown): Buffer {
  const plaintext = Buffer.from(JSON.stringify(payload));
  const p256dh = Buffer.from(sub.p256dh, "base64url");
  const auth = Buffer.from(sub.auth, "base64url");
  const salt = crypto.randomBytes(16);

  const hkdf = (ikm: Buffer, saltBuf: Buffer, info: Buffer, len: number): Buffer =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, saltBuf, info, len));

  const authSecret = hkdf(auth, Buffer.alloc(0), Buffer.from("Content-Encoding: auth\0"), 32);
  const prk = hkdf(authSecret, p256dh, Buffer.from("Content-Encoding: auth\0"), 32);
  const cek = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const recordSize = Buffer.from([0, 0, 0x10, 0x00]); // 4096
  const keyIdLen = Buffer.from([65]);
  return Buffer.concat([salt, recordSize, keyIdLen, p256dh, encrypted, tag]);
}

/** Send a push notification to one subscription. Resolves to true on success. */
export async function sendPush(sub: PushSubscription, payload: { title: string; body?: string; url?: string }): Promise<boolean> {
  if (!hasVapidKeys()) return false;
  try {
    const endpointUrl = new URL(sub.endpoint);
    const body = encryptPayload(sub, payload);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Authorization: `vapid t=${vapidJwt(endpointUrl)}, k=${base64url(rawPublicPoint(Buffer.from(config.vapidPublicKey, "base64url")))}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 201 || res.status === 200 || res.status === 204) return true;
    if (res.status === 404 || res.status === 410) {
      logger.info("push subscription expired", { status: res.status, endpoint: sub.endpoint.slice(0, 60) });
      return false;
    }
    logger.warn("push failed", { status: res.status, endpoint: sub.endpoint.slice(0, 60) });
    return false;
  } catch (e) {
    logger.warn("push error", { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}