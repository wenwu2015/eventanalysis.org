#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generated = JSON.parse(await readFile(resolve(root, "content/articles.generated.json"), "utf8"));
const now = Date.now();
const recent = generated.filter((article) =>
  article.status === "published"
  && now - new Date(article.publishedAt).getTime() <= 7 * 24 * 60 * 60 * 1000
);
if (recent.length < 3) {
  console.log(`Weekly roundup skipped: ${recent.length}/3 published articles in the last seven days.`);
} else {
  const outputDir = resolve(root, "content/review-packets");
  await mkdir(outputDir, { recursive: true });
  const id = `weekly-${new Date().toISOString().slice(0, 10)}`;
  await writeFile(resolve(outputDir, `${id}.json`), `${JSON.stringify({
    id,
    status: "needs_review",
    type: "weekly_roundup",
    articleIds: recent.map((article) => article.id),
    publicationBlocked: true,
  }, null, 2)}\n`);
  console.log(`Weekly review packet created for ${recent.length} published articles.`);
}
