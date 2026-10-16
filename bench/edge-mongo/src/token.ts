// Upstream lib/tracking.js and lib/unsubscribe.js token formats, so links in already-sent emails verify.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const SIG_LEN = 22;

export class Keys {
  tracking: Buffer;
  unsub: Buffer;
  constructor(secret: string) {
    this.tracking = Buffer.from(hkdfSync("sha256", secret, "", "mailcheap-tracking-v1", 32));
    this.unsub = Buffer.from(hkdfSync("sha256", secret, "", "mailcheap-unsubscribe-v1", 32));
  }
}

function hmacB64(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function isHex24(s: string): boolean {
  if (s.length !== 24) return false;
  for (let i = 0; i < 24; i++) {
    const ch = s.charCodeAt(i);
    const digit = ch >= 48 && ch <= 57;
    const lower = ch >= 97 && ch <= 102;
    if (!digit && !lower) return false;
  }
  return true;
}

export class OpenToken {
  messageId: string;
  constructor(messageId: string) {
    this.messageId = messageId;
  }
}

export function readOpenToken(keys: Keys, token: string): OpenToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  if (!isHex24(parts[0]) || parts[1].length !== SIG_LEN) return null;
  const sig = hmacB64(keys.tracking, "open:" + parts[0]).slice(0, SIG_LEN);
  if (!same(sig, parts[1])) return null;
  return new OpenToken(parts[0]);
}

export class ClickToken {
  messageId: string;
  url: string;
  signed: boolean;
  constructor(messageId: string, url: string, signed: boolean) {
    this.messageId = messageId;
    this.url = url;
    this.signed = signed;
  }
}

export function readClickToken(keys: Keys, token: string): ClickToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!isHex24(parts[0]) || parts[1].length !== SIG_LEN) return null;
  if (parts[2].length < 4 || parts[2].length > 4000) return null;
  const url = Buffer.from(parts[2], "base64url").toString("utf8");
  if (url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0) return null;
  const sig = hmacB64(keys.tracking, "click:" + parts[0] + ":" + url).slice(0, SIG_LEN);
  return new ClickToken(parts[0], url, same(sig, parts[1]));
}

export class UnsubRef {
  contactId: string;
  newsletterId: string;
  constructor(contactId: string, newsletterId: string) {
    this.contactId = contactId;
    this.newsletterId = newsletterId;
  }
}

// payload "." sig, payload = base64url(JSON {c, n}), sig = base64url(HMAC) (43 chars)
export function readUnsubToken(keys: Keys, token: string): UnsubRef | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  if (parts[0].length < 1 || parts[0].length > 200 || parts[1].length !== 43) return null;
  if (!same(hmacB64(keys.unsub, parts[0]), parts[1])) return null;
  let data: { c: string; n: string };
  try {
    data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { c: string; n: string };
  } catch (e) {
    return null;
  }
  if (typeof data.c !== "string" || typeof data.n !== "string") return null;
  const c = data.c.toLowerCase();
  const n = data.n.toLowerCase();
  if (!isHex24(c) || !isHex24(n)) return null;
  return new UnsubRef(c, n);
}
