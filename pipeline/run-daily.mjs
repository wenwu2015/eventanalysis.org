#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPipelineConfig, enabledSources } from "./lib/config.mjs";
import { cleanupOrphanJobs, withEphemeralJob } from "./lib/job-lifecycle.mjs";
import { rankCandidates } from "./lib/candidate-ranking.mjs";
import { discoverFinishedMatches, collectMatchEvidence } from "./adapters/sofascore.mjs";
import { collectGenericMatchEvidence } from "./adapters/generic-provider.mjs";
import { collectFifaMatchEvidence } from "./adapters/fifa.mjs";
import { buildFactBundle } from "./lib/facts.mjs";
import { createReviewArtifact } from "./lib/article-writer.mjs";
import { runCommand } from "./lib/command-runner.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { countsTowardDailyDraftLimit, createFactBundleCandidate, evidencePlan, stopsDailyRunForAccessControl } from "./lib/daily-postmatch.mjs";
import { buildHistoricalFallbackPlan, writeHistoricalFallbackPlan } from "./lib/historical-fallback.mjs";
import { resolveAutomationNow } from "./lib/automation-clock.mjs";
import { writeRoundupReviewPacket } from "./lib/weekly-roundup.mjs";

const flags = new Set(process.argv.slice(2));
const skipAutopilot = flags.has("--skip-autopilot");
const dryRun = flags.has("--dry-run");
const allowHistoricalFallback = flags.has("--allow-historical-fallback");
const automationNow = resolveAutomationNow(process.env.EA_NOW_ISO);
const config = await loadPipelineConfig();
const jobsRoot = resolve(config.root, "pipeline/jobs");
await cleanupOrphanJobs(jobsRoot, config.policy.orphanMaxAgeMinutes);

