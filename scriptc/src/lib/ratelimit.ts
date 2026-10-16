// Fixed-window rate limiting over @cutils/cache (replaces the deprecated
// @chttp/cache). Per-process; swap the store seam for Upstash REST when
// the sidecar ever runs multi-instance.
//
// Subset gotchas baked in:
//   - @cutils/cache is a phantom generic: annotate the variable, NOT
//     the constructor call.
//   - get() returns `unknown` — narrow with `typeof` before use.

import { Cache } from "@cutils/cache";

const buckets: Cache<string> = new Cache({ max: 50000, ttl: 120000 });

export function rateLimitOk(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const raw = buckets.get(key);
  let count = 0;
  let reset = now + windowMs;
  if (typeof raw === "string") {
    const parts = raw.split(":");
    count = Number(parts[0]);
    reset = Number(parts[1]);
    if (now >= reset) {
      count = 0;
      reset = now + windowMs;
    }
  }
  count += 1;
  buckets.set(key, String(count) + ":" + String(reset));
  return count <= limit;
}