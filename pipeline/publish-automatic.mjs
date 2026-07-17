#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditContentItem } from "./lib/compliance.mjs";
import { findContentItemFile, loadAgentReport, loadCompliancePolicy, loadEvidenceRecords, loadLegalRegistry, loadSourceRegistry } from "./lib/compliance-store.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const inputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const localeFlag = process.argv.find((value) => value.startsWith("--locales="));
const requestedLocales = localeFlag ? new Set(localeFlag.slice("--locales=".length).split(",").filter(Boolean)) : null;
if (!inputArg && !contentFlag) throw new Error("Usage: npm run publish:automatic -- <content-item.json> OR --content=<id> [--locales=zh,en]");
let item;
let inputPath;
if (contentFlag) {
  const found = await findContentItemFile(root, contentFlag.slice("--content=".length));
  if (!found) throw new Error(`Unknown content item: ${contentFlag}`);
  item = found.item;
  inputPath = found.path;
} else {
  inputPath = resolve(root, inputArg);
  item = JSON.parse(await readFile(inputPath, "utf8"));
}
await runCommand(["npm", "run", "compliance:preaudit", "--", ...(contentFlag ? [contentFlag] : [inputArg]), ...(requestedLocales ? [`--locales=${[...requestedLocales].join(",")}`] : [])], { cwd: root, timeoutMs: 900_000 });
const [policy, legalRegistry, data, evidenceRecords, sourceRegistry, agentReport] = await Promise.all([
  loadCompliancePolicy(root), loadLegalRegistry(root), loadContentData(root), loadEvidenceRecords(root), loadSourceRegistry(root), loadAgentReport(root, item),
]);
const report = auditContentItem({ item, data, policy, legalRegistry, evidenceRecords, sourceRegistry, agentReport, requestedLocales });
if (report.decision === "BLOCK") {
  const destructive = report.riskClass === "C" || report.findings.some(({ category }) => ["insult", "nationality_attack", "mental_state", "unverified_allegation", "health_speculation"].includes(category));
  const existing = await findContentItemFile(root, item.id);
  if (existing) await runCommand(["node", "pipeline/compliance-quarantine.mjs", `--content=${item.id}`, "--rule=automatic_compliance_block", ...(destructive ? ["--delete-body"] : [])], { cwd: root, timeoutMs: 60_000 });
  else if (destructive) await rm(inputPath, { force: true });
  throw new Error(`Automatic publication blocked and quarantined: ${JSON.stringify(report.findings)}`);
}
if (report.decision === "REVIEW" || report.riskClass !== "A") {
  console.log(JSON.stringify({ contentId: item.id, decision: "REVIEW", riskClass: report.riskClass, action: "human_review_required" }, null, 2));
  process.exitCode = 2;
} else {
  const now = new Date().toISOString();
  item.qualityReview = { reviewer: `compliance-agent:${agentReport.reviewRunId}`, decision: "approved", reviewedAt: now };
  item.complianceReview = { reviewRunId: agentReport.reviewRunId, policyHash: report.policyHash, auditedAt: report.auditedAt, expiresAt: report.expiresAt };
  item.reviewedAt = now;
  if (requestedLocales) {
    for (const locale of requestedLocales) if (!item.editions?.[locale]) throw new Error(`Requested locale is missing from content item: ${locale}`);
  }
  let approvedLocales = 0;
  for (const [locale, edition] of Object.entries(item.editions || {})) {
    if (requestedLocales && !requestedLocales.has(locale)) continue;
    const allowed = (policy.localeMarkets[locale] || []).filter((country) => report.allowedJurisdictions.includes(country));
    if (locale !== "zh" && edition.translationStatus !== "current") throw new Error(`${locale} translation is not current`);
    if (allowed.length) {
      edition.status = "approved";
      edition.complianceStatus = "passed";
      edition.complianceValidUntil = report.expiresAt;
      edition.allowedJurisdictions = allowed;
      edition.reviewer = "Event Analysis Verification Desk";
      approvedLocales += 1;
    } else {
      edition.status = "quarantined";
      edition.complianceStatus = "quarantined";
      delete edition.allowedJurisdictions;
      delete edition.complianceValidUntil;
    }
  }
  if (!approvedLocales) throw new Error("No locale has an approved publication jurisdiction");
  const existing = await findContentItemFile(root, item.id);
  let destination;
  if (existing) {
    existing.records[existing.index] = item;
    destination = existing.path;
    await writeFile(destination, `${JSON.stringify(existing.wrapper ? existing.packet : item, null, 2)}\n`);
  } else {
    destination = resolve(root, "content/data/items", `${item.id}.json`);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, `${JSON.stringify(item, null, 2)}\n`);
  }
  console.log(JSON.stringify({ contentId: item.id, decision: "PASS", riskClass: "A", approvedLocales, destination, publicationMode: "local_preview", awsReleased: false }, null, 2));
}
