#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const reviewRoot = resolve(root, "content/review-packets");
const startedAt = Date.now();
await runCommand(["node", "pipeline/run-daily.mjs"], { cwd: root, timeoutMs: 1_800_000 });

const candidates = [];
for (const file of await readdir(reviewRoot).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
  if (!file.endsWith(".json")) continue;
  const path = resolve(reviewRoot, file);
  const metadata = await stat(path);
  if (metadata.mtimeMs + 1_000 < startedAt) continue;
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value.publicationBlocked && value.editions?.zh) candidates.push(path);
}

let locallyApproved = 0;
const results = [];
for (const path of candidates) {
  try {
    await runCommand(["npm", "run", "publish:automatic", "--", path, "--locales=zh"], { cwd: root, timeoutMs: 1_800_000 });
    locallyApproved += 1;
    results.push({ path, status: "zh_local_preview_ready" });
  } catch (error) {
    results.push({ path, status: "held", errorCode: error.code || "workflow_failed" });
  }
}
if (locallyApproved) await runCommand(["npm", "run", "build:zh"], { cwd: root, timeoutMs: 120_000 });
console.log(JSON.stringify({ status: "postmatch_complete", candidates: candidates.length, locallyApproved, awsReleased: false, results }, null, 2));
