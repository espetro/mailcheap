// Benchmark spike: /o, /c and one-click unsubscribe with upstream token formats, writing the same Mongo documents
// lib/email-events.js writes, through @cutils/mongo. SINK=none skips every Mongo call (framework + token floor).
// AWAIT=1 holds the response until the write finishes (default: respond first, like next/server `after`).

import { createRouter, CtxCore } from "@chttp/router";
import { MongoClient, ObjectId, CollectionCore } from "../vendor/mongo/index.ts";
import { Keys, readOpenToken, readClickToken, readUnsubToken } from "./token.ts";
import { DISABLED_PAGE } from "./pages.ts";

const PORT = Number(process.env.PORT || "8788");
const SECRET = process.env.BETTER_AUTH_SECRET || "";
const MONGO_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.MONGODB_DB || "bench";
const SINK = process.env.SINK || "mongo";
const AWAIT = process.env.AWAIT === "1";
const SCANNER_WINDOW_MS = 30000;

const keys = new Keys(SECRET);
const PIXEL = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
]);

let messages: CollectionCore | null = null;
let campaigns: CollectionCore | null = null;
let contacts: CollectionCore | null = null;
let ready: Promise<void> | null = null;

async function connect(): Promise<void> {
  const client = await MongoClient.connect({ uri: MONGO_URI, dbName: DB_NAME });
  const db = client.database();
  messages = db.collection("messages");
  campaigns = db.collection("campaigns");
  contacts = db.collection("contacts");
}

async function ensure(): Promise<void> {
  if (ready === null) ready = connect();
  await ready;
}

// A browser-ish scanner check, same pattern as lib/tracking.js isLikelyScanner.
const SCANNERS = [
  "bot", "crawl", "spider", "preview", "scan", "proofpoint", "mimecast", "barracuda", "safelinks", "python",
  "curl", "wget", "java/", "okhttp", "go-http", "headless",
];
function isLikelyScanner(userAgent: string, sentAtMs: number): boolean {
  if (userAgent.length === 0) return true;
  const ua = userAgent.toLowerCase();
  for (let i = 0; i < SCANNERS.length; i++) {
    if (ua.indexOf(SCANNERS[i]) >= 0) return true;
  }
  return sentAtMs > 0 && Date.now() - sentAtMs < SCANNER_WINDOW_MS;
}

// Reading a missing key off a Document is a runtime error under scriptc, so every optional field goes through here.
function field(doc: { [k: string]: unknown }, key: string): unknown {
  if (key in doc) return doc[key];
  return null;
}

class Tracked {
  id: ObjectId;
  accountId: ObjectId;
  kind: string;
  campaignId: ObjectId | null;
  contactId: ObjectId | null;
  sentAtMs: number;
  blocked: boolean;
  constructor(id: ObjectId, accountId: ObjectId, kind: string, campaignId: ObjectId | null, contactId: ObjectId | null, sentAtMs: number, blocked: boolean) {
    this.id = id;
    this.accountId = accountId;
    this.kind = kind;
    this.campaignId = campaignId;
    this.contactId = contactId;
    this.sentAtMs = sentAtMs;
    this.blocked = blocked;
  }
}

// One aggregation, as lib/email-events.js findTrackedMessage: the message and its account's status.
async function findTracked(messageId: string): Promise<Tracked | null> {
  await ensure();
  const cur = (messages as CollectionCore).aggregate([
    { $match: { _id: ObjectId.fromHex(messageId) } },
    { $project: { accountId: 1, kind: 1, campaignId: 1, contactId: 1, sentAtMs: { $toLong: "$sentAt" } } },
    { $lookup: { from: "accounts", localField: "accountId", foreignField: "_id", pipeline: [{ $project: { status: 1 } }], as: "account" } },
    { $unwind: "$account" },
  ]);
  const doc = await cur.next();
  await cur.close();
  if (doc === null) return null;
  const account = doc.account as { [k: string]: unknown };
  const sentRaw = field(doc, "sentAtMs");
  const sentAtMs = typeof sentRaw === "number" ? sentRaw : 0;
  const campaignRaw = field(doc, "campaignId");
  const contactRaw = field(doc, "contactId");
  return new Tracked(
    doc._id as ObjectId,
    doc.accountId as ObjectId,
    doc.kind as string,
    campaignRaw === null ? null : (campaignRaw as ObjectId),
    contactRaw === null ? null : (contactRaw as ObjectId),
    sentAtMs,
    field(account, "status") === "paused",
  );
}

// lib/email-events.js applyMessageUpdates for the tracking plan: each counter moves only on the first transition.
async function applyEngagement(m: Tracked, click: boolean): Promise<void> {
  const now: { [k: string]: unknown } = { $bson: "date", v: Date.now() };
  const statsPath = m.kind === "last-chance" ? "lastChance" : "stats";
  const inc: { [k: string]: unknown } = {};
  const contactInc: { [k: string]: unknown } = {};
  let hasCampaignInc = false;
  const fields = click ? ["openedAt", "clickedAt"] : ["openedAt"];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const set: { [k: string]: unknown } = {};
    set[field] = now;
    const filter: { [k: string]: unknown } = { accountId: m.accountId, _id: m.id };
    filter[field] = null;
    const matched = await (messages as CollectionCore).updateOne(filter, { $set: set });
    if (matched > 0) {
      const stat = field === "openedAt" ? "opened" : "clicked";
      const cstat = field === "openedAt" ? "opens" : "clicks";
      inc[statsPath + "." + stat] = 1;
      contactInc["stats." + cstat] = 1;
      hasCampaignInc = true;
    }
  }
  const pending: Promise<number>[] = [];
  if ((m.kind === "campaign" || m.kind === "last-chance") && m.campaignId !== null && hasCampaignInc) {
    pending.push((campaigns as CollectionCore).updateOne({ accountId: m.accountId, _id: m.campaignId }, { $inc: inc }));
  }
  if (m.contactId !== null) {
    const maxes: { [k: string]: unknown } = { lastOpenAt: now, lastEngagedAt: now };
    if (click) maxes.lastClickAt = now;
    const update: { [k: string]: unknown } = { $max: maxes, $set: { ignoredIssues: 0 } };
    if (hasCampaignInc) update.$inc = contactInc;
    pending.push((contacts as CollectionCore).updateOne({ accountId: m.accountId, _id: m.contactId }, update));
  }
  for (let i = 0; i < pending.length; i++) await pending[i];
}

