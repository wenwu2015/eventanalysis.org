#!/usr/bin/env node
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPipelineConfig, enabledSources } from "./lib/config.mjs";
import { cleanupOrphanJobs, withEphemeralJob } from "./lib/job-lifecycle.mjs";
import { collectWorldCup2026Snapshot } from "./adapters/world-cup-2026.mjs";
import { buildWorldCup2026Content } from "./lib/world-cup-content.mjs";
import { privatizeWorldCupIds } from "./lib/world-cup-id-privacy.mjs";

const config = await loadPipelineConfig();
await cleanupOrphanJobs(resolve(config.root, "pipeline/jobs"), config.policy.orphanMaxAgeMinutes);
const sources = enabledSources(config);
const sofaSource = sources.find(({ id }) => id === "sofascore");
const fifaSource = sources.find(({ id }) => id === "fifa");
if (!sofaSource || !fifaSource) throw new Error("Active authorised SofaScore and FIFA browser sources are required");

const snapshot = await withEphemeralJob({
  root: config.root,
  articleId: "world-cup-2026-batch",
  diskLimitBytes: config.policy.jobDiskLimitBytes,
}, (job) => collectWorldCup2026Snapshot({
  sofaSource,
  fifaSource,
  job,
  timeoutMs: config.policy.navigationTimeoutMs,
  onProgress(progress) { console.log(JSON.stringify(progress)); },
}));

const content = privatizeWorldCupIds(buildWorldCup2026Content(snapshot));
if (content.counts.events !== 100) throw new Error(`Expected 100 completed World Cup matches at this snapshot, received ${content.counts.events}`);
if (content.counts.players < 1248) throw new Error(`Expected at least the 1,248 initially registered World Cup players, received ${content.counts.players}`);
if (content.counts.items !== content.counts.players + 101) throw new Error(`Expected one profile per observed player, 100 match reports and one tournament report; received ${content.counts.items} items`);

const targets = [
  ["entities", "content/data/entities/world-cup-2026.json"],
  ["events", "content/data/events/world-cup-2026.json"],
  ["facts", "content/data/facts/world-cup-2026.json"],
  ["items", "content/data/items/world-cup-2026.json"],
];
const staging = resolve(config.root, "pipeline/runtime/world-cup-2026-data");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: 0o700 });
for (const [key, relative] of targets) {
  const temporary = resolve(staging, `${key}.json`);
  const destination = resolve(config.root, relative);
  await writeFile(temporary, `${JSON.stringify(content[key], null, 2)}\n`, { mode: 0o600 });
  await mkdir(resolve(destination, ".."), { recursive: true });
  await rename(temporary, destination);
}
await rm(staging, { recursive: true, force: true });
console.log(JSON.stringify({ status: "structured_content_written", ...content.counts }, null, 2));
