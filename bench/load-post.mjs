// POST load with a distinct X-Forwarded-For per request: upstream's unsubscribe limiter keys on the first address
// (60 per minute per IP), and oha can't vary a header per request. Prints oha-shaped JSON on stdout.
// Usage: node bench/load-post.mjs <urls-file> <concurrency> <seconds|-n count>
import http from "node:http";
import { readFileSync } from "node:fs";

const [file, conc, limitArg, countArg] = process.argv.slice(2);
const urls = readFileSync(file, "utf8").trim().split("\n");
const seconds = limitArg === "-n" ? Infinity : Number(limitArg);
const maxCount = limitArg === "-n" ? Number(countArg) : Infinity;
const agent = new http.Agent({ keepAlive: true, maxSockets: Number(conc) });
const body = "List-Unsubscribe=One-Click";
const statuses = {};
const latencies = [];
let sent = 0;
let errors = 0;
const start = process.hrtime.bigint();
const deadline = Date.now() + seconds * 1000;

function one(i) {
	return new Promise((resolve) => {
		const u = new URL(urls[i % urls.length]);
		const t0 = process.hrtime.bigint();
		const req = http.request(
			{ agent, host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { "X-Forwarded-For": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, "List-Unsubscribe": "One-Click", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length } },
			(res) => {
				res.resume();
				res.on("end", () => {
					statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
					latencies.push(Number(process.hrtime.bigint() - t0) / 1e9);
					resolve();
				});
			}
		);
		req.on("error", () => { errors++; resolve(); });
		req.end(body);
	});
}

async function worker() {
	while (Date.now() < deadline && sent < maxCount) await one(sent++);
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
const total = Number(process.hrtime.bigint() - start) / 1e9;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const ok = Object.entries(statuses).filter(([s]) => s.startsWith("2")).reduce((n, [, c]) => n + c, 0);
console.log(JSON.stringify({ summary: { requestsPerSec: latencies.length / total, successRate: ok / (latencies.length + errors || 1) }, latencyPercentiles: { p50: pct(0.5), p99: pct(0.99) }, statusCodeDistribution: statuses, errorDistribution: { errors } }));
