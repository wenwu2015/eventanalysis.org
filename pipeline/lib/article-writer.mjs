import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./command-runner.mjs";
import { normalizeSlug } from "./data-store.mjs";

const forbiddenPublicPatterns = [
  /https?:\/\//i,
  /sofascore|sportradar|genius sports|statsbomb|wyscout|opta|transfermarkt|skillcorner/i,
  /<\/?(?:img|picture|video|iframe|canvas)\b/i,
];

function assertDraftShape(item) {
  if (!item.id || !item.type || !item.sport || !item.primaryIntentKey || !item.angleKey || !item.originalContribution) throw new Error("Structured draft identity fields are incomplete");
  if (!Array.isArray(item.claims) || !item.claims.length) throw new Error("Structured draft requires evidence-backed claims");
  if (!item.editions || !Object.keys(item.editions).length) throw new Error("Structured draft has no language editions");
  for (const [locale, edition] of Object.entries(item.editions)) {
    if (!edition.title || !edition.deck || !edition.slug || !edition.sections?.length) throw new Error(`Edition ${locale} is incomplete`);
    if (normalizeSlug(edition.slug) !== edition.slug) throw new Error(`Edition ${locale} slug is not canonical`);
    edition.status = "needs_review";
  }
  const publicCopy = JSON.stringify(item.editions);
  for (const pattern of forbiddenPublicPatterns) if (pattern.test(publicCopy)) throw new Error(`Public draft failed disclosure/media policy: ${pattern}`);
}

function writingPrompt(facts, requestedLocales) {
  return {
    objective: "Create structured post-match football analysis editions for editorial review.",
    schemaVersion: 2,
    requestedLocales,
    requirements: [
      "Return one ContentItem JSON object with stable entityRefs, eventRefs, Claim objects and independent Edition objects.",
      "Use supplied deterministic scores, head-to-head calculations and evidence references without inventing missing values.",
      "Separate fact, calculation and analysis claims; every paragraph must reference one or more claims.",
      "State a specific reader question, angleKey and originalContribution before drafting.",
      "Do not mention sources, URLs, production tools, videos, screenshots or private evidence in editions.",
      "Each requested locale needs its own title, deck, section labels, slug and prose. Never use an English placeholder.",
      "Set every edition to needs_review. Publication is an editorial action outside this task.",
    ],
    facts,
  };
}

export async function createReviewArtifact({ facts, aiConfig, job, root, requestedLocales }) {
  const reviewRoot = resolve(root, "content/review-packets");
  await mkdir(reviewRoot, { recursive: true });
  const locales = requestedLocales || JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8")).map(({ code }) => code);
  if (facts.status === "data_incomplete") {
    const path = resolve(reviewRoot, `${facts.id}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true }, null, 2)}\n`);
    return { kind: "blocked", path };
  }
  if (!aiConfig.writer.command?.length) {
    const path = resolve(reviewRoot, `${facts.id}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true, missing: [...facts.missing, "writer_configuration"] }, null, 2)}\n`);
    return { kind: "blocked", path };
  }
  const promptPath = resolve(job.jobDir, "writer-prompt.json");
  const outputPath = resolve(job.jobDir, "writer-output.json");
  await writeFile(promptPath, `${JSON.stringify(writingPrompt(facts, locales), null, 2)}\n`, { mode: 0o600 });
  await runCommand(aiConfig.writer.command, { cwd: root, timeoutMs: aiConfig.writer.timeoutMs, env: { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath } });
  const item = JSON.parse(await readFile(outputPath, "utf8"));
  item.schemaVersion = 2;
  item.revision ||= 1;
  assertDraftShape(item);
  const path = resolve(reviewRoot, `${item.id}.json`);
  await writeFile(path, `${JSON.stringify(item, null, 2)}\n`);
  return { kind: "draft", path };
}
