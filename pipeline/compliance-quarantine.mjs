#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./lib/compliance.mjs";
import { findContentItemFile, writePrivateJson } from "./lib/compliance-store.mjs";
import { loadContentData, routeKeyForType, routePath } from "./lib/data-store.mjs";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const ruleFlag = process.argv.find((value) => value.startsWith("--rule="));
const localeFlag = process.argv.find((value) => value.startsWith("--locale="));
const deleteBody = process.argv.includes("--delete-body");
const localOnly = process.argv.includes("--local-only");
if (!contentFlag || !ruleFlag) throw new Error("Usage: npm run compliance:quarantine -- --content=<id> --rule=<rule-id> [--locale=<locale>] [--delete-body]");
const contentId = contentFlag.slice("--content=".length);
const ruleId = ruleFlag.slice("--rule=".length);
const found = await findContentItemFile(root, contentId);
if (!found) throw new Error(`Unknown content item: ${contentId}`);
const item = found.item;
const data = await loadContentData(root);
const encodedPath = (path) => path.split("/").map((part) => encodeURIComponent(part)).join("/");
const now = new Date().toISOString();
const selectedLocale = localeFlag?.slice("--locale=".length);
const allLocaleScope = !selectedLocale || selectedLocale === "zh";
const locales = selectedLocale && selectedLocale !== "zh" ? [selectedLocale] : Object.keys(item.editions || {});
const publishedRoutes = Object.entries(item.editions || {}).filter(([locale, edition]) => locales.includes(locale) && edition.status === "published").map(([locale, edition]) => encodedPath(routePath({ locale, sport: item.sport, routeKey: routeKeyForType(item.type), slug: edition.slug, routes: data.routes })));
for (const locale of locales) {
  const edition = item.editions?.[locale];
  if (!edition) throw new Error(`${item.id} has no ${locale} edition`);
  edition.status = "quarantined";
  edition.complianceStatus = "quarantined";
  if (locale !== "zh") edition.translationStatus = "blocked";
  delete edition.allowedJurisdictions;
  delete edition.complianceValidUntil;
}
const bodyHash = sha256(Object.fromEntries(locales.map((locale) => [locale, item.editions[locale]])));
const incidentId = `incident_${now.replace(/[-:.TZ]/g, "")}_${sha256(`${item.id}:${item.revision}:${ruleId}:${bodyHash}`).slice(0, 12)}`;
const incident = {
  schemaVersion: 1,
  incidentId,
  contentId: item.id,
  revision: item.revision,
  locales,
  ruleIds: [ruleId],
  severity: deleteBody ? "C" : "quarantine",
  detectedAt: now,
  bodyHash,
  actions: [{ action: "local_publication_blocked", status: "complete", at: now }],
  resolution: null,
};
await writePrivateJson(resolve(root, "private-incidents", now.slice(0, 4), `${incidentId}.json`), incident);
if (publishedRoutes.length && !localOnly) {
  const tombstonePath = resolve(root, "pipeline/runtime/compliance", `${incidentId}-tombstones.json`);
  await mkdir(resolve(tombstonePath, ".."), { recursive: true });
  await writeFile(tombstonePath, `${JSON.stringify({ incidentId, routes: publishedRoutes }, null, 2)}\n`, { mode: 0o600 });
  await runCommand(["node", "ops/aws/tombstone-routes.mjs", `--manifest=${tombstonePath}`], { cwd: root, timeoutMs: 120_000 });
  incident.actions.push({ action: "edge_tombstone_and_s3_object_delete", status: "complete", at: new Date().toISOString(), routes: publishedRoutes.length });
  await writePrivateJson(resolve(root, "private-incidents", now.slice(0, 4), `${incidentId}.json`), incident);
}
if (deleteBody) {
  const stub = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "editions"));
  stub.removedEditionHashes = Object.fromEntries(locales.map((locale) => [locale, sha256(item.editions[locale])]));
  stub.quarantinedAt = now;
  stub.ruleIds = [ruleId];
  await writePrivateJson(resolve(root, "private-quarantine/stubs", `${item.id}.json`), stub);
  if (!allLocaleScope) {
    for (const locale of locales) delete item.editions[locale];
    found.records[found.index] = item;
  } else found.records.splice(found.index, 1);
} else {
  found.records[found.index] = item;
}
if (deleteBody && allLocaleScope && !found.wrapper) await rm(found.path);
else {
  const output = found.wrapper ? found.packet : found.records[0];
  await writeFile(found.path, `${JSON.stringify(output, null, 2)}\n`);
}
if (publishedRoutes.length && !localOnly) {
  const remaining = (await loadContentData(root)).items.some((candidate) => Object.values(candidate.editions || {}).some(({ status }) => status === "published"));
  await runCommand(["npm", "run", remaining ? "release:aws" : "emergency:freeze", ...(remaining ? [] : ["--", `--reason=${ruleId}`])], { cwd: root, env: remaining ? { EA_SAFETY_TAKEDOWN: "1" } : {}, timeoutMs: 1_800_000 });
}
console.log(JSON.stringify({ incidentId, contentId: item.id, locales, deletedPublicBody: deleteBody, status: "quarantined" }, null, 2));
