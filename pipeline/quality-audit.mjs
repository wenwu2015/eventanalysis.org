#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { validateContentData } from "./lib/data-store.mjs";
import { auditEdition, buildCorpus } from "./lib/quality.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const position = process.argv.indexOf("--content");
const contentId = position === -1 ? "" : process.argv[position + 1];
if (!contentId) throw new Error("Usage: npm run quality:audit -- --content <id>");
const policy = JSON.parse(await readFile(resolve(root, "pipeline/config/quality-policy.json"), "utf8"));
const data = await validateContentData(root, { requirePrivateEvidence: true });
const item = data.items.find(({ id }) => id === contentId);
if (!item) throw new Error(`Unknown content item: ${contentId}`);
const sourcePackets = await readdir(resolve(root, "private-evidence"), { withFileTypes: true }).catch(() => []);
const sources = [];
for (const entry of sourcePackets) if (entry.isFile() && entry.name.endsWith(".json")) {
  const packet = JSON.parse(await readFile(resolve(root, "private-evidence", entry.name), "utf8"));
  for (const record of packet.records || []) sources.push({ sourceId: record.sourceId, text: record.excerpt || "" });
}
const corpus = buildCorpus(data);
const reports = Object.entries(item.editions || {}).filter(([, edition]) => ["approved", "published"].includes(edition.status)).map(([locale, edition]) => auditEdition({ item, locale, edition, corpus, sources, policy }));
const destination = resolve(root, "pipeline/runtime/quality/reports", `${contentId}.json`);
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ contentId, result: reports.some(({ status }) => status === "BLOCK") ? "BLOCK" : reports.some(({ status }) => status === "REVIEW") ? "REVIEW" : "PASS", reports }, null, 2));
if (reports.some(({ status }) => status !== "PASS")) process.exitCode = 1;
