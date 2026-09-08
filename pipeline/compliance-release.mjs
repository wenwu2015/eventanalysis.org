#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditContentItem, isEditionPublishable, policyHash, releaseAuditLocalesForItem, targetJurisdictions } from "./lib/compliance.mjs";
import { loadAgentReport, loadCompliancePolicy, loadEvidenceRecords, loadLegalRegistry, loadSourceRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { normalizeSlug, routeKeyForType, routePath, validateContentData } from "./lib/data-store.mjs";

const root = resolve(import.meta.dirname, "..");
const encodedPath = (path) => path.split("/").map((part) => encodeURIComponent(part)).join("/");
const emergency = process.env.EA_EMERGENCY_FREEZE === "1" || process.argv.includes("--emergency-freeze");
const targetContentId = process.argv.find((value) => value.startsWith("--content="))?.slice("--content=".length) || null;
const requestedLocales = process.argv.find((value) => value.startsWith("--locales="))?.slice("--locales=".length).split(",").map((value) => value.trim()).filter(Boolean) || null;
const [policy, legalRegistry, data, evidenceRecords, sourceRegistry] = await Promise.all([
  loadCompliancePolicy(root), loadLegalRegistry(root, { required: !emergency }), validateContentData(root, { requirePrivateEvidence: !emergency }), loadEvidenceRecords(root), loadSourceRegistry(root),
]);
const reports = [];
const routePolicies = [];
for (const item of data.items.filter((candidate) => Object.values(candidate.editions || {}).some(({ status }) => status === "published"))) {
  const agentReport = await loadAgentReport(root, item);
  const localeScope = releaseAuditLocalesForItem(item, requestedLocales, targetContentId);
  const report = auditContentItem({ item, data, policy, legalRegistry, evidenceRecords, sourceRegistry, agentReport, requestedLocales: localeScope });
  reports.push(report);
  if (report.decision !== "PASS") continue;
  for (const [locale, edition] of Object.entries(item.editions || {})) {
    if (requestedLocales && !requestedLocales.includes(locale)) continue;
    if (!isEditionPublishable(item, locale)) continue;
    const market = new Set(policy.localeMarkets[locale] || []);
    const allowed = edition.allowedJurisdictions.filter((country) => market.has(country) && report.allowedJurisdictions.includes(country)).sort();
    if (!allowed.length) continue;
    routePolicies.push({
      path: encodedPath(routePath({ locale, sport: item.sport, routeKey: routeKeyForType(item.type), slug: edition.slug, routes: data.routes })),
      contentId: item.id,
      revision: item.revision,
    });
  }
}
const failures = reports.filter(({ decision }) => decision !== "PASS");
if (!emergency && failures.length) throw new Error(`Compliance release blocked ${failures.length} published content items`);
if (!emergency && !routePolicies.length) throw new Error("Normal release has no compliance-approved public content routes; use emergency freeze for a holding-site release");
const targetCountries = targetJurisdictions(policy, requestedLocales);
const expiresAt = routePolicies.length ? routePolicies.map(({ expiresAt: value }) => value).sort()[0] : new Date(Date.now() + Number(policy.publicationLeaseHours || 24) * 3_600_000).toISOString();
const activeSports = JSON.parse(await readFile(resolve(root, "content/sports.json"), "utf8"))
  .filter(({ status }) => status === "active")
  .map(({ code }) => code);
const itemById = new Map(data.items.map((item) => [item.id, item]));
const publicRouteSet = new Set();
const releasedLocales = requestedLocales || [...new Set(routePolicies.map(({ path }) => decodeURIComponent(path).split("/")[1]).filter(Boolean))];
for (const locale of releasedLocales) {
  const dictionary = data.routes.locales[locale];
  if (!dictionary) continue;
  for (const sport of activeSports) {
    const base = `/${locale}/${sport}/`;
    publicRouteSet.add(encodedPath(base));
    publicRouteSet.add(encodedPath(`${base}legal/`));
    const localeRoutes = routePolicies.filter(({ path }) => decodeURIComponent(path).startsWith(base));
    if (!localeRoutes.length) continue;
    publicRouteSet.add(encodedPath(`${base}${normalizeSlug(dictionary["all-content"])}/`));
    publicRouteSet.add(encodedPath(`${base}${normalizeSlug(dictionary.search)}/`));
    publicRouteSet.add(encodedPath(`${base}feed.xml`));
    publicRouteSet.add(encodedPath(`${base}search-index.json`));
    const sectionKeys = new Set(localeRoutes.map(({ contentId }) => routeKeyForType(itemById.get(contentId).type)));
    for (const routeKey of sectionKeys) publicRouteSet.add(encodedPath(`${base}${normalizeSlug(dictionary[routeKey])}/`));
  }
}
const edgeManifest = {
  schemaVersion: 1,
  publicationMode: emergency ? "frozen" : "normal",
  policyHash: policyHash(policy),
  generatedAt: new Date().toISOString(),
  publicRoutes: [...publicRouteSet].sort(),
  routes: routePolicies,
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
  publicationScope: "global",
  auditValidUntil: expiresAt,
};
await writePrivateJson(resolve(root, "private-compliance/releases", `${edgeManifest.generatedAt.replace(/[-:.TZ]/g, "")}.json`), { ...releaseReport, reports, edgeManifest });
await writeFile(resolve(root, "pipeline/runtime/compliance/release-report.json"), `${JSON.stringify(releaseReport, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(releaseReport, null, 2));
