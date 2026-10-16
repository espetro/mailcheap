# Mailcheap scriptc rewrite — phase 1 plan

This document captures the carve-out plan for the public ingestion edge
that lives under [`scriptc/`](../scriptc/). The plan was scaffolded in
the initial commit and refined through commits 2–6; this is the final
write-up.

## Scope (phase 1, complete on this branch)

Move the high-traffic, low-complexity endpoints out of the Next.js app
into a single static-compiled native binary:

| Endpoint | Current owner | New owner | Notes |
|---|---|---|---|
| `GET /o/:token` | `app/o/` | scriptc edge | open pixel |
| `GET /c/:token` | `app/c/` | scriptc edge | click + redirect (http/https allowlist) |
| `GET /unsubscribe/:token` | `app/unsubscribe/` | scriptc edge | confirmation page |
| `POST /unsubscribe/:token` | `app/unsubscribe/` | scriptc edge | RFC 8058 one-click |
| `POST /webhooks/:provider` | `lib/email-provider/` | scriptc edge | shared-secret receipt (1 MB cap) |
| `POST /api/v1/signups` | `app/api/v1/contacts/` | scriptc edge | `@chttp/val` strictObject, 10 req/min/IP |
| `GET /internal/events?after=N` | new (scriptc-only) | scriptc edge | Bearer-auth drain, byte-offset cursor |
| `POST /internal/ack` | new (scriptc-only) | scriptc edge | Bearer-auth ack; deletes drained rows |
| `GET /health` | new (scriptc-only) | scriptc edge | liveness + pending gauge |
| `GET /dev/mint/*`, `GET /dev/check/:token`, `POST /dev/echo` | new (scriptc-only) | scriptc edge | `EDGE_DEV_MINT=1`-gated helpers |

Everything else — the dashboard, auth, billing, campaigns, MCP, jobs —
stays in the Next.js app. The Next.js app consumes edge events through
the internal drain API (cursor protocol).

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
3. `appendFileSync` is 2-arg under scriptc; no encoding argument. (Not
   used by this branch — sink.ts is SQLite-only — but applies to any
   future file write.)
4. `@cutils/cache` is a phantom generic: annotate the variable
   (`const c: Cache<string> = new Cache({max, ttl})`), the constructor
   takes no type argument, and `get()` returns `unknown` — narrow with
   `typeof` before use.
5. `@chttp/val` `safeParse` returns `{ success, output, issues }` — the
   field is `output` (unknown), not `value`; `optionalStr(inner, default)`
   requires both args.
6. `@cutils/sqlite` `Stmt.get()` returns `TRow | undefined`; prefer
   `getOrNull()` to stay subset-strict (no `| undefined` in user code).
7. `mkdir` calls under scriptc: use the literal `{ recursive: true }`
   option object — no computed option shape (erases under subset).

## Migration order (commit log)

| # | Hash prefix | Subject |
|---|---|---|
| 1 | `2b355f4` | `chore(fork): scaffold scriptc/ edge subdir + carve-out plan` |
| 2 | `a4f409a` | `feat(edge): pixel, token, and JSONL sink libraries` |
| 3 | `4d43a3e` | `feat(edge): /o/:token and /c/:token tracking routes + rate-limit helper` |
| 4 | `c96c5e4` | `feat(edge): /unsubscribe GET (browser) and POST (RFC 8058 one-click)` |
| 5 | `e330046` | `feat(edge): webhooks, signups, internal drain/ack, health, dev helpers` |
| 6 | `cd5f0c3` | `feat(edge): swap JSONL sink for @cutils/sqlite` |

Each step landed independently and reverted independently.

## Parity assessment vs. upstream `marclou/mailcheap`

| Upstream capability | Edge equivalent | Parity |
|---|---|---|
| `app/o/[token]/route.js` open pixel | `GET /o/:token` (200 image/gif, no-store) | ⚠️ response shape matches, but the edge reads its own token format (`EDGE_TOKEN_KEY`), so every open link in emails already sent would still be served the pixel with no event recorded; the edge pixel was also 43 bytes against upstream's 42 |
| `app/c/[token]/route.js` click | `GET /c/:token` (302 + http/https allowlist) | ⚠️ partial: no 404 on malformed tokens, no continue page for unsigned links, no 403 disabled page for blocked accounts, no `HEAD` handling, no scanner detection (`isLikelyScanner`), and a different token format that would 400 every link already sent |
| `app/unsubscribe/[token]/page.jsx` confirmation | `GET /unsubscribe/:token` (200 HTML) | ⚠️ different token (`lib/unsubscribe.js` signs `{c,n}` with its own HKDF info) and route (`app/unsubscribe/page.js` + `app/api/unsubscribe/route.js`) |
| `app/unsubscribe/[token]/route.js` one-click | `POST /unsubscribe/:token` (200 OK) | ⚠️ not equivalent: upstream writes the Contact status synchronously and credits the latest campaign, the edge only queues an event for the drain, so a contact can keep receiving a batch that is already going out (compliance risk) |
| `app/api/webhooks/*` SES/Resend receipt | `POST /webhooks/:provider` (shared-secret) | ⚠️ shared-secret only; upstream's providers are `ses`, `ses-tenants`, `postshiba` and `stripe` (not Resend) and each verifies its own signature |
| `app/api/v1/contacts/route.js` signups | `POST /api/v1/signups` (strictObject + email) | ⚠️ no upstream counterpart: `/api/v1/signups` does not exist, public signups go through archive server actions |
| `lib/rate-limit.js` Upstash limiter | `lib/ratelimit.ts` `@cutils/cache` fixed-window | ⚠️ semantic parity, per-instance only |
| `lib/email-events.js` writes | sink cursor drain + ack | ⚠️ pull model replaces QStash push |
| Auth (Better Auth), dashboard, campaigns, billing, MCP | — | intentionally out of scope for phase 1 |

