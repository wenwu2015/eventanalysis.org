#!/usr/bin/env node
import { resolve } from "node:path";
import { loadPipelineConfig, enabledSources } from "./lib/config.mjs";
import { cleanupOrphanJobs, withEphemeralJob } from "./lib/job-lifecycle.mjs";
import { rankCandidates } from "./lib/candidate-ranking.mjs";
import { discoverFinishedMatches, collectMatchEvidence } from "./adapters/sofascore.mjs";
import { collectGenericMatchEvidence } from "./adapters/generic-provider.mjs";
import { buildFactBundle } from "./lib/facts.mjs";
import { createReviewArtifact } from "./lib/article-writer.mjs";

const flags = new Set(process.argv.slice(2));
const config = await loadPipelineConfig();
const jobsRoot = resolve(config.root, "pipeline/jobs");
await cleanupOrphanJobs(jobsRoot, config.policy.orphanMaxAgeMinutes);

const sources = enabledSources(config);
const sofa = sources.find((source) => source.id === "sofascore");
if (!sofa) {
  console.error("No active authorised SofaScore browser source. Copy sources.example.json to sources.local.json and enter the contracted limits before running.");
  process.exitCode = 2;
} else {
  const candidates = await withEphemeralJob({
    root: config.root,
    articleId: "daily-discovery",
    diskLimitBytes: config.policy.jobDiskLimitBytes,
  }, async (job) => {
    return discoverFinishedMatches({
      source: sofa,
      job,
      lookbackHours: config.policy.lookbackHours,
      timeoutMs: config.policy.navigationTimeoutMs,
    });
  });

  const ranked = rankCandidates(candidates).slice(0, config.policy.maxCandidates);
  const selected = ranked.slice(0, config.policy.maxDraftsPerRun);
  for (const event of selected) {
    const result = await withEphemeralJob({
      root: config.root,
      articleId: `match-${event.id}`,
      diskLimitBytes: config.policy.jobDiskLimitBytes,
    }, async (job) => {
      const evidence = [];
      const collectionErrors = [];
      evidence.push(await collectMatchEvidence({ source: sofa, event, job, timeoutMs: config.policy.navigationTimeoutMs }));
      for (const source of sources.filter((candidate) => candidate.id !== sofa.id)) {
        if (!source.matchUrlTemplate || !source.eventMapping) continue;
        try {
          const corroboration = await collectGenericMatchEvidence({ source, event, job, timeoutMs: config.policy.navigationTimeoutMs });
          if (corroboration) evidence.push(corroboration);
          else collectionErrors.push({ sourceId: source.id, code: "core_event_not_confirmed" });
        } catch (error) {
          collectionErrors.push({ sourceId: source.id, code: error.code || "collection_failed" });
        }
      }
      const facts = buildFactBundle(evidence, config.policy.minimumIndependentCoreSources);
      facts.collectionErrors = collectionErrors;
      if (flags.has("--dry-run")) return { kind: "dry-run", facts };
      return createReviewArtifact({ facts, aiConfig: config.ai, job, root: config.root });
    });
    console.log(JSON.stringify({ eventId: event.id, result }, null, 2));
  }
}
