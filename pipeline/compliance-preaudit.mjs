#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPipelineConfig } from "./lib/config.mjs";
import { legalPackHash, legalValidationDisabled, policyHash, riskClassForItem, validateAgentPreAudit } from "./lib/compliance.mjs";
import { agentReportPath, findContentItemFile, loadCompliancePolicy, loadLegalRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { withEphemeralJob } from "./lib/job-lifecycle.mjs";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const inputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const localeFlag = process.argv.find((value) => value.startsWith("--locales="));
const requestedLocales = localeFlag ? localeFlag.slice("--locales=".length).split(",").filter(Boolean) : null;
if (!inputArg && !contentFlag) throw new Error("Usage: npm run compliance:preaudit -- <content-item.json> OR --content=<id>");
let item;
if (contentFlag) {
  const found = await findContentItemFile(root, contentFlag.slice("--content=".length));
  if (!found) throw new Error(`Unknown content item: ${contentFlag}`);
  item = found.item;
} else {
  item = JSON.parse(await readFile(resolve(root, inputArg), "utf8"));
}
const [config, policy, legalRegistry, data] = await Promise.all([
  loadPipelineConfig(), loadCompliancePolicy(root), loadLegalRegistry(root), loadContentData(root),
]);
if (!config.ai.complianceReviewer?.command?.length) throw new Error("Compliance reviewer agent is not configured in pipeline/config/ai.local.json");
const facts = new Map(data.facts.map((fact) => [fact.id, fact]));
const events = new Map(data.events.map((event) => [event.id, event]));
const entities = new Map(data.entities.map((entity) => [entity.id, entity]));
const relevantFactIds = new Set((item.claims || []).flatMap((claim) => claim.factRefs || []));
const relevantEventIds = new Set(item.eventRefs || []);
const relevantEntityIds = new Set(item.entityRefs || []);
const editorialOneClickMode = requestedLocales?.length === 1 && requestedLocales[0] === "zh";
const bypassLegalValidation = legalValidationDisabled(policy);
const targetCountries = editorialOneClickMode
  ? []
  : bypassLegalValidation
    ? []
  : [...new Set((requestedLocales?.length ? requestedLocales : Object.keys(policy.localeMarkets || {})).flatMap((locale) => policy.localeMarkets?.[locale] || []))];
const applicableCountries = editorialOneClickMode
  ? []
  : bypassLegalValidation
    ? []
  : [...new Set([...targetCountries, ...(item.nexusJurisdictions || []), ...(legalRegistry.operatorJurisdictions || [])])];
const applicablePacks = editorialOneClickMode
  ? []
  : bypassLegalValidation
  ? []
  : applicableCountries.map((country) => legalRegistry.packs.find(({ jurisdiction }) => jurisdiction === country)).filter(Boolean);

function summarizePolicyForReview(policy) {
  return {
    version: policy.version,
    sourceLocale: policy.sourceLocale,
    publicationLeaseHours: policy.publicationLeaseHours,
    disableLegalPackValidation: policy.disableLegalPackValidation,
    allowSingleOfficialCoreSource: policy.allowSingleOfficialCoreSource,
    allowSingleAuthorisedCoreSource: policy.allowSingleAuthorisedCoreSource,
    automaticPublicationLocales: policy.automaticPublicationLocales,
    localeMarkets: policy.localeMarkets,
    automaticTypes: policy.automaticTypes,
    humanReviewTypes: policy.humanReviewTypes,
    highRiskCategories: policy.highRiskCategories,
  };
}

function summarizeLegalPack(pack) {
  if (!pack) return null;
  return {
    jurisdiction: pack.jurisdiction,
    reviewedAt: pack.reviewedAt || null,
    effectiveFrom: pack.effectiveFrom || null,
    effectiveThrough: pack.effectiveThrough || null,
    officialSources: pack.officialSources || [],
    counselSignature: pack.counselSignature ? "[present]" : null,
    restrictions: pack.restrictions || [],
  };
}

function summarizeFact(fact) {
  return {
    id: fact.id,
    subjectId: fact.subjectId,
    predicate: fact.predicate,
    value: fact.value,
    status: fact.status,
  };
}

function summarizeEntity(entity) {
  return {
    id: entity.id,
    kind: entity.kind,
    sport: entity.sport,
    names: entity.names || {},
    aliases: entity.aliases || [],
    attributes: entity.attributes || {},
  };
}

function summarizeEvent(event) {
  return {
    id: event.id,
    kind: event.kind,
    sport: event.sport,
    competitionName: event.competitionName || null,
    startedAt: event.startedAt || null,
    status: event.status || null,
    homeTeamId: event.homeTeamId || null,
    awayTeamId: event.awayTeamId || null,
    homeScore: event.homeScore ?? null,
    awayScore: event.awayScore ?? null,
  };
}

await withEphemeralJob({ root, articleId: `compliance-${item.id}`, diskLimitBytes: config.policy.jobDiskLimitBytes }, async (job) => {
  const promptPath = resolve(job.jobDir, "compliance-input.json");
  const outputPath = resolve(job.jobDir, "compliance-output.json");
  const now = new Date();
  const leaseDeadline = new Date(now.getTime() + Number(policy.publicationLeaseHours || 24) * 3_600_000).toISOString();
  const prompt = {
    schemaVersion: 1,
    objective: "Independently review one content revision for factual support, civil language, translation fidelity and every applicable jurisdiction. Return findings only; do not edit, publish or upload content.",
    expected: {
      contentId: item.id,
      revision: item.revision,
      sourceEditionHash: item.sourceEditionHash,
      policyHash: policyHash(policy),
      riskClass: riskClassForItem(item),
      legalPackHashes: applicablePacks.map(legalPackHash),
      expiresWithinHours: policy.publicationLeaseHours,
      expiresAtNotAfter: leaseDeadline,
    },
    decisionRules: [
      "Use overall PASS only when the facts, claims, language and translations are safe. A target-market jurisdiction may still be BLOCK while other countries pass.",
      editorialOneClickMode
        ? "This review run is for Chinese one-click editorial flow only. Ignore legal-pack completeness, jurisdiction coverage, and counsel-material collection."
        : bypassLegalValidation
          ? "This review run ignores legal-pack completeness and jurisdiction coverage. Review only factual support, civility and translation fidelity."
        : "Use overall BLOCK when any content-nexus jurisdiction is missing or blocked; a nexus failure cannot be limited to one market.",
      "Referenced structured entities are authoritative evidence for mapped team, competition and person names when those names appear in the item.",
      "Referenced structured events are authoritative evidence for competition name, kickoff time, participating teams and final score. A localized restatement of those event fields is allowed when it does not add unsupported facts.",
      "Use REVIEW for a high-risk but not prohibited topic that requires an editor or counsel.",
      "Use BLOCK for uncertainty, guessing, insult, national or ethnic attack, health speculation, unsupported allegation, translation drift, missing legal coverage or missing evidence.",
      "Do not infer intent, mental state, character, future performance, injury, crime, corruption, doping, betting or match fixing.",
      "Set expiresAt to an ISO timestamp after the current review time and no later than expected.expiresAtNotAfter.",
    ],
    policy: summarizePolicyForReview(policy),
    legalPacks: applicablePacks.map(summarizeLegalPack).filter(Boolean),
    missingLegalPacks: editorialOneClickMode || bypassLegalValidation ? [] : applicableCountries.filter((country) => !applicablePacks.some((pack) => pack.jurisdiction === country)),
    entities: [...relevantEntityIds].map((id) => entities.get(id)).filter(Boolean).map(summarizeEntity),
    events: [...relevantEventIds].map((id) => events.get(id)).filter(Boolean).map(summarizeEvent),
    facts: [...relevantFactIds].map((id) => facts.get(id)).filter(Boolean).map(summarizeFact),
    claims: item.claims,
    sourceEdition: item.editions.zh,
    derivedEditions: Object.fromEntries(Object.entries(item.editions || {}).filter(([locale]) => locale !== "zh")),
  };
  await writeFile(promptPath, `${JSON.stringify(prompt, null, 2)}\n`, { mode: 0o600 });
  await runCommand(config.ai.complianceReviewer.command, { cwd: root, timeoutMs: config.ai.complianceReviewer.timeoutMs, env: { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath } });
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  if (editorialOneClickMode || bypassLegalValidation) {
    report.jurisdictionDecisions = [];
    report.legalPackHashes = [];
  }
  for (const key of ["jurisdictionDecisions", "factFindings", "civilityFindings", "translationFindings", "prohibitedClaimFindings"]) if (!Array.isArray(report[key])) throw new Error(`AgentPreAudit is missing ${key}`);
  const validation = validateAgentPreAudit(report, {
    item,
    policy,
    legalPacks: applicablePacks,
    expectedJurisdictions: editorialOneClickMode || bypassLegalValidation ? [] : applicableCountries,
  });
  if (!validation.ok) throw new Error(`AgentPreAudit is invalid: ${validation.findings.join(", ")}`);
  await writePrivateJson(agentReportPath(root, item), report);
  console.log(JSON.stringify({ contentId: item.id, revision: item.revision, decision: report.decision, riskClass: report.riskClass, report: agentReportPath(root, item) }, null, 2));
});
