#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const base = process.argv.find((value) => value.startsWith("--base="))?.slice(7) || "https://eventanalysis.org";
const store = JSON.parse(await readFile(resolve(root, "pipeline/runtime/compliance/edge-store.json"), "utf8"));
if (store.publicationMode !== "frozen") throw new Error(`Edge manifest is ${store.publicationMode}, not frozen`);

const checks = [
  ["/en/football/", 200],
  ["/zh/football/legal/", 200],
  ["/en/football/match-analysis/spain-england-euro-2024-final/", 410],
  ["/en/articles/spain-england-euro-2024-final/", 410],
];
const failures = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  for (const [path, expected] of checks) {
    const response = await fetch(`${base}${path}`, { redirect: "manual", headers: { "cache-control": "no-cache" } });
    if (response.status !== expected) failures.push({ attempt, path, expected, actual: response.status });
  }
}
const report = { checkedAt: new Date().toISOString(), attempts: 3, base, status: failures.length ? "BLOCK" : "PASS", failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
