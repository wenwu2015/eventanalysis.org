#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPipelineConfig } from "./lib/config.mjs";
import { runCommand } from "./lib/command-runner.mjs";
import { prepareChineseMaster, prepareDerivedEdition, scanProhibitedLanguage, validateTranslation } from "./lib/compliance.mjs";
import { normalizeSlug } from "./lib/data-store.mjs";
import { findContentItemFile } from "./lib/compliance-store.mjs";
import { withEphemeralJob } from "./lib/job-lifecycle.mjs";

const root = resolve(import.meta.dirname, "..");
const inputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const localeArg = process.argv.find((value) => value.startsWith("--locales="));
if (!inputArg && !contentFlag) throw new Error("Usage: npm run content:translate -- <content-item.json> OR --content=<id> [--locales=en,ja,...]");
let item;
let inputPath;
let existing;
if (contentFlag) {
  existing = await findContentItemFile(root, contentFlag.slice("--content=".length));
  if (!existing) throw new Error(`Unknown content item: ${contentFlag}`);
  item = existing.item;
  inputPath = existing.path;
} else {
  inputPath = resolve(root, inputArg);
  item = JSON.parse(await readFile(inputPath, "utf8"));
}
const config = await loadPipelineConfig();
if (!config.ai.translator?.command?.length) throw new Error("Translation agent is not configured in pipeline/config/ai.local.json");
const localeDefinitions = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
const supported = new Set(localeDefinitions.map(({ code }) => code));
const requested = localeArg ? localeArg.slice("--locales=".length).split(",").filter(Boolean) : localeDefinitions.map(({ code }) => code).filter((code) => code !== "zh");
for (const locale of requested) if (locale === "zh" || !supported.has(locale)) throw new Error(`Unsupported translation locale: ${locale}`);
prepareChineseMaster(item);

await withEphemeralJob({ root, articleId: `translate-${item.id}`, diskLimitBytes: config.policy.jobDiskLimitBytes }, async (job) => {
  const promptPath = resolve(job.jobDir, "translation-input.json");
  const outputPath = resolve(job.jobDir, "translation-output.json");
  const prompt = {
    schemaVersion: 1,
    objective: "Derive localized editions from the approved Chinese source without adding or removing facts, claims, numbers or judgments.",
    contentId: item.id,
    sourceRevision: item.sourceRevision,
    sourceEditionHash: item.sourceEditionHash,
    requestedLocales: requested,
    requirements: [
      "Return an object whose editions property is an array with exactly one {locale, edition} entry for every requested locale.",
      "Keep section ids, paragraph order and every paragraph claimRefs identical to the Chinese source.",
      "Localize title, deck, section titles, slug and prose naturally; never use an English placeholder.",
      "Do not add predictions, mental-state claims, insults, allegations, health speculation or national stereotypes.",
      "Preserve every number and limiting phrase from the Chinese source.",
    ],
    claims: item.claims,
    sourceEdition: item.editions.zh,
  };
  await writeFile(promptPath, `${JSON.stringify(prompt, null, 2)}\n`, { mode: 0o600 });
  await runCommand(config.ai.translator.command, { cwd: root, timeoutMs: config.ai.translator.timeoutMs, env: { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath } });
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  if (!Array.isArray(output.editions)) throw new Error("Translation agent returned an invalid editions array");
  const returnedEditions = Object.fromEntries(output.editions.map(({ locale, edition }) => [locale, edition]));
  if (output.editions.length !== requested.length || Object.keys(returnedEditions).sort().join(",") !== [...requested].sort().join(",")) throw new Error("Translation agent returned the wrong locale set");
  for (const locale of requested) {
    const edition = returnedEditions[locale];
    if (!edition?.title || !edition?.deck || !edition?.slug || !edition?.sections?.length) throw new Error(`Translation ${locale} is incomplete`);
    edition.slug = normalizeSlug(edition.slug);
    edition.status = "needs_review";
    edition.complianceStatus = "unreviewed";
    item.editions[locale] = edition;
    prepareDerivedEdition(item, locale, { current: true, agentVersion: output.agentVersion || "configured-translator" });
    const findings = validateTranslation(item, locale);
    if (findings.length) throw new Error(`Translation ${locale} failed source consistency: ${JSON.stringify(findings)}`);
    const prohibited = scanProhibitedLanguage(edition).filter(({ severity }) => severity === "C");
    if (prohibited.length) throw new Error(`Translation ${locale} contains prohibited language: ${JSON.stringify(prohibited)}`);
  }
});

if (existing) {
  existing.records[existing.index] = item;
  await writeFile(inputPath, `${JSON.stringify(existing.wrapper ? existing.packet : item, null, 2)}\n`, { mode: 0o600 });
} else {
  await writeFile(inputPath, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ contentId: item.id, sourceRevision: item.sourceRevision, translatedLocales: requested, status: "needs_review" }, null, 2));
