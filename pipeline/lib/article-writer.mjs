import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./command-runner.mjs";
import { normalizeSlug } from "./data-store.mjs";
import { prepareChineseMaster } from "./compliance.mjs";
import { materializeFactBundle, persistMaterializedBundle } from "./fact-materializer.mjs";

const forbiddenPublicPatterns = [
  /https?:\/\//i,
  /sofascore|sportradar|genius sports|statsbomb|wyscout|opta|transfermarkt|skillcorner/i,
  /<\/?(?:img|picture|video|iframe|canvas)\b/i,
];

const causalReplacements = [
  [/追平球是([^。；]+?)后的结果/gu, "追平球出现在$1之后"],
  [/把持续压力转化为/gu, "在持续压力的背景下形成"],
  [/把压力转化为/gu, "在压力持续的背景下形成"],
  [/导致/gu, "伴随着"],
  [/因此/gu, "在此背景下"],
];

const genericPrimaryIntentKeys = new Set([
  "post_match_analysis",
  "post_match_key_moments",
]);

function softenUnsupportedCausality(text) {
  let output = String(text || "");
  for (const [pattern, replacement] of causalReplacements) output = output.replace(pattern, replacement);
  return output;
}

function supportTokens(value) {
  return [...String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+/gu)]
    .map(([token]) => token)
    .filter((token) => token.length >= 2);
}

function timelineClaimsForEntry(item, entry) {
  const labelTokens = new Set(supportTokens(`${entry.minute || ""} ${entry.label || ""}`));
  if (!labelTokens.size) return [];
  const claimsById = new Map((item.claims || []).map((claim) => [claim.id, claim]));
  const scored = (item.claims || []).map((claim) => {
    const claimTokens = new Set(supportTokens(`${claim.summary || ""} ${(claim.factRefs || []).join(" ")}`));
    const overlap = [...labelTokens].filter((token) => claimTokens.has(token)).length;
    return { claim, overlap };
  }).filter(({ overlap }) => overlap > 0);
  const current = (entry.claimRefs || [])
    .map((id) => claimsById.get(id))
    .filter(Boolean)
    .map((claim) => ({ claim, overlap: scored.find((candidate) => candidate.claim.id === claim.id)?.overlap || 0 }))
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) => right.overlap - left.overlap)
    .map(({ claim }) => claim.id);
  if (current.length) return [...new Set(current)];
  return scored
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, 2)
    .map(({ claim }) => claim.id);
}

export function normalizeReviewDraft(item) {
  for (const claim of item.claims || []) {
    if (claim.kind === "analysis") claim.summary = softenUnsupportedCausality(claim.summary);
  }
  for (const edition of Object.values(item.editions || {})) {
    edition.title = softenUnsupportedCausality(edition.title);
    edition.deck = softenUnsupportedCausality(edition.deck);
    for (const section of edition.sections || []) {
      section.title = softenUnsupportedCausality(section.title);
      for (const paragraph of section.paragraphs || []) paragraph.text = softenUnsupportedCausality(paragraph.text);
    }
    const normalizedTimeline = [];
    for (const entry of edition.timeline || []) {
      const claimRefs = timelineClaimsForEntry(item, entry);
      if (!claimRefs.length) continue;
      normalizedTimeline.push({
        ...entry,
        label: softenUnsupportedCausality(entry.label),
        claimRefs,
      });
    }
    edition.timeline = normalizedTimeline;
  }
  return item;
}

export function assertDraftShape(item, structured) {
  if (!item.id || !item.type || !item.sport || !item.angleKey || !item.originalContribution) throw new Error("Structured draft identity fields are incomplete");
  if (!Array.isArray(item.claims) || !item.claims.length) throw new Error("Structured draft requires evidence-backed claims");
  if (!item.editions?.zh) throw new Error("Structured draft has no Chinese source edition");
  if (Object.keys(item.editions).some((locale) => locale !== "zh")) throw new Error("The writer may only create the Chinese source edition");
  if (JSON.stringify([...(item.eventRefs || [])].sort()) !== JSON.stringify([...structured.references.eventRefs].sort())) throw new Error("Draft eventRefs differ from the structured event");
  if (JSON.stringify([...(item.entityRefs || [])].sort()) !== JSON.stringify([...structured.references.entityRefs].sort())) throw new Error("Draft entityRefs differ from the structured teams");
  const allowedFacts = new Set([...structured.references.requiredFactRefs, ...structured.references.optionalFactRefs]);
  for (const claim of item.claims) if (!claim.factRefs?.length || claim.factRefs.some((id) => !allowedFacts.has(id))) throw new Error(`Claim ${claim.id} references an unknown or missing Fact`);
  for (const [locale, edition] of Object.entries(item.editions)) {
    if (!edition.title || !edition.deck || !edition.slug || !edition.sections?.length) throw new Error(`Edition ${locale} is incomplete`);
    if (normalizeSlug(edition.slug) !== edition.slug) throw new Error(`Edition ${locale} slug is not canonical`);
    edition.status = "needs_review";
    edition.complianceStatus = "unreviewed";
  }
  const eventScope = [...new Set(structured.references.eventRefs || item.eventRefs || [])].sort();
  const needsEventScopedMomentIntent = item.type === "moment_analysis"
    && !String(item.primaryIntentKey || "").startsWith("moment-analysis-event-");
  if (!item.primaryIntentKey || genericPrimaryIntentKeys.has(item.primaryIntentKey) || needsEventScopedMomentIntent) {
    if (!eventScope.length) throw new Error("Structured draft has no event scope for primary intent");
    item.primaryIntentKey = normalizeSlug([item.type, ...eventScope].join("-"));
  }
  prepareChineseMaster(item);
  const publicCopy = JSON.stringify(item.editions);
  for (const pattern of forbiddenPublicPatterns) if (pattern.test(publicCopy)) throw new Error(`Public draft failed disclosure/media policy: ${pattern}`);
}

