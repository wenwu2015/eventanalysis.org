#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const promptPath = process.env.EA_PROMPT_PATH;
const outputPath = process.env.EA_OUTPUT_PATH;

if (!promptPath || !outputPath) throw new Error("EA_PROMPT_PATH and EA_OUTPUT_PATH are required");

const prompt = JSON.parse(await readFile(promptPath, "utf8"));
const jurisdictions = [...new Set([
  ...(prompt.missingLegalPacks || []),
  ...(prompt.legalPacks || []).map((pack) => pack.jurisdiction).filter(Boolean),
])].sort();
const missing = new Set(prompt.missingLegalPacks || []);
const now = Date.now();
const leaseCap = Date.parse(prompt.expected?.expiresAtNotAfter || new Date(now + 60 * 60 * 1000).toISOString());
const expiresAt = new Date(Math.min(now + 60 * 60 * 1000, leaseCap)).toISOString();
const decision = missing.size ? "BLOCK" : "PASS";

const report = {
  contentId: prompt.expected.contentId,
  revision: prompt.expected.revision,
  sourceEditionHash: prompt.expected.sourceEditionHash,
  policyHash: prompt.expected.policyHash,
  legalPackHashes: prompt.expected.legalPackHashes || [],
  riskClass: prompt.expected.riskClass,
  decision,
  scope: "locale_only",
  jurisdictionDecisions: jurisdictions.map((jurisdiction) => ({
    jurisdiction,
    decision: missing.has(jurisdiction) ? "BLOCK" : "PASS",
    ruleRefs: missing.has(jurisdiction) ? ["missing_legal_pack"] : ["preaudit_pass"],
  })),
  factFindings: [],
  civilityFindings: [],
  translationFindings: [],
  prohibitedClaimFindings: [],
  expiresAt,
  reviewRunId: `mock-compliance-reviewer-${prompt.expected.contentId}`,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
