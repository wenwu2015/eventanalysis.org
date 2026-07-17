#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadCompliancePolicy, loadLegalRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { targetJurisdictions, validateLegalPack } from "./lib/compliance.mjs";

const root = resolve(import.meta.dirname, "..");
const [policy, registry] = await Promise.all([loadCompliancePolicy(root), loadLegalRegistry(root)]);
const findings = [];
const packs = new Map((registry.packs || []).map((pack) => [pack.jurisdiction, pack]));
const required = [...new Set([...targetJurisdictions(policy), ...(registry.operatorJurisdictions || [])])].sort();
for (const jurisdiction of required) {
  const pack = packs.get(jurisdiction);
  const validation = validateLegalPack(pack, policy);
  if (!validation.ok) {
    findings.push({ jurisdiction, code: "legal_pack_invalid", reasons: validation.findings });
    continue;
  }
  for (const source of pack.officialSources) {
    try {
      const response = await fetch(source.url, { headers: { "user-agent": "EventAnalysis-LegalPack-Monitor/1.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) findings.push({ jurisdiction, code: "official_source_http_error", status: response.status, urlHash: createHash("sha256").update(source.url).digest("hex") });
      else {
        const hash = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
        if (hash !== source.contentHash) findings.push({ jurisdiction, code: "official_source_hash_changed", expectedHash: source.contentHash, actualHash: hash, urlHash: createHash("sha256").update(source.url).digest("hex") });
      }
    } catch (error) {
      findings.push({ jurisdiction, code: "official_source_unreachable", errorCode: error.name || "fetch_failed", urlHash: createHash("sha256").update(source.url).digest("hex") });
    }
  }
}
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), requiredJurisdictions: required, status: findings.length ? "BLOCK" : "PASS", findings };
await writePrivateJson(resolve(root, "private-compliance/legal-source-checks", `${report.checkedAt.slice(0, 10)}.json`), report);
console.log(JSON.stringify({ checkedAt: report.checkedAt, required: required.length, status: report.status, findings: findings.length }, null, 2));
if (findings.length) process.exitCode = 1;
