#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditContentItem, isEditionPublishable, policyHash, targetJurisdictions } from "./lib/compliance.mjs";
import { loadAgentReport, loadCompliancePolicy, loadEvidenceRecords, loadLegalRegistry, loadSourceRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { routeKeyForType, routePath, validateContentData } from "./lib/data-store.mjs";

const root = resolve(import.meta.dirname, "..");
const encodedPath = (path) => path.split("/").map((part) => encodeURIComponent(part)).join("/");
const emergency = process.env.EA_EMERGENCY_FREEZE === "1" || process.argv.includes("--emergency-freeze");
const [policy, legalRegistry, data, evidenceRecords, sourceRegistry] = await Promise.all([
  loadCompliancePolicy(root), loadLegalRegistry(root, { required: !emergency }), validateContentData(root, { requirePrivateEvidence: !emergency }), loadEvidenceRecords(root), loadSourceRegistry(root),
]);
const reports = [];
const routePolicies = [];
for (const item of data.items.filter((candidate) => Object.values(candidate.editions || {}).some(({ status }) => status === "published"))) {
  const agentReport = await loadAgentReport(root, item);
  const report = auditContentItem({ item, data, policy, legalRegistry, evidenceRecords, sourceRegistry, agentReport });
  reports.push(report);
  if (report.decision !== "PASS") continue;
  for (const [locale, edition] of Object.entries(item.editions || {})) {
    if (!isEditionPublishable(item, locale)) continue;
    const market = new Set(policy.localeMarkets[locale] || []);
    const allowed = edition.allowedJurisdictions.filter((country) => market.has(country) && report.allowedJurisdictions.includes(country)).sort();
    if (!allowed.length) continue;
    routePolicies.push({
      path: encodedPath(routePath({ locale, sport: item.sport, routeKey: routeKeyForType(item.type), slug: edition.slug, routes: data.routes })),
      contentId: item.id,
      revision: item.revision,
      allowedJurisdictions: allowed,
      expiresAt: edition.complianceValidUntil,
    });
  }
}
const failures = reports.filter(({ decision }) => decision !== "PASS");
if (!emergency && failures.length) throw new Error(`Compliance release blocked ${failures.length} published content items`);
if (!emergency && !routePolicies.length) throw new Error("Normal release has no compliance-approved public content routes; use emergency freeze for a holding-site release");
const targetCountries = targetJurisdictions(policy);
const countryIndex = Object.fromEntries(targetCountries.map((country, index) => [country, index]));
const expiresAt = routePolicies.length ? routePolicies.map(({ expiresAt: value }) => value).sort()[0] : new Date(Date.now() + Number(policy.publicationLeaseHours || 24) * 3_600_000).toISOString();
const edgeManifest = {
  schemaVersion: 1,
  publicationMode: emergency ? "frozen" : "normal",
  policyHash: policyHash(policy),
  generatedAt: new Date().toISOString(),
  contentValidUntil: expiresAt,
  countryIndex,
  routes: routePolicies.map((route) => ({
    ...route,
    countryMask: route.allowedJurisdictions.reduce((mask, country) => mask | (1 << countryIndex[country]), 0).toString(16),
  })),
};
await mkdir(resolve(root, "pipeline/runtime/compliance"), { recursive: true });
await writeFile(resolve(root, "pipeline/runtime/compliance/edge-manifest.json"), `${JSON.stringify(edgeManifest, null, 2)}\n`, { mode: 0o600 });
const releaseReport = {
  schemaVersion: 1,
  generatedAt: edgeManifest.generatedAt,
  status: failures.length && !emergency ? "BLOCK" : "PASS",
  publicationMode: edgeManifest.publicationMode,
  publishedItems: reports.length,
  routePolicies: routePolicies.length,
  targetJurisdictions: targetCountries,
  contentValidUntil: expiresAt,
};
await writePrivateJson(resolve(root, "private-compliance/releases", `${edgeManifest.generatedAt.replace(/[-:.TZ]/g, "")}.json`), { ...releaseReport, reports, edgeManifest });
await writeFile(resolve(root, "pipeline/runtime/compliance/release-report.json"), `${JSON.stringify(releaseReport, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(releaseReport, null, 2));
