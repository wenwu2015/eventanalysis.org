#!/usr/bin/env node
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { runCommand } from "./lib/command-runner.mjs";
import { deriveReviewLifecycle, setReviewWorkflowStatus } from "./lib/review-workflow.mjs";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run content:publish -- content/review-packets/<content>.json");
const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, input);
if (!inputPath.startsWith(resolve(root, "content/review-packets") + "/")) throw new Error("Only review packets may be promoted");
const item = JSON.parse(await readFile(inputPath, "utf8"));
const approved = Object.entries(item.editions || {}).filter(([, edition]) => edition.status === "approved");
if (!approved.length) throw new Error("At least one language edition must be approved by an editor");
for (const [, edition] of approved) edition.status = "published";
item.publishedAt ||= new Date().toISOString();
item.reviewedAt = new Date().toISOString();
for (const [, edition] of approved) edition.slugFrozenAt ||= item.reviewedAt;
const destination = resolve(root, "content/data/items", `${item.id}.json`);
await access(destination).then(() => { throw new Error(`Content item already exists: ${item.id}. Use the revision workflow to update it.`); }).catch((error) => { if (error.code !== "ENOENT") throw error; });
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify(item, null, 2)}\n`);
try {
  await runCommand(["npm", "run", "data:validate", "--", "--require-private-evidence"], { cwd: root, timeoutMs: 60_000 });
  await runCommand(["npm", "run", "quality:audit", "--", "--content", item.id], { cwd: root, timeoutMs: 60_000 });
} catch (error) {
  await rm(destination, { force: true });
  throw error;
}
await setReviewWorkflowStatus(root, item, "published", "稿件已正式发布，后续可继续跟踪改版。", {
  lifecycle: deriveReviewLifecycle(item, {
    current: null,
    sourceItem: item,
    sourceItemPath: relative(root, destination),
    forceStatus: "published",
    now: item.publishedAt,
  }),
  release: {
    destination: relative(root, destination),
    decisionAt: item.reviewedAt,
  },
});
await rename(inputPath, resolve(root, "content/review-packets", `${basename(inputPath, ".json")}.published.json`)).catch(() => {});
console.log(`Published approved editions for ${item.id}; unapproved languages remain private.`);