const sources = enabledSources(config);
const sofa = sources.find((source) => source.id === "sofascore");
if (!sofa) {
  console.error("No active authorised SofaScore browser source. Copy sources.example.json to sources.local.json and enter the contracted limits before running.");
  process.exitCode = 2;
} else {
  const discoveryErrors = [];
  const candidates = await withEphemeralJob({
    root: config.root,
    articleId: "daily-discovery",
    diskLimitBytes: config.policy.jobDiskLimitBytes,
  }, async (job) => {
    return discoverFinishedMatches({
      source: sofa,
      job,
      now: automationNow,
      lookbackHours: config.policy.lookbackHours,
      stabilityMinutes: config.policy.postMatchStabilityMinutes || 20,
      timeoutMs: config.policy.navigationTimeoutMs,
      onCollectionError(error) {
        discoveryErrors.push(error);
      },
    });
  });

const allowedSports = new Set(config.policy.activeSports || ["football"]);
const corroborators = sources.filter((source) => source.id !== sofa.id);
const allowSingleOfficialCoreSource = Boolean(config.policy.allowSingleOfficialCoreSource);
const allowSingleAuthorisedCoreSource = Boolean(config.policy.allowSingleAuthorisedCoreSource);
  const ranked = rankCandidates(candidates.filter((event) =>
    allowedSports.has(String(event.sport || "football").toLowerCase())
    && evidencePlan(corroborators, event, {
      allowSingleOfficialCoreSource,
      allowSingleAuthorisedCoreSource,
      discoverySource: sofa,
    }).eligible
  )).slice(0, config.policy.maxCandidates);
  const existing = await loadContentData(config.root);
  const knownIdentities = new Set(existing.items.map((item) => `${item.primaryIntentKey}:${item.angleKey}`));
  const summary = {
    discovered: candidates.length,
    ranked: ranked.length,
    evaluated: 0,
    drafts: 0,
    blocked: 0,
    skippedExisting: 0,
    skippedNoEvidence: 0,
    discoveryErrors,
    historicalFallbackEnabled: allowHistoricalFallback,
    historicalPlanned: 0,
    historicalEvaluated: 0,
    stoppedForAccessControl: null,
    results: [],
  };

  for (const event of ranked) {
    if (summary.drafts >= config.policy.maxDraftsPerRun) break;
    summary.evaluated += 1;
    const result = await withEphemeralJob({
      root: config.root,
      articleId: `match-${event.id}`,
      diskLimitBytes: config.policy.jobDiskLimitBytes,
    }, async (job) => {
      const plan = evidencePlan(corroborators, event, {
        allowSingleOfficialCoreSource,
        allowSingleAuthorisedCoreSource,
        discoverySource: sofa,
      });
      const draftType = plan.mode === "authorised_single_source" ? "moment_analysis" : "match_analysis";
      const contentId = draftType === "moment_analysis" ? `moment-${event.id}` : `match-${event.id}`;
      const evidence = [];
      const collectionErrors = [];
      if (plan.useDiscoverySource) {
        try {
          evidence.push(await collectMatchEvidence({ source: sofa, event, job, timeoutMs: config.policy.navigationTimeoutMs }));
        } catch (error) {
          collectionErrors.push({ sourceId: sofa.id, code: error.code || "collection_failed" });
        }
      }
      for (const source of plan.sources) {
        try {
          const corroboration = source.id === "fifa"
            ? await collectFifaMatchEvidence({ source, event, job, timeoutMs: config.policy.navigationTimeoutMs })
            : await collectGenericMatchEvidence({ source, event, job, timeoutMs: config.policy.navigationTimeoutMs });
          if (corroboration) evidence.push(corroboration);
          else collectionErrors.push({ sourceId: source.id, code: "core_event_not_confirmed" });
        } catch (error) {
          collectionErrors.push({ sourceId: source.id, code: error.code || "collection_failed" });
        }
      }
      if (!evidence.length) return { kind: "no_evidence", eventId: event.id, collectionErrors };
      const facts = buildFactBundle(evidence, config.policy.minimumIndependentCoreSources, {
        sourceRegistry: sources,
        allowSingleOfficialCoreSource,
        allowSingleAuthorisedCoreSource,
        now: automationNow,
      });
      facts.collectionErrors = collectionErrors;
      const candidate = createFactBundleCandidate(facts, { type: draftType, id: contentId });
      const identity = `${candidate.primaryIntentKey}:${candidate.angleKey}`;
      if (knownIdentities.has(identity)) {
        return { kind: "update_existing_content", eventId: event.id, candidateId: candidate.id, facts };
      }
      knownIdentities.add(identity);
      if (dryRun) return { kind: "dry-run", facts };
      return createReviewArtifact({ facts, aiConfig: config.ai, job, root: config.root, draftType, contentId });
    });
    if (countsTowardDailyDraftLimit(result)) summary.drafts += 1;
    else if (result?.kind === "blocked") summary.blocked += 1;
    else if (result?.kind === "update_existing_content") summary.skippedExisting += 1;
    else if (result?.kind === "no_evidence") summary.skippedNoEvidence += 1;
    summary.results.push({ eventId: event.id, result });
    console.log(JSON.stringify({ eventId: event.id, result }, null, 2));
    if (stopsDailyRunForAccessControl(result)) {
      summary.stoppedForAccessControl = {
        eventId: event.id,
        sourceIds: [...new Set(result.collectionErrors.filter((error) => error?.code === "ACCESS_CONTROL_REQUIRED").map((error) => error.sourceId).filter(Boolean))],
      };
      console.log(JSON.stringify({
        status: "source_access_stopped",
        ...summary.stoppedForAccessControl,
      }, null, 2));
      break;
    }
    if (result?.kind === "draft" && !skipAutopilot) {
      try {
        await runCommand(["npm", "run", "editorial:autopilot", "--", result.path], {
          cwd: config.root,
          timeoutMs: 3_600_000,
        });
      } catch (error) {
        console.error(`Autopilot failed for ${event.id}: ${String(error?.message || error)}`);
      }
    }
  }

  const batchRoundupSourcePaths = summary.results
    .map(({ result }) => result)
    .filter((result) => result?.kind === "draft" && result?.path && result?.source !== "historical_fallback")
    .map(({ path }) => path);
  if (!summary.stoppedForAccessControl && !dryRun && summary.drafts < config.policy.maxDraftsPerRun && batchRoundupSourcePaths.length >= 3) {
    const batchRoundupItems = await Promise.all(batchRoundupSourcePaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    const roundup = await writeRoundupReviewPacket(config.root, batchRoundupItems, {
      now: automationNow,
      idPrefix: "daily-football-roundup",
      title: "本批次足球页面汇总",
      deck: `汇总本轮已确认的 ${batchRoundupItems.length} 篇足球页面，只保留原稿已确认的赛后事实与关键节点。`,
      readerQuestion: "本轮已确认的足球页面，分别确认了哪些赛后事实与关键节点？",
    });
    if (roundup) {
      const result = { kind: "draft", path: roundup.path, source: "batch_roundup" };
      summary.drafts += 1;
      summary.results.push({ eventId: "batch_roundup", result });
      console.log(JSON.stringify({ eventId: "batch_roundup", result }, null, 2));
      if (!skipAutopilot) {
        try {
          await runCommand(["npm", "run", "editorial:autopilot", "--", result.path], {
            cwd: config.root,
            timeoutMs: 3_600_000,
          });
        } catch (error) {
          console.error(`Autopilot failed for batch roundup: ${String(error?.message || error)}`);
        }
      }
    }
  }

  if (!summary.stoppedForAccessControl && allowHistoricalFallback && summary.ranked === 0 && summary.drafts < config.policy.maxDraftsPerRun) {
    const historicalPlan = buildHistoricalFallbackPlan(existing, {
      now: automationNow,
      lookbackDays: 365,
      maxCandidates: config.policy.maxCandidates,
    });
    summary.historicalPlanned = historicalPlan.length;
    const planPath = await writeHistoricalFallbackPlan(config.root, historicalPlan);
    console.log(JSON.stringify({ status: "historical_fallback_planned", planPath, candidates: historicalPlan.length }, null, 2));
    for (const entry of historicalPlan) {
      if (summary.drafts >= config.policy.maxDraftsPerRun) break;
      summary.historicalEvaluated += 1;
      const identity = `${entry.candidate.primaryIntentKey}:${entry.candidate.angleKey}`;
      if (knownIdentities.has(identity)) {
        summary.skippedExisting += 1;
        summary.results.push({ eventId: entry.eventId, result: { kind: "update_existing_content", candidateId: entry.candidate.id, pairKey: entry.pairKey, focusPerson: entry.focusPerson } });
        continue;
      }
      knownIdentities.add(identity);
      const result = await withEphemeralJob({
        root: config.root,
        articleId: `historical-${entry.eventId}-${entry.focusPerson.sourcePlayerId || entry.focusPerson.name}`,
        diskLimitBytes: config.policy.jobDiskLimitBytes,
      }, async (job) => {
        if (dryRun) return { kind: "dry-run", facts: entry.facts };
        return createReviewArtifact({ facts: entry.facts, aiConfig: config.ai, job, root: config.root });
      });
      if (countsTowardDailyDraftLimit(result)) summary.drafts += 1;
      else if (result?.kind === "blocked") summary.blocked += 1;
      summary.results.push({ eventId: entry.eventId, result: { ...result, pairKey: entry.pairKey, focusPerson: entry.focusPerson, source: "historical_fallback" } });
      console.log(JSON.stringify({ eventId: entry.eventId, historical: true, result }, null, 2));
      if (result?.kind === "draft" && !skipAutopilot) {
        try {
          await runCommand(["npm", "run", "editorial:autopilot", "--", result.path], {
            cwd: config.root,
            timeoutMs: 3_600_000,
          });
        } catch (error) {
          console.error(`Autopilot failed for historical ${entry.eventId}: ${String(error?.message || error)}`);
        }
      }
    }
  } else if (!summary.stoppedForAccessControl && !allowHistoricalFallback && summary.ranked === 0) {
    console.log(JSON.stringify({
      status: "historical_fallback_skipped",
      reason: "today_only_daily_output",
    }, null, 2));
  }

  console.log(JSON.stringify({ status: "daily_complete", ...summary }, null, 2));
}
