#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const localConfig = resolve(root, "pipeline/config/search-console.local.json");
const exampleConfig = resolve(root, "pipeline/config/search-console.example.json");
const config = JSON.parse(await readFile(localConfig, "utf8").catch(async (error) => {
  if (error.code !== "ENOENT") throw error;
  return readFile(exampleConfig, "utf8");
}));
const token = process.env.GOOGLE_SEARCH_CONSOLE_TOKEN || "";
if (!token) {
  console.log("Search Console monitoring skipped: set GOOGLE_SEARCH_CONSOLE_TOKEN locally. No credential is read from Git.");
  process.exit(0);
}

async function google(path, options = {}) {
  const response = await fetch(`https://searchconsole.googleapis.com${path}`, { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Search Console ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

if (process.argv.includes("--submit")) {
  const site = encodeURIComponent(config.siteUrl);
  const feed = encodeURIComponent(config.sitemapUrl);
  await google(`/webmasters/v3/sites/${site}/sitemaps/${feed}`, { method: "PUT" });
}

const inspections = [];
for (const inspectionUrl of config.inspectionUrls) {
  const payload = await google("/v1/urlInspection/index:inspect", { method: "POST", body: JSON.stringify({ inspectionUrl, siteUrl: config.siteUrl, languageCode: "en-US" }) });
  const result = payload.inspectionResult?.indexStatusResult || {};
  const declaredCanonical = result.userCanonical || null;
  const selectedCanonical = result.googleCanonical || null;
  inspections.push({
    url: inspectionUrl,
    verdict: result.verdict || null,
    coverageState: result.coverageState || null,
    robotsTxtState: result.robotsTxtState || null,
    indexingState: result.indexingState || null,
    lastCrawlTime: result.lastCrawlTime || null,
    declaredCanonical,
    selectedCanonical,
    canonicalMismatch: Boolean(declaredCanonical && selectedCanonical && declaredCanonical !== selectedCanonical),
    localDiagnostics: { qualityReport: "pipeline/runtime/quality/release-report.json", prepublishReport: "pipeline/runtime/prepublish-report.json" },
  });
}
const report = { generatedAt: new Date().toISOString(), siteUrl: config.siteUrl, sitemapSubmitted: process.argv.includes("--submit"), inspections, repairQueue: inspections.filter((entry) => entry.canonicalMismatch || !["PASS", "NEUTRAL"].includes(entry.verdict)) };
const date = new Date().toISOString().slice(0, 10);
const destination = resolve(root, "pipeline/runtime/search-console", `${date}.json`);
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ report: destination, inspected: inspections.length, repairQueue: report.repairQueue.length }, null, 2));
