#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadContentData } from "./lib/data-store.mjs";

const root = resolve(import.meta.dirname, "..");
const data = await loadContentData(root);
const now = Date.now();
const recent = data.items.filter((item) => Object.values(item.editions || {}).some(({ status }) => status === "published") && now - new Date(item.publishedAt).getTime() <= 7 * 24 * 60 * 60 * 1000);
if (recent.length < 3) console.log(`Weekly roundup skipped: ${recent.length}/3 published content items in the last seven days.`);
else {
  const outputDir = resolve(root, "content/review-packets");
  await mkdir(outputDir, { recursive: true });
  const id = `weekly-${new Date().toISOString().slice(0, 10)}`;
  await writeFile(resolve(outputDir, `${id}.json`), `${JSON.stringify({ schemaVersion: 2, id, revision: 1, type: "roundup", status: "needs_review", sourceContentRefs: recent.map(({ id: contentId }) => contentId), publicationBlocked: true }, null, 2)}\n`);
  console.log(`Weekly review packet created for ${recent.length} published content items.`);
}
