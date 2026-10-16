# Mailcheap scriptc rewrite — phase 1 plan

This document captures the carve-out plan for the public ingestion edge
that lives under [`scriptc/`](../scriptc/). It is a placeholder — the
final write-up ships in commit 7.

## Scope (phase 1)

Move the high-traffic, low-complexity endpoints out of the Next.js app
into a single static-compiled native binary:

| Endpoint | Current owner | New owner |
|---|---|---|
| `GET /o/:token` (open pixel) | `app/o/` | scriptc edge |
| `GET /c/:token` (click) | `app/c/` | scriptc edge |
| `GET/POST /unsubscribe/:token` | `app/unsubscribe/` | scriptc edge |
| `POST /webhooks/:provider` | `lib/email-provider/` | scriptc edge (shared-secret receipt) |
| `POST /api/v1/signups` | `app/api/v1/contacts/` | scriptc edge |
| `GET /internal/events?after=N` | new (scriptc-only) | scriptc edge |
| `POST /internal/ack` | new (scriptc-only) | scriptc edge |

Everything else — the dashboard, auth, billing, campaigns, MCP, jobs —
stays in the Next.js app. The Next.js app consumes edge events through
the internal drain API (cursor protocol).

## Why these endpoints

- **Burst traffic**: open/click pixel hits outnumber dashboard hits by
  ~100×; a static ELF without GC avoids cold starts and tail latency.
- **Stateless or near-stateless**: HMAC token verify, JSONL append, fixed
  window — no database round-trips in the request path.
- **Small surface area**: every endpoint fits in a single
  `createRouter()` block; ~200 lines of source.

## Stack constraints

- All `@chttp/*` and `@cutils/*` packages come from sigilco (espetro) and
  share the scriptc compilable subset — the edge ships as one ELF with
  zero runtime dependencies.
- `scriptc 0.3.4` requires `node >=24` (Kimi's archive pinned 0.3.3 and
  `node >=22`); bump to 0.3.4 in this work because the underlying
  `@scriptc/compiler` shifted.
- `@chttp/cache 0.2.0` is deprecated; use `@cutils/cache ^0.3.0`.

## Migration order

1. chore(fork) — scaffold (this directory, README, .gitignore, AGENTS.md)
2. feat(edge) — pixel, token, sink libs
3. feat(edge) — `/o`, `/c` tracking routes + rate-limit helper
4. feat(edge) — unsubscribe GET/POST (RFC 8058)
5. feat(edge) — webhooks + signups + drain/ack
6. feat(edge) — swap JSONL sink for `@cutils/sqlite`
7. docs(scriptc) — final parity assessment + Next.js handoff notes

Each step verifies the static gate (`scriptc coverage`) and the build
gate (`scriptc build`) before the next commit lands.

## Out of scope (later phases)

- Provider-specific webhook signature verification (SES SNS cert-chain,
  Resend svix) — needs platform credentials and DNS, not part of the
  shared-secret receipt.
- `@chttp/mcp` server surface (REST + MCP parity tests).
- Public intake cross-instance rate limit (Upstash); current edge is
  per-process.
- Vendor+patch spike queue (markdown-it, aws4fetch, neosanitize,
  oauth4webapi, s3mini, cronosjs, parse-domain).

These belong to phase 2+ and are tracked as GitHub issues on the fork.