// mailcheap-elf: public ingestion edge for the Mailcheap scriptc
// rewrite. This commit wires the tracking pixel + click redirect routes
// (and only those) on top of the libs from commit 2.
//
// Routes in this commit:
//   GET /o/:token   open-tracking pixel (1x1 GIF, no-store)
//   GET /c/:token   click tracking -> 302 redirect (http/https only)
//
// Subsequent commits layer on unsubscribe, webhooks, signups, the
// internal drain, and the SQLite sink swap.

import { createRouter } from "@chttp/router";
import { enqueueEvent } from "./lib/sink.ts";
import { verifyToken } from "./lib/token.ts";
import { PIXEL_GIF } from "./lib/pixel.ts";

const EDGE_TOKEN_KEY =
  process.env.EDGE_TOKEN_KEY || "dev-only-token-key-32-chars-minimum!";

function clientIp(fwd: string | null): string {
  if (fwd !== null && fwd.length > 0) {
    const comma = fwd.indexOf(",");
    if (comma > 0) return fwd.slice(0, comma).trim();
    return fwd.trim();
  }
  return "unknown";
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

const PORT = Number(process.env.PORT || "8787");
app.serve({ port: PORT });
console.log("mailcheap-elf listening on :" + String(PORT));