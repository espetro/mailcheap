#!/usr/bin/env bash
# Usage: bench/run.sh <target: next|edge|edge-null> <scenario: F0|S1|S2|S3> <concurrency> <run#>
# Runs one 30 s load against one already-built target, resets the seeded data first, and writes bench/out/results/<target>-<scenario>-c<N>-r<run>.json.
set -euo pipefail
target=$1 scenario=$2 conc=$3 run=$4
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/.."
case $target in
	next) port=3100 ;;
	edge) port=3200 ;;
	edge-null) port=3300 ;;
esac
container=bench-$target-1
base=http://127.0.0.1:$port
export MONGODB_URI="mongodb://127.0.0.1:27200/bench?directConnection=true" BETTER_AUTH_SECRET=bench-secret-bench-secret-bench-secret-1234 SUPPRESSION_HASH_KEY=bench-suppression-bench-suppression-1234
res=bench/out/results; mkdir -p "$res"
tag=$target-$scenario-c$conc-r$run

case $scenario in
	F0) if [ "$target" = next ]; then path=/api/health; else path=/health; fi
		printf '%s\n' "$base$path" > bench/out/urls.txt; extra=(-m GET) ;;
	S1) sed "s#^#$base#" bench/out/open.txt > bench/out/urls.txt; extra=(-m GET) ;;
	S2) sed "s#^#$base#" bench/out/click.txt > bench/out/urls.txt; extra=(-m GET -H "User-Agent: Mozilla/5.0" --redirect 0) ;;
	S3) sed "s#^#$base#" bench/out/unsub.txt > bench/out/urls.txt; extra=(-m POST -H "List-Unsubscribe: One-Click" -H "Content-Type: application/x-www-form-urlencoded" -d "List-Unsubscribe=One-Click") ;;
esac

node --import ./tests/setup/register.mjs bench/seed.mjs --reset > /dev/null
ops() { docker exec bench-mongo-1 mongosh --quiet --eval 'const o=db.serverStatus().opcounters; print(o.insert+","+o.query+","+o.update+","+o.delete+","+o.command)'; }
docker restart "$container" > /dev/null
health=/health; [ "$target" = next ] && health=/api/health
until curl -sf -o /dev/null "$base$health"; do sleep 0.2; done
sleep 3
idle=$(docker stats --no-stream --format '{{.MemUsage}}' "$container" | awk '{print $1}')
before=$(ops)
# The Mongo-sink edge leaks roughly 20 to 50 KiB per request and has no GC, so it gets a fixed request count instead of 30 s.
if [ "$target" = edge ] && [ "$scenario" != F0 ]; then limit=(-n 5000); else limit=(-z 30s); fi

( while true; do docker stats --no-stream --format '{{.MemUsage}}' "$container" | awk '{print $1}'; sleep 1; done ) > "bench/out/mem-$tag.txt" 2>/dev/null &
sampler=$!
if [ "$scenario" = S3 ]; then
	if [ "$target" = edge ]; then lim=(-n 5000); else lim=(30); fi
	node bench/load-post.mjs bench/out/urls.txt "$conc" "${lim[@]}" > "bench/out/oha-$tag.json"
else
	mise exec oha -- oha "${limit[@]}" -c "$conc" --urls-from-file bench/out/urls.txt "${extra[@]}" --no-tui --output-format json > "bench/out/oha-$tag.json"
fi
final=$(docker stats --no-stream --format '{{.MemUsage}}' "$container" | awk '{print $1}')
echo "$final" >> "bench/out/mem-$tag.txt"
pkill -P $sampler 2>/dev/null || true; kill $sampler 2>/dev/null || true; wait $sampler 2>/dev/null || true
sleep 5
after=$(ops)

node -e '
const [, tag, before, after, memFile, idleRaw, ohaFile] = process.argv;
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(ohaFile, "utf8"));
const unit = (s) => { const m = String(s).match(/([\d.]+)\s*(GiB|MiB|KiB|B)/); if (!m) return NaN; const n = parseFloat(m[1]); return m[2] === "GiB" ? n * 1024 : m[2] === "KiB" ? n / 1024 : m[2] === "B" ? n / 1048576 : n; };
const mem = fs.readFileSync(memFile, "utf8").trim().split("\n").map(unit).filter((x) => !Number.isNaN(x));
const b = before.trim().split(",").map(Number), a = after.trim().split(",").map(Number);
const total = Object.values(o.statusCodeDistribution).reduce((x, y) => x + y, 0);
const names = ["insert", "query", "update", "delete", "command"];
const per1k = Object.fromEntries(names.map((n, i) => [n, +(((a[i] - b[i]) / total) * 1000).toFixed(1)]));
const out = { tag, rps: o.summary.requestsPerSec, p50_ms: o.latencyPercentiles.p50 * 1000, p99_ms: o.latencyPercentiles.p99 * 1000, success: o.summary.successRate, statuses: o.statusCodeDistribution, requests: total, peak_rss_mib: Math.max(...mem), idle_rss_mib: unit(idleRaw), mongo_ops_per_1k: per1k };
fs.writeFileSync(`bench/out/results/${tag}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
' "$tag" "$before" "$after" "bench/out/mem-$tag.txt" "$idle" "bench/out/oha-$tag.json"
