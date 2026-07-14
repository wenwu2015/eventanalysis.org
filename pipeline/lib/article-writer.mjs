import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./command-runner.mjs";

const forbiddenPublicPatterns = [
  /https?:\/\//i,
  /sofascore|sportradar|genius sports|statsbomb|wyscout|opta|transfermarkt|skillcorner/i,
  /<\/?(?:img|picture|video|iframe|canvas)\b/i,
];

function assertPublicDraftSafe(article) {
  const publicCopy = JSON.stringify(article.translations || {});
  for (const pattern of forbiddenPublicPatterns) {
    if (pattern.test(publicCopy)) throw new Error(`Public draft failed disclosure/media policy: ${pattern}`);
  }
  const requiredLocales = article.requiredLocales;
  if (!Array.isArray(requiredLocales) || requiredLocales.length === 0) throw new Error("requiredLocales must be present on AI drafts");
  const missingLocales = requiredLocales.filter((locale) => !article.translations?.[locale]);
  if (missingLocales.length) throw new Error(`Missing required translations: ${missingLocales.join(", ")}`);
  if (!article.slug || !article.id) throw new Error("Article id and slug are required");
  if (!Number.isFinite(article.match?.homeScore) || !Number.isFinite(article.match?.awayScore)) throw new Error("Deterministic final score is required");
}

function writingPrompt(facts, requiredLocales) {
  return {
    objective: "Write one multilingual post-match football analysis for EventAnalysis.org.",
    requiredLocales,
    requirements: [
      "Use the exact shared facts and deterministic numbers supplied.",
      "Explain prior meetings, personnel changes, the final result and why it happened.",
      "Keep fact and analysis visibly distinct.",
      "Do not mention providers, URLs, videos, screenshots or private evidence.",
      "Return JSON only, matching the existing Article structure in lib/content.ts.",
      "Use one shared fact object and preserve every number exactly across all language editions.",
      "Do not publish an English placeholder when a requested translation is missing.",
      "Set status to needs_review. Never set published or approved.",
    ],
    facts,
  };
}

export async function createReviewArtifact({ facts, aiConfig, job, root }) {
  const reviewRoot = resolve(root, "content/review-packets");
  await mkdir(reviewRoot, { recursive: true });
  if (facts.status === "data_incomplete") {
    const path = resolve(reviewRoot, `${facts.id}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true }, null, 2)}\n`);
    return { kind: "blocked", path };
  }
  if (!aiConfig.writer.command?.length) {
    const path = resolve(reviewRoot, `${facts.id}.json`);
    await writeFile(path, `${JSON.stringify({ ...facts, publicationBlocked: true, missing: [...facts.missing, "ai_writer_configuration"] }, null, 2)}\n`);
    return { kind: "blocked", path };
  }

  const locales = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
  const requiredLocales = locales.map(({ code }) => code);
  const promptPath = resolve(job.jobDir, "writer-prompt.json");
  const outputPath = resolve(job.jobDir, "writer-output.json");
  await writeFile(promptPath, `${JSON.stringify(writingPrompt(facts, requiredLocales), null, 2)}\n`, { mode: 0o600 });
  await runCommand(aiConfig.writer.command, {
    cwd: root,
    timeoutMs: aiConfig.writer.timeoutMs,
    env: { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath },
  });
  const article = JSON.parse(await readFile(outputPath, "utf8"));
  article.requiredLocales = requiredLocales;
  assertPublicDraftSafe(article);
  article.status = "needs_review";
  const path = resolve(reviewRoot, `${article.id}.json`);
  await writeFile(path, `${JSON.stringify(article, null, 2)}\n`);
  return { kind: "draft", path };
}