### Behavior deltas (intentional)

- **Click destination scheme allowlist** — `GET /c/:token` rejects
  non-`http(s):` destinations with 400 `invalid link`. Upstream allows
  whatever the link target is. This prevents a token minting bug from
  being exploitable as an open redirect (XSS via `javascript:` URIs,
  for example).
- **Forge-tolerance on `/o/:token`** — forged open tokens still receive
  the pixel (no oracle leak), but no event is written. Upstream emits
  an "invalid open" event in that case; the edge stays silent to keep
  the cursor protocol stable for the drain consumer.
- **In-process rate limiter** — `@cutils/cache` is per-ELF, not shared
  across serverless instances. Acceptable while the edge is one
  process; needs an Upstash REST shim if horizontally scaled.
- **Pull-based event drain** — replaces QStash push with a QStash cron
  in the main app pulling `/internal/events?after=N` every N seconds.
  Adds up to one drain-interval of latency for analytics /
  suppression-list updates.

### Behavior deltas (unintentional, follow-ups)

- Edge doesn't validate webhook provider names. Phase 2 routes the
  `/webhooks/:provider` value through the `lib/email-provider`
  dispatcher on the main app side and 400s for unknown providers.
- Edge has no cron-rotate / VACUUM pass on the SQLite file. Acceptable
  for a single-instance deployment; needs a sidecar cron for multi-
  instance.

### Build and runtime status (measured 2026-10-16)

- The edge as committed does not compile with the published packages: `scriptc/src/lib/sink.ts` calls `prepare(sql)` with one argument, `@cutils/sqlite` 0.3.0 requires a schema there (the schema-less call is `prepareRaw`), and scriptc reports a misleading `SC2013` naming `@chttp/router` for all three packages.
- With that fixed it builds, but the SQLite sink fails at runtime (`shim_open`, `SC1090`): it needs `--ffi` with the package's vendor manifest and bindings that only exist in the package's TypeScript source, which scriptc 0.3.4 rejects when imported from `node_modules`. `/health` and `/o` return 500.
- Details and numbers are in [`PERF.md`](PERF.md).

## Next.js handoff (what the main app needs to change)

For phase 1 to ship to production, the main app needs:

1. **Token mint parity** — the edge reads tokens minted with
   `EDGE_TOKEN_KEY`. The upstream `lib/contact-token.js` mints with a
   different secret. Bridge:
   `lib/contact-token.js` gains an `EDGE_TOKEN_KEY` env var, mints
   edge-bound tokens for `/o`, `/c`, `/unsubscribe` URLs only. Other
   uses (login magic links, etc.) keep the existing secret.

2. **Drain consumer** — add `app/api/worker/drain-edge/route.js` (or a
   QStash cron at `app/api/cron/drain-edge`) that:
   - GETs `http://edge:8787/internal/events?after=<last_offset>` with
     `Authorization: Bearer <DRAIN_SECRET>`
   - Persists events into `lib/email-events.js` / `lib/analytics.js`
     exactly as upstream does today
   - POSTs `/internal/ack` with the new offset once the batch is
     committed
   - Records `<last_offset>` in `models/drain-cursor.js`

3. **Click destination migration** — `app/c/[token]/route.js` becomes a
   thin redirect to `https://<edge-host>/c/<token>`. Same for `app/o/`
   and `app/unsubscribe/`. Status code parity is preserved.

4. **Webhook fanout** — `lib/email-provider/processor.js` reads
   `provider` from the new `/webhooks/:provider` event payload and
   dispatches the existing SES/Resend verification logic on top of
   the already-buffered raw body.

5. **CORS / origin** — the edge is a separate origin from the main app.
   Public form posts to `/api/v1/signups` must either proxy through
   the main app (preserve current CORS) or carry `Access-Control-
   Allow-Origin` on the edge.

6. **Telemetry** — the edge's `console.log("handler-error: …")` is
   stdout-only. Wire it to the main app's `lib/alerts.js` via a
   `lib/telegram.js` hook, or to the existing log drain, in phase 2.

## Out of scope (later phases)

- Provider-specific webhook signature verification (SES SNS cert-chain,
  Resend svix) — needs platform credentials and DNS, not part of the
  shared-secret receipt.
- `@chttp/mcp` server surface (REST + MCP parity tests against
  `tests/parity.test.mjs`).
- Public intake cross-instance rate limit (Upstash); current edge is
  per-process.
- Vendor+patch spike queue (markdown-it, aws4fetch, neosanitize,
  oauth4webapi, s3mini, cronosjs, parse-domain) — covered separately
  as sigilco upstream PRs.

These are tracked as GitHub issues on `espetro/mailcheap`.