function writingPrompt(facts, structured, { draftType = "match_analysis" } = {}) {
  return {
    objective: draftType === "moment_analysis"
      ? "Create a structured post-match football moments analysis edition for editorial review."
      : "Create structured post-match football analysis editions for editorial review.",
    schemaVersion: 3,
    sourceLocale: "zh",
    requestedDraft: {
      type: draftType,
    },
    requirements: [
      "Return one ContentItem JSON object with stable entityRefs, eventRefs, Claim objects and exactly one Chinese Edition at editions.zh.",
      `Set type to ${draftType} and keep the angle specific to that draft type.`,
      "Use supplied deterministic scores, head-to-head calculations and evidence references without inventing missing values.",
      "Separate fact, calculation and analysis claims; every paragraph must reference one or more claims.",
      "State a specific reader question, angleKey and originalContribution before drafting.",
      "Do not mention sources, URLs, production tools, videos, screenshots or private evidence in editions.",
      "Do not create any non-Chinese edition. Translation is a later, separately audited workflow.",
      "Never use an English placeholder for a missing language edition.",
      "Set every edition to needs_review. Publication is an editorial action outside this task.",
      draftType === "moment_analysis"
        ? "For moment_analysis, stay narrow: write only deterministic key events, score progression, confirmed calculations and limited mechanism descriptions supported by the evidence."
        : "For match_analysis, explain the result through confirmed facts, deterministic calculations and limited evidence-backed mechanism analysis.",
    ],
    facts,
    structured,
  };
}

export async function createReviewArtifact({ facts, aiConfig, job, root, requestedLocales, draftType = "match_analysis", contentId = null }) {
  const reviewRoot = resolve(root, "content/review-packets");
  await mkdir(reviewRoot, { recursive: true });
  const outputId = contentId || facts.id;
  if (facts.status === "data_incomplete") {
    const path = resolve(reviewRoot, `${outputId}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true }, null, 2)}\n`);
    return { kind: "blocked", path };
  }
  if (!aiConfig.writer.command?.length) {
    const path = resolve(reviewRoot, `${outputId}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true, missing: [...facts.missing, "writer_configuration"] }, null, 2)}\n`);
    return { kind: "blocked", path };
  }
  const structured = materializeFactBundle(facts);
  await job.flushRetainedArtifacts?.();
  await persistMaterializedBundle(root, structured);
  const promptPath = resolve(job.jobDir, "writer-prompt.json");
  const outputPath = resolve(job.jobDir, "writer-output.json");
  await writeFile(promptPath, `${JSON.stringify(writingPrompt(facts, structured, { draftType }), null, 2)}\n`, { mode: 0o600 });
  await runCommand(aiConfig.writer.command, { cwd: root, timeoutMs: aiConfig.writer.timeoutMs, env: { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath } });
  const item = JSON.parse(await readFile(outputPath, "utf8"));
  if (outputId) item.id = outputId;
  item.type = draftType;
  item.schemaVersion = 3;
  item.revision ||= 1;
  item.eventRefs = [...structured.references.eventRefs];
  item.entityRefs = [...structured.references.entityRefs];
  item.nexusJurisdictions = [...new Set(structured.entities.map((entity) => entity.attributes?.jurisdiction).filter(Boolean))].sort();
  if (Array.isArray(facts.focusPeople) && facts.focusPeople.length) item.focusPeople = facts.focusPeople;
  normalizeReviewDraft(item);
  assertDraftShape(item, structured);
  const path = resolve(reviewRoot, `${item.id}.json`);
  await writeFile(path, `${JSON.stringify(item, null, 2)}\n`);
  return { kind: "draft", path };
}
