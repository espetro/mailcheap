// mailcheap-elf: public ingestion edge for the Mailcheap scriptc
// rewrite. This commit lands webhooks, public signups, the internal
// drain/ack endpoints, and the dev helpers on top of /o, /c, and
// /unsubscribe from the prior commits.
//
// Routes in this commit:
//   POST /webhooks/:provider     shared-secret webhook receipt (1 MB cap)
//   POST /api/v1/signups         public signup intake (10 req/min/IP)
//   GET  /internal/events?after=N  Bearer-auth drain with byte-offset cursor
//   POST /internal/ack            Bearer-auth ack; rotates the sink
//   GET  /health                  liveness + pending-bytes gauge
//   GET  /dev/mint/:type/:msg/:camp  dev-only token mint (EDGE_DEV_MINT=1)
//   GET  /dev/check/:token        dev-only token verify
//   POST /dev/echo                dev-only body-readability probe
//
// Subsequent commits swap the JSONL sink for @cutils/sqlite.

import { createRouter } from "@chttp/router";
import * as v from "@chttp/val";
import { enqueueEvent, drainEvents, ackEvents, sinkSize } from "./lib/sink.ts";
import { mintToken, verifyToken } from "./lib/token.ts";
import { rateLimitOk } from "./lib/ratelimit.ts";
import { PIXEL_GIF, UNSUB_PAGE_OK, UNSUB_PAGE_BAD } from "./lib/pixel.ts";
import { timingSafeEqual } from "node:crypto";

const EDGE_TOKEN_KEY =
  process.env.EDGE_TOKEN_KEY || "dev-only-token-key-32-chars-minimum!";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-only-webhook-secret";
const DRAIN_SECRET = process.env.DRAIN_SECRET || "dev-only-drain-secret";

function clientIp(fwd: string | null): string {
  if (fwd !== null && fwd.length > 0) {
    const comma = fwd.indexOf(",");
    if (comma > 0) return fwd.slice(0, comma).trim();
    return fwd.trim();
  }
  return "unknown";
}

