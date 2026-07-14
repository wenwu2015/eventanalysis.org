#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateContentData } from "./lib/data-store.mjs";
import { auditEdition, buildCorpus } from "./lib/quality.mjs";

const root = resolve(import.meta.dirname, "..");
const policy = JSON.parse(await readFile(resolve(root, "pipeline/config/quality-policy.json"), "utf8"));
const data = await validateContentData(root, { requirePrivateEvidence: true });
const corpus = buildCorpus(data);
const evidence = new Map();
for (const file of (await readdir(resolve(root, "private-evidence"))).filter((name) => name.endsWith(".json"))) {
  const packet = JSON.parse(await readFile(resolve(root, "private-evidence", file), "utf8"));
  for (const record of packet.records || []) evidence.set(record.id, { sourceId: record.sourceId, text: record.excerpt || "" });
}
const factMap = new Map(data.facts.map((fact) => [fact.id, fact]));
function sourcesForItem(item) {
  const ids = new Set();
  for (const claim of item.claims || []) for (const factRef of claim.factRefs || []) {
    for (const evidenceRef of factMap.get(factRef)?.evidenceRefs || []) ids.add(evidenceRef);
  }
  return [...ids].map((id) => evidence.get(id)).filter(Boolean);
}
const reports = [];
for (let index = 0; index < corpus.length; index += 1) {
  const { item, locale, edition } = corpus[index];
  reports.push(auditEdition({ item, locale, edition, corpus: corpus.slice(0, index), sources: sourcesForItem(item), policy }));
}
const status = reports.some((report) => report.status === "BLOCK") ? "BLOCK" : reports.some((report) => report.status === "REVIEW") ? "REVIEW" : "PASS";
const destination = resolve(root, "pipeline/runtime/quality/release-report.json");
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify({ generatedAt: new Date().toISOString(), policyVersion: policy.version, status, reports }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status, checkedEditions: reports.length, report: destination }, null, 2));
if (status !== "PASS") process.exitCode = 1;
