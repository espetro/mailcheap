// Seeds one account, newsletter, campaign, contacts and messages straight into Mongo, then writes URL lists
// minted by the upstream lib/tracking.js and lib/unsubscribe.js. Run through the test loader so `@/` resolves:
//   MONGODB_URI=... BETTER_AUTH_SECRET=... node --import ./tests/setup/register.mjs bench/seed.mjs [--reset] [--count N]
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { getClickUrl, getOpenUrl } from "../lib/tracking.js";
import { createUnsubscribeToken } from "../lib/unsubscribe.js";

const args = process.argv.slice(2);
const count = Number(args[args.indexOf("--count") + 1]) || 50_000;
const outDir = new URL("./out/", import.meta.url).pathname;
const BASE = "";

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const { ObjectId } = mongoose.Types;

if (args.includes("--reset")) {
	await db.collection("messages").updateMany({}, { $set: { openedAt: null, clickedAt: null } });
	await db.collection("contacts").updateMany({}, { $set: { status: "active", stats: { opens: 0, clicks: 0 } }, $unset: { unsubscribedAt: 1 } });
	await db.collection("campaigns").updateMany({}, { $set: { stats: { sent: count, opened: 0, clicked: 0, unsubscribed: 0 } } });
	await mongoose.disconnect();
	console.log("reset");
	process.exit(0);
}

for (const name of ["messages", "contacts", "campaigns", "newsletters", "accounts", "events"]) {
	await db.collection(name).deleteMany({});
}

const now = new Date();
const sentAt = new Date(now.getTime() - 24 * 3600 * 1000);
const accountId = new ObjectId();
const newsletterId = new ObjectId();
const campaignId = new ObjectId();

await db.collection("accounts").insertOne({ _id: accountId, ownerId: new ObjectId(), status: "active", createdAt: now, updatedAt: now });
await db.collection("newsletters").insertOne({
	_id: newsletterId, accountId, name: "Bench", slug: "bench", fromEmail: "bench@example.com", createdAt: now, updatedAt: now,
});
await db.collection("campaigns").insertOne({
	_id: campaignId, accountId, newsletterId, startedAt: sentAt, stats: { sent: count, opened: 0, clicked: 0, unsubscribed: 0 }, createdAt: now, updatedAt: now,
});

const contacts = [];
const messages = [];
for (let i = 0; i < count; i++) {
	const contactId = new ObjectId();
	contacts.push({
		_id: contactId, accountId, newsletterId, email: `reader${i}@example.com`, status: "active", stats: { opens: 0, clicks: 0 }, createdAt: now, updatedAt: now,
	});
	messages.push({
		_id: new ObjectId(), accountId, newsletterId, campaignId, contactId, kind: "campaign", email: `reader${i}@example.com`,
		status: "delivered", sentAt, deliveredAt: sentAt, openedAt: null, clickedAt: null, createdAt: now, updatedAt: now,
	});
}
for (let i = 0; i < count; i += 5000) {
	await db.collection("contacts").insertMany(contacts.slice(i, i + 5000));
	await db.collection("messages").insertMany(messages.slice(i, i + 5000));
}

const strip = (url) => url.replace(/^https?:\/\/[^/]*/, "");
const lines = (fn) => messages.map(fn).join("\n") + "\n";
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}open.txt`, lines((m) => strip(getOpenUrl("http://x", m._id))));
await writeFile(`${outDir}click.txt`, lines((m, i) => strip(getClickUrl("http://x", m._id, `https://example.com/post/${i}`))));
await writeFile(
	`${outDir}unsub.txt`,
	contacts.map((c) => `/api/unsubscribe?token=${createUnsubscribeToken({ contactId: c._id, newsletterId })}`).join("\n") + "\n"
);
await writeFile(`${outDir}ids.json`, JSON.stringify({ accountId, newsletterId, campaignId, count }));
await mongoose.disconnect();
console.log(`seeded ${count} messages`);
