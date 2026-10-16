# Performance assessment: current vs. after the scriptc plan

Measured on 2026-10-16 on the `fork/scriptc-phase-1` branch. Rig and scripts live in [`bench/`](../bench/); the plan is `.agents/plans/2026-10-16-scriptc-perf-assessment.md`.

## Summary

The shipped Phase 1 edge gains nothing today: it does not compile against the published packages, and once patched its SQLite sink cannot run from them either, so it serves no traffic and no baseline against it exists.

A working edge that writes straight to MongoDB through `@cutils/mongo` does exist as a spike (`bench/edge-mongo/`), but only after patching a vendored copy of the driver, and it leaks 20 to 60 KiB per request on the open path, which kills a 512 MB container after roughly 9,000 opens. It is not a candidate for production as it stands.

Where the spike runs, the framework is much cheaper than Next.js (static 200 at concurrency 64: at least 12x the requests per second, 0.8 MiB idle against 98 MiB, 5 MB binary against a 1.9 GB image), but the endpoints that matter are bound by the Mongo writes, and there the gain is 1.6x to 4x for opens and unsubscribes and none for clicks.

## Method and caveats

Each app ran in a Docker container (Dory, `--cpus=1 --memory=512m`) next to `mongo:8` (single-node replica set), seeded with 50,000 messages and contacts by `bench/seed.mjs` using tokens minted by the upstream `lib/tracking.js` and `lib/unsubscribe.js`. Load came from `oha` 1.16.0 (30 s per run) at concurrency 1 and 64; S3 uses `bench/load-post.mjs` because upstream limits unsubscribes to 60 per minute per `X-Forwarded-For` address and `oha` cannot vary a header per request. The target is restarted and the seed reset before every run. Every cell is the median of 3 runs; spread above 10% is flagged. The data set is reset between runs but not inside a run, so a run mixes first-transition writes with repeats of the same token.

The numbers come from a macOS host with Docker in a VM, so they are indicative, not VPS-exact. The static 200 on both ELF variants tops out at about 11.4k requests per second at concurrency 64 regardless of what the server does, which is the client and port forwarding, so the ratio against Next.js on that row is a lower bound.

The Mongo-sink edge ("edge") runs 5,000 requests per run instead of 30 s because it exhausts memory otherwise (see findings). "edge-null" is the same binary with `SINK=none`: it does the token verification and builds the response but makes no Mongo call, which separates the framework cost from the write cost.

Scenarios: F0 static 200 (`/api/health` on Next.js, `/health` on the ELF); S1 `GET /o/:token` with a valid token; S2 `GET /c/:token` signed, 302; S3 one-click unsubscribe POST. The `E-sqlite` variant in the plan could not be built (see findings), and the batched `bulkWrite` variant was not written.

## Results

| target | scenario | c | req/s | spread | p50 ms | p99 ms | ok | peak RSS MiB | idle RSS MiB | mongo q/u/cmd per 1k |
|---|---|---|---|---|---|---|---|---|---|---|
| edge | F0 | 1 | 2520 | 36% ⚠️ | 0.30 | 2.13 | 100% | 1 | 0.8 | 0/0/0.1 |
| edge | F0 | 64 | 11421 | 3% | 5.18 | 11.34 | 100% | 2 | 0.8 | 0/0/0 |
| edge | S1 | 1 | 1159 | 19% ⚠️ | 0.69 | 3.13 | 100% | 294 | 0.8 | 1000.2/1604.4/2.6 |
| edge | S1 | 64 | 1342 | 13% ⚠️ | 42.51 | 97.93 | 100% | 304 | 0.8 | 1000.2/2409.8/2 |
| edge | S2 | 1 | 177 | 25% ⚠️ | 4.98 | 14.91 | 100% | 2 | 0.8 | 1000.2/3955.4/4.6 |
| edge | S2 | 64 | 222 | 11% ⚠️ | 281.64 | 509.12 | 100% | 22 | 0.8 | 1000.2/3951.4/4 |
| edge | S3 | 1 | 262 | 6% | 3.24 | 10.90 | 100% | 1 | 0.8 | 2000.2/1000/1003.4 |
| edge | S3 | 64 | 500 | 30% ⚠️ | 118.95 | 342.90 | 100% | 8 | 0.8 | 2000.2/1000/1003.4 |
| edge-null | F0 | 1 | 3784 | 7% | 0.24 | 0.44 | 100% | 1 | 0.8 | 0/0/0.1 |
| edge-null | F0 | 64 | 11381 | 1% | 5.15 | 11.38 | 100% | 2 | 0.8 | 0/0/0 |
| edge-null | S1 | 1 | 3009 | 10% | 0.32 | 0.54 | 100% | 1 | 0.8 | 0/1.5/0.2 |
| edge-null | S1 | 64 | 9771 | 5% | 6.24 | 13.26 | 100% | 3 | 0.8 | 0/0/0.1 |
| edge-null | S2 | 1 | 2168 | 21% ⚠️ | 0.43 | 0.79 | 100% | 1 | 0.8 | 0/0/0.4 |
| edge-null | S2 | 64 | 8652 | 3% | 6.93 | 15.03 | 100% | 3 | 0.8 | 0/0/0.1 |
| edge-null | S3 | 1 | 2961 | 22% ⚠️ | 0.32 | 0.55 | 100% | 1 | 0.8 | 0/0/0.3 |
| edge-null | S3 | 64 | 9494 | 7% | 6.42 | 13.51 | 100% | 3 | 0.8 | 0/0/0.1 |
| next | F0 | 1 | 833 | 7% | 0.94 | 3.80 | 100% | 186 | 98.0 | 0/0/0.6 |
| next | F0 | 64 | 923 | 56% ⚠️ | 53.78 | 208.17 | 100% | 203 | 97.7 | 0/0/0.3 |
| next | S1 | 1 | 298 | 10% ⚠️ | 2.61 | 21.69 | 100% | 210 | 98.8 | 1001.5/2921.3/10.1 |
| next | S1 | 64 | crashed | n/a | n/a | n/a | 0.2% | 364 | 102.3 | n/a |
| next | S2 | 1 | 199 | 28% ⚠️ | 4.10 | 27.28 | 100% | 187 | 99.1 | 1001.9/3934.2/12.6 |
| next | S2 | 64 | 191 | 4% | 317.20 | 646.43 | 100% | 202 | 97.8 | 1013.4/3985.5/15.2 |
| next | S3 | 1 | 151 | 11% ⚠️ | 6.11 | 14.74 | 100% | 162 | 98.3 | 2000.7/1000/1012.9 |
| next | S3 | 64 | 305 | 1% | 197.98 | 395.12 | 100% | 185 | 98.1 | 2001.6/1007.7/1006.5 |

