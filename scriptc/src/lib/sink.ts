// Durable JSONL event sink with cursor-based drain. Placeholder for
// @cutils/sqlite once its staged release lands; the cursor protocol
// stays identical, so swapping the backend in commit 6 is mechanical.
//
// Subset-disciplined: appendFileSync is 2-arg under scriptc (no
// encoding), node:fs only exposes the slice we use below.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";

const DIR = "./data";
const FILE = DIR + "/events.jsonl";

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function enqueueEvent(jsonLine: string): void {
  ensureDir();
  appendFileSync(FILE, jsonLine + "\n");
}

export function sinkSize(): number {
  ensureDir();
  if (!existsSync(FILE)) return 0;
  return statSync(FILE).size;
}

// Returns { events: string[], offset: number } — raw JSON lines after
// the byte offset, plus the new offset (= current sink size).
export function drainEvents(after: number): { events: string[]; offset: number } {
  ensureDir();
  const out: { events: string[]; offset: number } = { events: [], offset: after };
  if (!existsSync(FILE)) return out;
  const size = statSync(FILE).size;
  if (after >= size) {
    out.offset = size;
    return out;
  }
  const buf = readFileSync(FILE);
  const slice = buf.subarray(after).toString("utf8");
  const lines = slice.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.length > 0) out.events.push(l);
  }
  out.offset = size;
  return out;
}

// Rotate once the consumer acked everything: archive the file and
// start fresh. Returns false if there's still unacked data.
export function ackEvents(offset: number): boolean {
  ensureDir();
  if (!existsSync(FILE)) return true;
  const size = statSync(FILE).size;
  if (offset < size) return false;
  renameSync(FILE, DIR + "/archive-" + String(Date.now()) + ".jsonl");
  return true;
}