#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { validateContentData } from "./lib/data-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const position = process.argv.indexOf("--content");
const contentId = position === -1 ? "" : process.argv[position + 1];
if (!contentId) throw new Error("Usage: npm run data:audit -- --content <id>");

const data = await validateContentData(root, { requirePrivateEvidence: true });
const item = data.items.find(({ id }) => id === contentId);
if (!item) throw new Error(`Unknown content item: ${contentId}`);
const facts = new Map(data.facts.map((fact) => [fact.id, fact]));
const packets = [];
for (const filename of (await readdir(resolve(root, "private-evidence"))).filter((name) => name.endsWith(".json"))) {
  const packet = JSON.parse(await readFile(resolve(root, "private-evidence", filename), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{\"records\":[]}";
    throw error;
  }));
  packets.push(...(packet.records || []));
}
const evidence = new Map(packets.map((record) => [record.id, record]));
const claimAudit = item.claims.map((claim) => ({
  claimId: claim.id,
  kind: claim.kind,
  facts: (claim.factRefs || []).map((id) => ({
    factId: id,
    predicate: facts.get(id)?.predicate,
    evidence: (facts.get(id)?.evidenceRefs || []).map((ref) => ({
      evidenceId: ref,
      sourceId: evidence.get(ref)?.sourceId,
      capturedAt: evidence.get(ref)?.capturedAt,
      parserVersion: evidence.get(ref)?.parserVersion,
    })),
  })),
}));
console.log(JSON.stringify({ contentId, revision: item.revision, statusByLocale: Object.fromEntries(Object.entries(item.editions || {}).map(([locale, edition]) => [locale, edition.status])), claims: claimAudit }, null, 2));