Columns: peak RSS is the highest `docker stats` sample (1 per second plus one after the run), so very short runs can understate it; the Mongo column is queries, updates and commands per 1,000 requests from `serverStatus().opcounters` (aggregations count as commands). Next.js S1 at concurrency 64 crashes with a V8 heap out of memory ("Ineffective mark-compacts near heap limit") in all three runs, so the 0.2% success figure is the requests answered before it died.

| | Next.js | ELF |
|---|---|---|
| Idle RSS | 98 MiB | 0.8 MiB |
| Cold start (spawn to first 200, measured inside the container) | about 1.5 s | about 2 ms |
| Artifact | image 1.94 GB | binary 5.2 MB, image 143 MB (Debian slim base) |

Starting the container through `docker start` takes about 3.6 s for every target, so Docker cold-start figures say nothing about the apps.

## Findings

1. **The shipped edge does not compile.** `scriptc/src/lib/sink.ts` calls `prepare(sql)` with one argument; `@cutils/sqlite` 0.3.0 requires a schema there and the schema-less call is `prepareRaw`. tsc reports TS2554, scriptc reports a misleading `SC2013` ("cannot compile npm package '@chttp/router'") for all three packages. With `prepareRaw` it builds to a 3.7 MB binary.
2. **The SQLite sink cannot run from published packages.** The patched binary fails at the first sink call with `shim_open (a binding form with no lowering) SC1090`, so `/health` and `/o` return 500. It needs `--ffi` with `@cutils/sqlite/vendor/manifest.json` plus `declare function shim_*` bindings that exist only in the package's `src/internal/ffi.ts`. Building with `--ffi` against the dist JS gives `SC5002`, and importing the package's TypeScript from `node_modules` gives `SC2009`. `E-sqlite` is therefore recorded as blocked.
3. **`@cutils/mongo` 0.3.0 only works from a patched local copy.** The dist JS fails at runtime (`p.lastIndexOf` is unsupported in `parseHostSpec`), and importing its source from inside `node_modules` is refused (`SC2009`). `bench/edge-mongo/vendor.mjs` copies the source out and applies the patches: the BSON getters and the session checks test `Object.keys(...)` first because reading a missing key of a typed record throws; `BsonDate`'s Date-returning methods are removed (compiler crash); `insertOne`'s generated `_id` assignment is rewritten (compiler crash); URI options go through a helper. Application code also has to avoid `BsonDate`, type handler params as `CtxCore`, and use `CollectionCore`.
4. **The spike leaks memory.** Idle RSS is 0.8 MiB and stays flat on the null sink, but with the Mongo sink the open path (S1, which uses an aggregation) grows 20 to 60 KiB per request (294 to 304 MiB after 5,000 requests) and the container is OOM-killed after about 9,000. S2 and S3 did not grow measurably over 5,000 requests (peaks of 1 to 22 MiB). The cause was not isolated; scriptc documents no memory model.
5. **Next.js collapses under an open burst on a small box.** At concurrency 64 on S1 it dies from heap exhaustion inside the 512 MB limit (peak 364 MiB sampled), most likely because the `after()` writes queue without bound. At concurrency 1 it runs 298 requests per second.
6. **S2 and S3 are database bound, S1 less so.** A signed click costs about 1 query and 4 updates on both stacks, and both stacks answer about 180 to 220 clicks per second at either concurrency. The null edge answers 2,168 to 8,652 on the same route, so the Mongo writes are about 90% of the cost; the same holds on opens (null 3,009 to 9,771, Mongo 1,159 to 1,342) and on unsubscribes (null 2,961 to 9,494, Mongo 262 to 500). `@cutils/mongo` uses one socket per client, so its writes are serialized.
7. **Parity found by the rig** (`bench/parity.sh`, Next.js against the edge for the same requests): the open pixel now matches byte for byte for valid and forged tokens (the spike's pixel was 43 bytes against upstream's 42 until the rig caught it, and Phase 1's pixel has the same bytes). Remaining differences: the router adds `content-type: text/plain; charset=utf-8` to empty-body responses (302, 200 and 400 on `/c` and unsubscribe) where Next.js sends none; the 404 text type differs by a space (`text/plain; charset=utf-8` against `text/plain;charset=utf-8`). Not implemented in the spike and therefore not compared: `HEAD /c` (upstream never counts it), scanner detection beyond what S2 exercises, the unsubscribe rate limit and form flow, the continue page.
8. **Container and runtime details.** `getaddrinfo` fails in the ELF for Docker service names (`ENOTFOUND mongo`), so the rig gives Mongo a fixed IP. As PID 1 the ELF ignores SIGTERM, so `docker stop` waits the full 10 s grace period.
9. **Upstream rate limits unsubscribes to 60 per minute per address.** With one client address `oha` measured only the 429 path (60 successes then 19,419 rejections), which is why S3 uses a custom client.

## Hypotheses

- Opens and clicks dominate request volume: not measured. This needs production logs from a real send; the rig only shows what each request costs.
- On a VPS the footprint win arrives only if Next.js is dropped: confirmed by the numbers above. Next.js stays resident at 98 MiB idle and about 200 MiB under load whatever sits in front of it.
- The per-request cost on `/o` is the Mongo write, so batching could beat the runtime swap: supported indirectly (finding 6), not tested, because the batched `bulkWrite` variant was not written. The campaign counter is only incremented on the first transition, which batching has to preserve.
- `@cutils/mongo` has no SDAM: read from the code, not tested. A primary failover breaks the single connection and nothing reconnects to a new primary, which is acceptable on a single-node VPS database and a gate on Atlas.

## Projection

These follow from the measurements only; nothing here is a benchmark of code that does not exist.

- **(a) Phase 1 fixed for parity, Next.js kept.** Opens run about 4x faster at concurrency 1 (1,159 against 298) and about the same at concurrency 64, where Next.js crashes; unsubscribes about 1.7x faster; clicks no faster. Memory does not go down because `next start` keeps running, and it goes up by the ELF. Blocked until the memory growth on opens is fixed and the parity differences in finding 7 are closed.
- **(b) Phase 1 plus 2 (REST and MCP).** Not measured. The REST and MCP calls are database bound like S2 and S3, so the same bound applies and I would not expect the gain to exceed the unsubscribe figure; the dashboard still needs Next.js.
- **(c) Next.js dropped.** Footprint is the ELF plus a static SPA: 0.8 MiB idle and a 5 MB binary for the four endpoints measured, against 98 MiB idle and a 1.94 GB image. Dashboard and archive SSR are not measured and are the missing weight in this number.

## Revised handoff list

Items that stay: the token and parity corrections (the upstream token format with `hkdfSync` replaces `EDGE_TOKEN_KEY`, which removes handoff item 1), the `/c` behaviors from finding 7, and a synchronous contact write on unsubscribe. Items made moot by direct MongoDB and a same-origin reverse proxy: the SQLite sink, `/internal/events` and `/internal/ack` (items 2 and 3), the drain cursor model, and the CORS and origin work (item 5). New items: fix the open-path memory growth or bound the process, an unsubscribe rate limit equal to upstream's, reconnect handling, and the `getaddrinfo` and SIGTERM behavior.

## Go or no-go inputs for dropping Next.js

- SDAM risk on Atlas (no failover handling).
- Memory behavior of the ELF under sustained load: unexplained growth on the open path.
- Effort to port the dashboard and archive SSR, Better Auth, Stripe billing and the AWS SDK to the scriptc subset, none of which was started or sized here.
- Toolchain state: the published packages did not build or run without patches (findings 1 to 3), so every dependency needs a vendor-and-patch step until the upstream packages are fixed.
- Compliance: unsubscribe must stay synchronous.

## Reproduce

```sh
docker compose -f bench/compose.yaml up -d mongo
docker exec bench-mongo-1 mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"10.77.0.2:27017"}]})'
MONGODB_URI="mongodb://127.0.0.1:27200/bench?directConnection=true" BETTER_AUTH_SECRET=bench-secret-bench-secret-bench-secret-1234 SUPPRESSION_HASH_KEY=bench-suppression-bench-suppression-1234 node --import ./tests/setup/register.mjs bench/seed.mjs --count 50000
docker compose -f bench/compose.yaml --profile next --profile edge --profile edge-null up -d --build
bench/matrix.sh && node bench/summarize.mjs
bench/parity.sh
```
