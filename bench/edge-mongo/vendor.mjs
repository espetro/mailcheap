// Copies @cutils/mongo's TypeScript source next to the spike and patches what scriptc 0.3.4 can't run as published.
// Sources inside node_modules are treated as npm packages (refused), and the shipped dist JS loses its types, so the
// driver has to be compiled from a local copy. Each patch below is a finding in docs/PERF.md.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const out = `${here}vendor/mongo`;
rmSync(`${here}vendor`, { recursive: true, force: true });
cpSync(`${here}node_modules/@cutils/mongo/src`, out, { recursive: true });

function patch(file, edits) {
	let text = readFileSync(`${out}/${file}`, "utf8");
	for (const [from, to] of edits) {
		if (!text.includes(from)) throw new Error(`${file}: patch target not found: ${from.slice(0, 50)}`);
		text = text.replace(from, to);
	}
	writeFileSync(`${out}/${file}`, text);
}

// 1. Reading a missing key of a typed record slot throws at runtime ("record has no key"), so test with Object.keys.
const valueEdits = [];
const defaults = { hasKey: "false", getVal: "null", getNum: "0", getStr: '""', getBool: "false", getDoc: "null", getArr: "[]" };
let value = readFileSync(`${out}/bson/value.ts`, "utf8");
for (const [fn, fallback] of Object.entries(defaults)) {
	const pattern = new RegExp(`(export function ${fn}\\(doc: BsonDoc, key: string\\)[^{]*\\{\\n)(  const v = doc\\[key\\];)`);
	if (!pattern.test(value)) throw new Error(`value.ts: ${fn} not found`);
	value = value.replace(pattern, (_m, head, read) => `${head}  if (Object.keys(doc).indexOf(key) < 0) {\n    return ${fallback};\n  }\n${read}`);
}
writeFileSync(`${out}/bson/value.ts`, value);

// 2. BsonDate's Date-returning methods crash the compiler (SC9001, "dynObjLit field value of kind func").
patch("bson/value.ts", [
	[/  toDate\(\): Date \{[\s\S]*?toString\(\): string \{\n    return this\.toISOString\(\);\n  \}\n/.exec(readFileSync(`${out}/bson/value.ts`, "utf8"))[0], ""],
	["return v.toISOString();\n    }\n    if (v instanceof Date)", "return new Date(v.ms).toISOString();\n    }\n    if (v instanceof Date)"],
]);

// 3. Indexing a union-typed union slot on insertOne's generated _id also crashes the compiler (SC9001).
patch("index.ts", [
	[
		'      docs[0]["_id"] = { kind: "objectId", v: generated.toHexString() };',
		'      const first: BsonDoc = toBsonDoc(doc as Document);\n      first["_id"] = { kind: "objectId", v: generated.toHexString() };\n      docs[0] = first;',
	],
]);

patch("internal/session.ts", [
	['    const dbField = spec["$db"];\n    if (typeof dbField === "undefined") {', '    if (Object.keys(spec).indexOf("$db") < 0) {'],
	['    const lsidField = spec["lsid"];\n    if (this.activeTxn !== null && typeof lsidField === "undefined") {', '    if (this.activeTxn !== null && Object.keys(spec).indexOf("lsid") < 0) {'],
]);
// 4. The URI options record is string-typed: a missing authSource throws instead of returning undefined.
let session = readFileSync(`${out}/internal/session.ts`, "utf8");
session = session.replaceAll('parsed.options["authSource"]', 'optOr(parsed.options, "authSource")').replaceAll('parsed.options["authMechanism"]', 'optOr(parsed.options, "authMechanism")');
session += `\nfunction optOr(o: { [k: string]: string }, k: string): string {\n  if (Object.keys(o).indexOf(k) >= 0) return o[k];\n  return "";\n}\n`;
writeFileSync(`${out}/internal/session.ts`, session);
console.log("vendored @cutils/mongo with scriptc 0.3.4 patches");
