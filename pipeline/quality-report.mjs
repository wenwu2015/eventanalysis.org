#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportRoot = resolve(root, "pipeline/runtime/quality/reports");
const files = (await readdir(reportRoot).catch(() => [])).filter((name) => name.endsWith(".json"));
const results = [];
for (const file of files) {
  const report = JSON.parse(await readFile(resolve(reportRoot, file), "utf8"));
  results.push({ contentId: file.replace(/\.json$/, ""), statuses: report.reports.map(({ locale, status }) => ({ locale, status })) });
}
console.log(JSON.stringify({ reports: results }, null, 2));
