#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sourceEditionHash } from "./lib/compliance.mjs";
import { findContentItemFile } from "./lib/compliance-store.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const contentFilter = process.argv.find((value) => value.startsWith("--content="))?.slice("--content=".length);
const localeFilter = process.argv.find((value) => value.startsWith("--locales="))?.slice("--locales=".length).split(",").map((value) => value.trim()).filter(Boolean);
const locales = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8")).map(({ code }) => code);
const targetLocales = (localeFilter?.length ? localeFilter : locales).filter((code) => code !== "zh");
const TRANSLATION_BATCH_SIZE = 1;

function chunk(values = [], size = 1) {
  const items = Array.isArray(values) ? values : [];
  const width = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let index = 0; index < items.length; index += width) batches.push(items.slice(index, index + width));
  return batches;
}

const data = await loadContentData(root);
const candidates = data.items
  .filter((item) => !contentFilter || item.id === contentFilter)
  .filter((item) => ["approved", "published"].includes(item.editions?.zh?.status));

if (contentFilter && !candidates.length) throw new Error(`No approved or published Chinese edition found for ${contentFilter}`);

const prepared = [];
for (const candidate of candidates) {
  const currentHash = sourceEditionHash(candidate.editions.zh);
  const missingOrStale = targetLocales.filter((locale) => {
    const edition = candidate.editions?.[locale];
    return !edition || edition.translationStatus !== "current" || edition.derivedFromHash !== currentHash;
  });
  if (missingOrStale.length) {
    for (const batch of chunk(missingOrStale, TRANSLATION_BATCH_SIZE)) {
      await runCommand(["npm", "run", "content:translate", "--", `--content=${candidate.id}`, `--locales=${batch.join(",")}`], {
        cwd: root,
        timeoutMs: 1_800_000,
      });
    }
  }
  await runCommand(["npm", "run", "publish:automatic", "--", `--content=${candidate.id}`, `--locales=zh,${targetLocales.join(",")}`], { cwd: root, timeoutMs: 1_800_000 });
  const found = await findContentItemFile(root, candidate.id);
  if (!found) throw new Error(`Content item disappeared during release preparation: ${candidate.id}`);
  const item = found.item;
  const now = new Date().toISOString();
  item.publishedAt ||= now;
  item.reviewedAt ||= now;
  let publishedLocales = 0;
  for (const edition of Object.values(item.editions || {})) {
    if (edition.status !== "approved" || edition.complianceStatus !== "passed") continue;
    edition.status = "published";
    edition.slugFrozenAt ||= now;
    publishedLocales += 1;
  }
  if (!publishedLocales) throw new Error(`No approved locale can be promoted for production: ${item.id}`);
  found.records[found.index] = item;
  await writeFile(found.path, `${JSON.stringify(found.wrapper ? found.packet : item, null, 2)}\n`);
  prepared.push({ contentId: item.id, translatedLocales: missingOrStale, publishedLocales });
}

console.log(JSON.stringify({ status: "release_locales_prepared", candidates: candidates.length, prepared }, null, 2));