async function recordOpen(messageId: string): Promise<void> {
  try {
    const m = await findTracked(messageId);
    if (m === null || m.blocked) return;
    await applyEngagement(m, false);
  } catch (e) {
    console.log("[tracking] Open not recorded: " + String(e));
  }
}

async function recordClick(m: Tracked, userAgent: string): Promise<void> {
  try {
    if (m.blocked || isLikelyScanner(userAgent, m.sentAtMs)) return;
    await applyEngagement(m, true);
  } catch (e) {
    console.log("[tracking] Click not recorded: " + String(e));
  }
}

async function unsubscribe(contactId: string, newsletterId: string): Promise<void> {
  await ensure();
  const previous = await (contacts as CollectionCore).findOneAndUpdate(
    { _id: ObjectId.fromHex(contactId), newsletterId: ObjectId.fromHex(newsletterId), status: { $in: ["active", "dormant"] } },
    { $set: { status: "unsubscribed", unsubscribedAt: { $bson: "date", v: Date.now() } } },
  );
  if (previous === null) return;
  const accountId = previous.accountId as ObjectId;
  const cur = (campaigns as CollectionCore).find(
    { accountId: accountId, newsletterId: ObjectId.fromHex(newsletterId), startedAt: { $ne: null } },
    { sort: { startedAt: -1 }, limit: 5, projection: { _id: 1 } },
  );
  const recent = await cur.all();
  for (let i = 0; i < recent.length; i++) {
    const campaignId = recent[i]._id as ObjectId;
    const was = await (messages as CollectionCore).findOne(
      { accountId: accountId, kind: "campaign", campaignId: campaignId, contactId: ObjectId.fromHex(contactId), sentAt: { $ne: null } },
      { projection: { _id: 1 } },
    );
    if (was === null) continue;
    await (campaigns as CollectionCore).updateOne({ accountId: accountId, _id: campaignId }, { $inc: { "stats.unsubscribed": 1 } });
    return;
  }
}

function esc(s: string): string {
  return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\"").join("&quot;").split("'").join("&#39;");
}

function continuePage(url: string): string {
  const href = esc(url);
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>Continue</title></head>\n" +
    "<body style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#27272a;\"><main style=\"max-width:32rem;margin:20vh auto;padding:0 20px;\"><p>This link goes to:</p><p><a href=\"" +
    href + "\" rel=\"noopener noreferrer nofollow\" style=\"color:#18181b;word-break:break-all;\">" + href + "</a></p></main></body></html>";
}

const app = createRouter();

app.onError((err, c) => {
  console.log("handler-error: " + String(err));
  c.status(500).text("error");
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/o/:token", async (c: CtxCore) => {
  const token = c.req.param("token");
  if (token !== null && SINK !== "none") {
    const open = readOpenToken(keys, token);
    if (open !== null) {
      if (AWAIT) await recordOpen(open.messageId);
      else recordOpen(open.messageId);
    }
  }
  c.header("cache-control", "no-store, max-age=0");
  return c.bytes(PIXEL, "image/gif");
});


app.get("/c/:token", async (c: CtxCore) => {
  const token = c.req.param("token");
  const link = token === null ? null : readClickToken(keys, token);
  if (link === null) return c.status(404).text("Not found");
  c.header("cache-control", "no-store");
  if (!link.signed) return c.html(continuePage(link.url));
  let tracked: Tracked | null = null;
  if (SINK !== "none") {
    try {
      tracked = await findTracked(link.messageId);
    } catch (e) {
      console.log("[tracking] Link not checked: " + String(e));
    }
    if (tracked !== null && tracked.blocked) {
      c.header("x-robots-tag", "noindex");
      return c.status(403).html(DISABLED_PAGE);
    }
    if (tracked !== null) {
      const ua = c.req.header("user-agent");
      const userAgent = ua === null ? "" : ua;
      if (AWAIT) await recordClick(tracked, userAgent);
      else recordClick(tracked, userAgent);
    }
  }
  return c.redirect(link.url, 302);
});

app.post("/api/unsubscribe", async (c: CtxCore) => {
  c.header("cache-control", "no-store");
  const token = c.req.query("token");
  const ref = token === null ? null : readUnsubToken(keys, token);
  if (ref === null) return c.status(400).text("");
  if (SINK !== "none") {
    try {
      await unsubscribe(ref.contactId, ref.newsletterId);
    } catch (e) {
      console.log("[unsubscribe] Failed: " + String(e));
      return c.status(500).text("");
    }
  }
  return c.status(200).text("");
});

app.notFound((c) => c.status(404).text("not found"));

app.serve({ port: PORT });
console.log("edge-mongo listening on :" + String(PORT) + " sink=" + SINK);
