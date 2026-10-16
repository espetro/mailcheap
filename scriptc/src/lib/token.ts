// HMAC-signed stateless tokens for tracking URLs. The format is:
//   base64url(JSON({t,m,c,d})) "." base64url(hmacSha256(data, secret))
//
// Subset-disciplined: no `?.`, no `??`, null over undefined, explicit
// narrowing before any string access.

import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenPayload = {
  t: string;   // "open" | "click" | "unsub"
  m: string;   // message id
  c: string;   // campaign id
  d: string;   // destination url (click only), "" otherwise
};

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function signData(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

export function mintToken(p: TokenPayload, secret: string): string {
  const data = b64urlEncode(JSON.stringify(p));
  const sig = signData(data, secret).toString("base64url");
  return data + "." + sig;
}

export function verifyToken(
  token: string,
  secret: string,
  wantType: string,
): TokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signData(data, secret);
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch (e) {
    return null;
  }
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;
  let parsed: TokenPayload;
  try {
    parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as TokenPayload;
  } catch (e) {
    return null;
  }
  if (typeof parsed.t !== "string") return null;
  if (typeof parsed.m !== "string") return null;
  if (typeof parsed.c !== "string") return null;
  if (parsed.t !== wantType) return null;
  if (typeof parsed.d !== "string") parsed.d = "";
  return parsed;
}