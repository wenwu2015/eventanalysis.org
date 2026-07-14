#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run content:publish -- content/review-packets/<article>.json");
const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, input);
if (!inputPath.startsWith(resolve(root, "content/review-packets") + "/")) {
  throw new Error("Only review packets inside content/review-packets may be promoted");
}
const article = JSON.parse(await readFile(inputPath, "utf8"));
if (article.status !== "approved") throw new Error("A human reviewer must set status to approved before promotion");
const locales = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
const missingLocales = locales.map(({ code }) => code).filter((locale) => !article.translations?.[locale]);
if (missingLocales.length) throw new Error(`All required language versions must be approved. Missing: ${missingLocales.join(", ")}`);
const sports = JSON.parse(await readFile(resolve(root, "content/sports.json"), "utf8"));
const sport = sports.find(({ code }) => code === article.sport);
if (!sport || sport.status !== "active") throw new Error(`Sport is not enabled for publication: ${article.sport || "missing"}`);
article.status = "published";
article.publishedAt ||= new Date().toISOString();
article.reviewedAt = new Date().toISOString();

const manifestPath = resolve(root, "content/articles.generated.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.some((entry) => entry.id === article.id || entry.slug === article.slug)) {
  throw new Error("An article with this id or slug is already published");
}
manifest.push(article);
manifest.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await rm(inputPath);
console.log(`Promoted ${article.id}. Run npm run build and commit the generated public feeds in the review PR.`);
