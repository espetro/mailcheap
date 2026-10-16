// Durable event sink backed by @cutils/sqlite. Replaces the JSONL
// implementation from commit 2: same public surface (enqueueEvent,
// drainEvents, ackEvents, sinkSize), same cursor protocol (monotonic
// numeric offset), same wire format (raw JSON lines, byte-identical
// payload shape so the main app's parser keeps working).
//
// Why SQLite over JSONL:
//   - Append+read concurrency without an fs lock (WAL mode)
//   - Cursor offset is the auto-increment rowid, not a byte position —
//     rotations and partial drains don't shift the cursor
//   - Indexable on (id) for free, and (ts) for free
//   - At ~1.6 MB added binary size we trade the human-readable
//     events.jsonl for a portable sqlite file that survives partial
//     writes; the same archive lifecycle (data/archive-<ts>.db) still
//     applies on full ack.
//
// Subset-disciplined:
//   - Database.open / prepare / run / all / close are subset-clean
//   - Stmt.getOrNull returns TRow | null, never | undefined (subset rule)
//   - node:fs subset covers the mkdir path: existsSync + mkdirSync
//     with the { recursive: true } literal option object.

import { existsSync, mkdirSync } from "node:fs";
import { Database } from "@cutils/sqlite";

const DIR = "./data";
const DB_PATH = DIR + "/events.db";

let db: Database | null = null;
let ins: ReturnType<Database["prepare"]> | null = null;
let sel: ReturnType<Database["prepare"]> | null = null;
let sizeStmt: ReturnType<Database["prepare"]> | null = null;
let capStmt: ReturnType<Database["prepare"]> | null = null;

function ensureDb(): Database {
  if (db !== null) return db;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const d = Database.open(DB_PATH);
  d.exec(
    "CREATE TABLE IF NOT EXISTS events (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "payload TEXT NOT NULL, " +
      "ts INTEGER NOT NULL" +
      ")"
  );
  d.exec("CREATE INDEX IF NOT EXISTS events_ts ON events(ts)");
  ins = d.prepare(
    "INSERT INTO events (payload, ts) VALUES (:payload, :ts)",
  );
  sel = d.prepare(
    "SELECT id, payload FROM events WHERE id > :after ORDER BY id ASC",
  );
  sizeStmt = d.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events");
  capStmt = d.prepare("DELETE FROM events WHERE id <= :cap");
  db = d;
  return d;
}

export function enqueueEvent(jsonLine: string): void {
  const d = ensureDb();
  (ins as ReturnType<Database["prepare"]>).run({
    payload: jsonLine,
    ts: Date.now(),
  });
}

export function sinkSize(): number {
  const d = ensureDb();
  const row = (sizeStmt as ReturnType<Database["prepare"]>).getOrNull([]);
  if (row === null) return 0;
  const m = (row as { m: number }).m;
  return m;
}

export function drainEvents(
  after: number,
): { events: string[]; offset: number } {
  const d = ensureDb();
  const out: { events: string[]; offset: number } = {
    events: [],
    offset: after,
  };
  const rows = (sel as ReturnType<Database["prepare"]>).all({ after: after });
  let maxId = after;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { id: number; payload: string };
    if (row.id > maxId) maxId = row.id;
    out.events.push(row.payload);
  }
  out.offset = maxId;
  return out;
}

export function ackEvents(offset: number): boolean {
  const d = ensureDb();
  const currentMax = sinkSize();
  if (offset < currentMax) return false;
  (capStmt as ReturnType<Database["prepare"]>).run({ cap: offset });
  return true;
}