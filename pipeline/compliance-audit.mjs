#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditContentItem } from "./lib/compliance.mjs";
import { loadAgentReport, loadCompliancePolicy, loadEvidenceRecords, loadLegalRegistry, loadSourceRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { validateContentData } from "./lib/data-store.mjs";

const root = resolve(import.meta.dirname, "..");
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const publishedOnly = process.argv.includes("--published");
const allowMissingLegal = process.argv.includes("--allow-missing-legal");
const [policy, legalRegistry, data, evidenceRecords, sourceRegistry] = await Promise.all([
  loadCompliancePolicy(root), loadLegalRegistry(root, { required: !allowMissingLegal }), validateContentData(root), loadEvidenceRecords(root), loadSourceRegistry(root),
]);
let items = data.items;
if (contentFlag) items = items.filter(({ id }) => id === contentFlag.slice("--content=".length));
if (publishedOnly) items = items.filter((item) => Object.values(item.editions || {}).some(({ status }) => status === "published"));
if (contentFlag && items.length !== 1) throw new Error(`Unknown content item ${contentFlag}`);
const reports = [];
for (const item of items) {
  const agentReport = await loadAgentReport(root, item);
  reports.push(auditContentItem({ item, data, policy, legalRegistry, evidenceRecords, sourceRegistry, agentReport }));
}
const status = reports.some(({ decision }) => decision === "BLOCK") ? "BLOCK" : reports.some(({ decision }) => decision === "REVIEW") ? "REVIEW" : "PASS";
const full = { schemaVersion: 1, generatedAt: new Date().toISOString(), policyVersion: policy.version, status, reports };
const suffix = contentFlag ? contentFlag.slice("--content=".length) : publishedOnly ? "published" : "all";
const privatePath = resolve(root, "private-compliance/audits", `${suffix}.json`);
await writePrivateJson(privatePath, full);
const summary = {
  generatedAt: full.generatedAt,
  policyVersion: policy.version,
  status,
  checked: reports.length,
  decisions: Object.fromEntries(["PASS", "REVIEW", "BLOCK"].map((decision) => [decision, reports.filter((report) => report.decision === decision).length])),
  reportHash: reports.length ? reports.map(({ contentId, revision, decision, sourceEditionHash }) => `${contentId}:${revision}:${decision}:${sourceEditionHash}`).join("|") : "empty",
};
await mkdir(resolve(root, "pipeline/runtime/compliance"), { recursive: true });
await writeFile(resolve(root, "pipeline/runtime/compliance", `${suffix}.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...summary, privateReport: privatePath }, null, 2));
if (status !== "PASS") process.exitCode = 1;