function secretEquals(got: string | null, want: string): boolean {
  if (got === null) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOk(authHeader: string | null): boolean {
  if (authHeader === null) return false;
  if (authHeader.indexOf("Bearer ") !== 0) return false;
  return secretEquals(authHeader.slice(7), DRAIN_SECRET);
}

const app = createRouter();

app.onError((err, c) => {
  let msg = "unknown";
  if (err !== null && typeof err === "object") {
    const e = err as { message: string };
    if (typeof e.message === "string") msg = e.message;
  }
  console.log("handler-error: " + msg);
  c.status(500).json({ ok: false, error: msg });
});

// ---- tracking pixel
app.get("/o/:token", (c) => {
  c.header("cache-control", "no-store, no-cache, must-revalidate");
  c.header("expires", "0");
  const token = c.req.param("token");
  if (token !== null) {
    const p = verifyToken(token, EDGE_TOKEN_KEY, "open");
    if (p !== null) {
      const ua = c.req.header("user-agent");
      enqueueEvent(
        "{\"t\":\"open\",\"m\":\"" + p.m + "\",\"c\":\"" + p.c +
          "\",\"ua\":" + JSON.stringify(ua === null ? "" : ua) +
          ",\"ip\":\"" + clientIp(c.req.header("x-forwarded-for")) +
          "\",\"ts\":" + String(Date.now()) + "}"
      );
    }
  }
  return c.bytes(PIXEL_GIF, "image/gif");
});

// ---- click redirect
app.get("/c/:token", (c) => {
  const token = c.req.param("token");
  if (token === null) return c.status(400).text("bad request");
  const p = verifyToken(token, EDGE_TOKEN_KEY, "click");
  if (p === null || p.d.length === 0) return c.status(400).text("invalid link");
  if (p.d.indexOf("http://") !== 0 && p.d.indexOf("https://") !== 0) {
    return c.status(400).text("invalid link");
  }
  enqueueEvent(
    "{\"t\":\"click\",\"m\":\"" + p.m + "\",\"c\":\"" + p.c +
      "\",\"d\":" + JSON.stringify(p.d) +
      ",\"ip\":\"" + clientIp(c.req.header("x-forwarded-for")) +
      "\",\"ts\":" + String(Date.now()) + "}"
  );
  return c.redirect(p.d, 302);
});

// ---- unsubscribe (browser GET + RFC 8058 one-click POST)
app.get("/unsubscribe/:token", (c) => {
  const token = c.req.param("token");
  if (token === null) return c.status(400).html(UNSUB_PAGE_BAD);
  const p = verifyToken(token, EDGE_TOKEN_KEY, "unsub");
  if (p === null) return c.status(400).html(UNSUB_PAGE_BAD);
  enqueueEvent(
    "{\"t\":\"unsub\",\"m\":\"" + p.m + "\",\"c\":\"" + p.c +
      "\",\"ts\":" + String(Date.now()) + "}"
  );
  return c.html(UNSUB_PAGE_OK);
});

app.post("/unsubscribe/:token", (c) => {
  const token = c.req.param("token");
  if (token === null) return c.status(400).text("bad request");
  const p = verifyToken(token, EDGE_TOKEN_KEY, "unsub");
  if (p === null) return c.status(400).text("invalid");
  enqueueEvent(
    "{\"t\":\"unsub\",\"m\":\"" + p.m + "\",\"c\":\"" + p.c +
      "\",\"oneclick\":true,\"ts\":" + String(Date.now()) + "}"
  );
  return c.text("OK");
});

// ---- provider webhooks (HMAC-shared-secret receipt; SES SNS cert-chain
// verification is the documented follow-up for the SES route specifically)
app.post("/webhooks/:provider", (c) => {
  const provider = c.req.param("provider");
  if (provider === null) return c.status(400).text("bad request");
  if (!secretEquals(c.req.header("x-webhook-secret"), WEBHOOK_SECRET)) {
    return c.status(401).text("unauthorized");
  }
  const body = c.req.body();
  if (body.length > 1048576) return c.status(413).text("too large");
  enqueueEvent(
    "{\"t\":\"webhook\",\"p\":\"" + provider + "\",\"body\":" +
      JSON.stringify(body) + ",\"ts\":" + String(Date.now()) + "}"
  );
  return c.json({ ok: true });
}, { body: true });

// ---- public signup API (mirrors mailcheap POST /api/v1/contacts semantics)
const Signup = v.strictObject({
  email: v.pipe(v.string(), v.email()),
  source: v.optionalStr(v.string(), ""),
});

app.post("/api/v1/signups", (c) => {
  const ip = clientIp(c.req.header("x-forwarded-for"));
  if (!rateLimitOk("signup:" + ip, 10, 60000)) {
    return c.status(429).json({ ok: false, error: "rate_limited" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(c.req.body());
  } catch (e) {
    return c.status(400).json({ ok: false, error: "invalid_json" });
  }
  const r = v.safeParse(Signup, raw);
  if (!r.success) return c.status(400).json({ ok: false, error: "invalid_input", issues: r.issues });
  const out = r.output as { email: string; source: string };
  enqueueEvent(
    "{\"t\":\"signup\",\"email\":" + JSON.stringify(out.email) +
      ",\"source\":" + JSON.stringify(out.source) +
      ",\"ip\":\"" + ip + "\",\"ts\":" + String(Date.now()) + "}"
  );
  return c.status(202).json({ ok: true });
}, { body: true });

// ---- internal drain for the main app (QStash job pulls this)
app.get("/internal/events", (c) => {
  if (!bearerOk(c.req.header("authorization"))) {
    return c.status(401).json({ ok: false });
  }
  const afterQ = c.req.query("after");
  let after = 0;
  if (afterQ !== null) after = Number(afterQ);
  if (after < 0 || after !== after) after = 0;
  const d = drainEvents(after);
  const events: unknown[] = [];
  for (let i = 0; i < d.events.length; i++) {
    try {
      events.push(JSON.parse(d.events[i]));
    } catch (e) {
      /* skip corrupt line */
    }
  }
  return c.json({ ok: true, events: events, offset: d.offset, pending: sinkSize() - d.offset });
});

app.post("/internal/ack", (c) => {
  if (!bearerOk(c.req.header("authorization"))) {
    return c.status(401).json({ ok: false });
  }
  let offset = 0;
  try {
    const body = JSON.parse(c.req.body()) as { offset: number };
    offset = body.offset;
  } catch (e) {
    return c.status(400).json({ ok: false, error: "invalid_json" });
  }
  const rotated = ackEvents(offset);
  return c.json({ ok: true, rotated: rotated });
}, { body: true });

app.get("/health", (c) => c.json({ ok: true, pending: sinkSize() }));

// dev helpers: mint + verify tokens and probe body readability. Only
// mounted when EDGE_DEV_MINT=1, otherwise they 404.
app.get("/dev/mint/:type/:msg/:camp", (c) => {
  if (process.env.EDGE_DEV_MINT !== "1") return c.status(404).text("not found");
  const t = c.req.param("type");
  const m = c.req.param("msg");
  const camp = c.req.param("camp");
  if (t === null || m === null || camp === null) return c.status(400).text("bad");
  const dest = c.req.query("d");
  const tok = mintToken(
    { t: t, m: m, c: camp, d: dest === null ? "" : dest },
    EDGE_TOKEN_KEY,
  );
  return c.json({ token: tok });
});

app.get("/dev/check/:token", (c) => {
  if (process.env.EDGE_DEV_MINT !== "1") return c.status(404).text("not found");
  const token = c.req.param("token");
  if (token === null) return c.json({ stage: "param-null" });
  const p = verifyToken(token, EDGE_TOKEN_KEY, "open");
  return c.json({ stage: "checked", toklen: token.length, tok: token, verified: p !== null });
});

app.post("/dev/echo", (c) => {
  if (process.env.EDGE_DEV_MINT !== "1") return c.status(404).text("not found");
  const b = c.req.body();
  return c.json({ len: b.length, body: b });
}, { body: true });

app.notFound((c) => c.status(404).json({ ok: false, error: "not_found" }));

const PORT = Number(process.env.PORT || "8787");
app.serve({ port: PORT });
console.log("mailcheap-elf listening on :" + String(PORT));