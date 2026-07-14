#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateContentData } from "./lib/data-store.mjs";
import { auditEdition, buildCorpus } from "./lib/quality.mjs";

const root = resolve(import.meta.dirname, "..");
const policy = JSON.parse(await readFile(resolve(root, "pipeline/config/quality-policy.json"), "utf8"));
const data = await validateContentData(root, { requirePrivateEvidence: true });
const corpus = buildCorpus(data);
const sources = [];
for (const file of (await readdir(resolve(root, "private-evidence"))).filter((name) => name.endsWith(".json"))) {
  const packet = JSON.parse(await readFile(resolve(root, "private-evidence", file), "utf8"));
  for (const record of packet.records || []) sources.push({ sourceId: record.sourceId, text: record.excerpt || "" });
}
const reports = [];
for (const item of data.items) for (const [locale, edition] of Object.entries(item.editions || {})) {
  if (!["approved", "published"].includes(edition.status)) continue;
  reports.push(auditEdition({ item, locale, edition, corpus, sources, policy }));
}
const status = reports.some((report) => report.status === "BLOCK") ? "BLOCK" : reports.some((report) => report.status === "REVIEW") ? "REVIEW" : "PASS";
const destination = resolve(root, "pipeline/runtime/quality/release-report.json");
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify({ generatedAt: new Date().toISOString(), policyVersion: policy.version, status, reports }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ status, checkedEditions: reports.length, report: destination }, null, 2));
if (status !== "PASS") process.exitCode = 1;
