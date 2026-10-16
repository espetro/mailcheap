# scriptc edge — Mailcheap carve-out (phase 1)

A single static-compiled native binary (`edge-bin`) that owns Mailcheap's
high-traffic, low-complexity public endpoints, compiled from a strict
TypeScript subset via
[`scriptc`](https://github.com/vercel-labs/scriptc).

The Next.js app stays authoritative for everything else (dashboard,
auth, billing, campaigns, MCP, jobs) and consumes this edge's events
through the internal drain API.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Compiler | `scriptc` ^0.3.4 | TypeScript subset → native ELF, ~4 MB binary |
| HTTP | `@chttp/router` ^0.3.0 | `createRouter`, `{ body: true }` opt-in body buffering |
| Validation | `@chttp/val` ^0.3.0 | Standard Schema, subset-disciplined |
| Rate limit | `@cutils/cache` ^0.3.0 | LRU + TTL, replaces deprecated `@chttp/cache` |
| Tokens | `node:crypto` subset | HMAC-SHA256, `timingSafeEqual` |
| Event sink | `@cutils/sqlite` ^0.3.0 | Embedded SQLite via FFI; cursor protocol compatible with the legacy JSONL implementation |

All of `@chttp/*`, `@cutils/*` and `scriptc` come from the same author
(sigilco/espetro) and share the scriptc compilable subset — the edge
ships as one ELF with zero runtime dependencies.

## Layout

```
scriptc/
├── README.md           this file
├── package.json        scriptc + chttp + cutils deps
├── src/
│   ├── main.ts         chttp router, route table
│   └── lib/
│       ├── pixel.ts    GIF + unsubscribe HTML constants
│       ├── token.ts    HMAC mint/verify
│       ├── sink.ts     @cutils/sqlite cursor (enqueue/drain/ack)
│       └── ratelimit.ts  fixed-window over @cutils/cache
└── data/               gitignored: sqlite + archive (sink rotated here)
```

## Subset constraints (do not regress)

These are real `scriptc 0.3.4` / `@chttp/router` behaviors documented
during the MVP bring-up; each is the kind of thing that costs a
debugging round if you forget:

1. `c.req.body()` returns `""` unless the route declares
   `{ body: true }` as the third arg to `app.post(path, handler, opts)`.
   Silent by design; surfaces as `invalid_json` on every body-reading
   route until fixed.
2. Never pass `c` into a helper typed with an inline object shape
   (`{ req: { header(n): … } }`) — scriptc erases the method table and
   the call throws `expected function at $.req.header`. Pass plain
   strings across function boundaries.
3. `appendFileSync` is 2-arg under scriptc; no encoding argument.
4. `@cutils/cache` is a phantom generic: annotate the variable
   (`const c: Cache<string> = new Cache({max, ttl})`), the constructor
   takes no type argument, and `get()` returns `unknown` — narrow with
   `typeof` before use.
5. `@chttp/val` `safeParse` returns `{ success, output, issues }` — the
   field is `output` (unknown), not `value`; `optionalStr(inner, default)`
   requires both args.

## Build & run

```sh
cd scriptc
npm install
npm run install:scripts   # one-time: approve + rebuild scriptc native
npm run coverage          # static gate, 100% required
npm run build             # → edge-bin (native ELF, ~4 MB)

EDGE_TOKEN_KEY=<32+ chars> \
WEBHOOK_SECRET=<…> \
DRAIN_SECRET=<…> \
PORT=8787 \
./edge-bin
```

Environment:

- `EDGE_TOKEN_KEY` — shared with the main app, which mints tokens at
  send time
- `WEBHOOK_SECRET` — provider webhook receipt
- `DRAIN_SECRET` — internal drain (main app)
- `EDGE_DEV_MINT=1` — enable `/dev/mint/*` and `/dev/echo` (never in prod)

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/o/:token` | Open-tracking pixel (1×1 GIF, no-store) |
| GET | `/c/:token` | Click tracking → 302 (http/https only) |
| POST | `/webhooks/:provider` | Provider webhook receipt (shared secret, 1 MB cap) |
| GET | `/unsubscribe/:token` | Browser confirmation page |
| POST | `/unsubscribe/:token` | RFC 8058 one-click |
| POST | `/api/v1/signups` | Public signup intake (`@chttp/val` strictObject) |
| GET | `/internal/events?after=N` | Event drain for the main app (Bearer) |
| POST | `/internal/ack` | Ack offset; rotates the sink when fully drained |
| GET | `/health` | Liveness + pending-bytes gauge |
| GET | `/dev/mint/:type/:msg/:camp` | Dev helper (gated) |
| GET | `/dev/check/:token` | Dev helper (gated) |
| POST | `/dev/echo` | Dev helper (gated) |

## Status

Phase 1 in progress. See [`docs/PHASE1.md`](../docs/PHASE1.md) for the
full migration plan and the parity assessment versus upstream.

Fork: `espetro/mailcheap` · upstream: `marclou/mailcheap`.