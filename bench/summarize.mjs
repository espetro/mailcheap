// Medians over the runs in out/results, with spread flagged above 10%. Output is a markdown table.
import { readdirSync, readFileSync } from "node:fs";
const dir = new URL("./out/results/", import.meta.url).pathname;
const groups = {};
for (const f of readdirSync(dir)) {
	const r = JSON.parse(readFileSync(dir + f, "utf8"));
	const key = r.tag.replace(/-r\d+$/, "");
	(groups[key] ??= []).push(r);
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const spread = (a) => (Math.max(...a) - Math.min(...a)) / med(a);
const fmt = (n, d = 0) => (n == null ? "n/a" : Number(n).toFixed(d));
console.log("| target | scenario | c | req/s | spread | p50 ms | p99 ms | ok | peak RSS MiB | idle RSS MiB | mongo q/u/cmd per 1k |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const key of Object.keys(groups).sort()) {
	const rs = groups[key];
	const [target, scenario, c] = [key.match(/^(next|edge-null|edge)/)[1], key.match(/-(F0|S\d)-/)[1], key.match(/-c(\d+)/)[1]];
	const rps = rs.map((r) => r.rps);
	const flag = spread(rps) > 0.1 ? " ⚠️" : "";
	const ops = rs[0].mongo_ops_per_1k;
	if (med(rs.map((r) => r.success)) < 0.5) {
		console.log(`| ${target} | ${scenario} | ${c} | crashed | n/a | n/a | n/a | ${fmt(med(rs.map((r) => r.success)) * 100, 1)}% | ${fmt(med(rs.map((r) => r.peak_rss_mib)))} | ${fmt(med(rs.map((r) => r.idle_rss_mib)), 1)} | n/a |`);
		continue;
	}
	console.log(`| ${target} | ${scenario} | ${c} | ${fmt(med(rps))} | ${fmt(spread(rps) * 100)}%${flag} | ${fmt(med(rs.map((r) => r.p50_ms)), 2)} | ${fmt(med(rs.map((r) => r.p99_ms)), 2)} | ${fmt(med(rs.map((r) => r.success)) * 100)}% | ${fmt(med(rs.map((r) => r.peak_rss_mib)))} | ${fmt(med(rs.map((r) => r.idle_rss_mib)), 1)} | ${ops.query}/${ops.update}/${ops.command} |`);
}
