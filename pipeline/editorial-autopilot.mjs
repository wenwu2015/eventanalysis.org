#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { runCommand } from "./lib/command-runner.mjs";
import { writePrivateJson, findContentItemFile, loadCompliancePolicy, readJson } from "./lib/compliance-store.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { loadAiRuntimeConfig, autopilotRequestedLocales, autopilotReviewRunId, AUTOPILOT_MAX_REWRITE_ATTEMPTS, mergeRewrittenPacket } from "./lib/autopilot.mjs";
import { normalizeReviewDraft, assertDraftShape } from "./lib/article-writer.mjs";
import { deriveReviewLifecycle, loadReviewWorkflow, setReviewWorkflowStatus } from "./lib/review-workflow.mjs";
import { resolveAutomationNow, resolveAutomationNowIso } from "./lib/automation-clock.mjs";

const root = resolve(import.meta.dirname, "..");
const automationNow = resolveAutomationNow(process.env.EA_NOW_ISO);
const automationNowIso = resolveAutomationNowIso(process.env.EA_NOW_ISO);
const contentFlag = process.argv.find((value) => value.startsWith("--content="))?.slice("--content=".length);
const resumePending = process.argv.includes("--resume-pending");
const fileArg = process.argv.slice(2).find((value) => !value.startsWith("--"));

if (!contentFlag && !resumePending && !fileArg) {
  throw new Error("Usage: npm run editorial:autopilot -- --content=<id> | --resume-pending | content/review-packets/<file>.json");
}

async function runJsonCommand(command, env, timeoutMs) {
  await runCommand(command, { cwd: root, timeoutMs, env });
  return JSON.parse(await readFile(env.EA_OUTPUT_PATH, "utf8"));
}

async function runAuditAdvisory(contentId) {
  const privatePath = resolve(root, "private-compliance/audits", `${contentId}.json`);
  try {
    await runCommand(["node", "pipeline/compliance-audit.mjs", `--content=${contentId}`], { cwd: root, timeoutMs: 900_000 });
  } catch {}
  try {
    return JSON.parse(await readFile(privatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { reports: [] };
    throw error;
  }
}

function advisoryReportFor(contentId, auditResult = {}) {
  return (auditResult.reports || []).find((report) => report.contentId === contentId) || null;
}

async function loadPacketByIdOrFile() {
  const reviewRoot = resolve(root, "content/review-packets");
  const entries = await readdir(reviewRoot, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".published.json")).map((entry) => resolve(reviewRoot, entry.name));
  if (fileArg) return [resolve(root, fileArg)];
  if (contentFlag) {
    const matched = [];
    for (const path of files) {
      if (path.endsWith(`/${contentFlag}.json`)) matched.push(path);
      else {
        const packet = JSON.parse(await readFile(path, "utf8"));
        if (packet?.id === contentFlag) matched.push(path);
      }
    }
    if (!matched.length) throw new Error(`Review packet not found for ${contentFlag}`);
    return matched;
  }
  return files;
}

async function loadStructuredBundle(item) {
  const data = await loadContentData(root);
  const entityMap = new Map(data.entities.map((entity) => [entity.id, entity]));
  const eventMap = new Map(data.events.map((event) => [event.id, event]));
  const factMap = new Map(data.facts.map((fact) => [fact.id, fact]));
  return {
    entities: (item.entityRefs || []).map((id) => entityMap.get(id)).filter(Boolean),
    events: (item.eventRefs || []).map((id) => eventMap.get(id)).filter(Boolean),
    facts: [...new Set((item.claims || []).flatMap((claim) => claim.factRefs || []))].map((id) => factMap.get(id)).filter(Boolean),
  };
}

function summarizePacket(packet) {
  return {
    id: packet.id,
    type: packet.type,
    sport: packet.sport,
    primaryIntentKey: packet.primaryIntentKey,
    angleKey: packet.angleKey,
    originalContribution: packet.originalContribution,
    readerQuestion: packet.readerQuestion,
    author: packet.author,
    confidence: packet.confidence,
    entityRefs: packet.entityRefs || [],
    eventRefs: packet.eventRefs || [],
    claims: (packet.claims || []).map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      factRefs: claim.factRefs || [],
      summary: claim.summary,
    })),
    editionZh: packet.editions?.zh ? {
      slug: packet.editions.zh.slug,
      title: packet.editions.zh.title,
      deck: packet.editions.zh.deck,
      competition: packet.editions.zh.competition,
      venue: packet.editions.zh.venue,
      homeName: packet.editions.zh.homeName,
      awayName: packet.editions.zh.awayName,
      resultLabel: packet.editions.zh.resultLabel,
      sections: packet.editions.zh.sections || [],
      timeline: packet.editions.zh.timeline || [],
      status: packet.editions.zh.status,
      complianceStatus: packet.editions.zh.complianceStatus,
    } : null,
  };
}

function summarizeStructuredBundle(structured) {
  return {
    entities: (structured.entities || []).map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      names: entity.names || {},
      aliases: entity.aliases || [],
      attributes: entity.attributes || {},
    })),
    events: (structured.events || []).map((event) => ({
      id: event.id,
      sport: event.sport,
      kind: event.kind,
      competitionName: event.competitionName,
      startedAt: event.startedAt,
      status: event.status,
      entityRefs: event.entityRefs || [],
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeScore: event.homeScore,
      awayScore: event.awayScore,
    })),
    facts: (structured.facts || []).map((fact) => ({
      id: fact.id,
      subjectId: fact.subjectId,
      predicate: fact.predicate,
      value: fact.value,
      status: fact.status,
    })),
  };
}

function summarizePreaudit(preaudit) {
  return {
    decision: preaudit?.decision || null,
    riskClass: preaudit?.riskClass || null,
    factFindings: (preaudit?.factFindings || []).map((finding) => ({
      code: finding.code,
      detail: finding.detail,
      locale: finding.locale,
    })),
    civilityFindings: preaudit?.civilityFindings || [],
    translationFindings: preaudit?.translationFindings || [],
    prohibitedClaimFindings: preaudit?.prohibitedClaimFindings || [],
  };
}

async function runOnePacket(packetPath, trigger = "direct") {
  let packet = JSON.parse(await readFile(packetPath, "utf8"));
  const packetFile = basename(packetPath);
  const aiConfig = await loadAiRuntimeConfig(root);
  const policy = await loadCompliancePolicy(root);
  const locales = autopilotRequestedLocales(await readJson(resolve(root, "content/locales.json")), "all");
  const workflow = await loadReviewWorkflow(root, packet);
  await setReviewWorkflowStatus(root, packet, "autopilot_queued", "新稿件已进入自动编辑部队列。", {
    lifecycle: deriveReviewLifecycle(packet, {
      current: workflow.lifecycle,
      sourceItem: await findContentItemFile(root, packet.id).then((found) => found?.item || null),
      sourceItemPath: `content/data/items/${packet.id}.json`,
    }),
    autopilot: {
      enabled: true,
      status: "queued",
      trigger,
      startedAt: workflow.autopilot?.startedAt || automationNowIso,
      finishedAt: null,
      maxRewriteAttempts: AUTOPILOT_MAX_REWRITE_ATTEMPTS,
      lastError: null,
    },
  });

  const advisory = await runAuditAdvisory(packet.id);
  const advisoryReport = advisoryReportFor(packet.id, advisory);
  let preaudit = {
    contentId: packet.id,
    revision: packet.revision,
    sourceEditionHash: packet.sourceEditionHash,
    decision: "REVIEW",
    riskClass: packet.riskClass || "A",
    factFindings: [],
    civilityFindings: [],
    translationFindings: [],
    prohibitedClaimFindings: [],
    preauditUnavailableReason: null,
  };
  try {
    await runCommand(["npm", "run", "compliance:preaudit", "--", `content/review-packets/${packetFile}`, "--locales=zh"], { cwd: root, timeoutMs: 90_000 });
    preaudit = {
      ...preaudit,
      ...JSON.parse(await readFile(resolve(root, "private-compliance/reports", `${packet.id}-r${packet.revision}.json`), "utf8")),
    };
  } catch (error) {
    preaudit.preauditUnavailableReason = String(error?.message || error).slice(-1_000);
  }

  for (;;) {
    const currentWorkflow = await loadReviewWorkflow(root, packet);
    const rewriteAttempts = Number(currentWorkflow.autopilot?.rewriteAttempts || 0);
    const structured = await loadStructuredBundle(packet);
    const promptPath = resolve(root, "pipeline/runtime", `${packet.id}.editor-prompt.json`);
    const outputPath = resolve(root, "pipeline/runtime", `${packet.id}.editor-output.json`);
    const editorPrompt = {
      objective: "Act as the final EventAnalysis editorial compliance desk. Decide whether to approve, rewrite, or quarantine the Chinese master for automatic production release.",
      packet: summarizePacket(packet),
      workflow: {
        status: currentWorkflow.status,
        summary: currentWorkflow.summary,
        autopilot: {
          status: currentWorkflow.autopilot?.status || null,
          reviewPasses: Number(currentWorkflow.autopilot?.reviewPasses || 0),
          rewriteAttempts,
          maxRewriteAttempts: AUTOPILOT_MAX_REWRITE_ATTEMPTS,
          previousRewriteBrief: currentWorkflow.autopilot?.lastRewriteBrief || null,
        },
      },
      advisoryAudit: advisoryReport ? {
        contentId: advisoryReport.contentId || null,
        summary: advisoryReport.summary || null,
        findings: advisoryReport.findings || [],
      } : null,
      preaudit: summarizePreaudit(preaudit),
      rewriteAttempts,
      maxRewriteAttempts: AUTOPILOT_MAX_REWRITE_ATTEMPTS,
      previousRewriteBrief: currentWorkflow.autopilot?.lastRewriteBrief || null,
      structured: summarizeStructuredBundle(structured),
    };
    await writePrivateJson(promptPath, editorPrompt);
    await setReviewWorkflowStatus(root, packet, "autopilot_reviewing", "自动编辑部正在审稿。", {
      autopilot: {
        status: "reviewing",
        reviewPasses: Number(currentWorkflow.autopilot?.reviewPasses || 0) + 1,
        lastError: null,
      },
    });
    const editorResult = await runJsonCommand(aiConfig.ai.editor.command, { EA_PROMPT_PATH: promptPath, EA_OUTPUT_PATH: outputPath }, aiConfig.ai.editor.timeoutMs);
    if (editorResult.decision === "rewrite" && !editorResult.rewriteBrief) {
      throw new Error("Editor decision 'rewrite' requires rewriteBrief");
    }

    if (editorResult.decision === "quarantine") {
      const existing = await findContentItemFile(root, packet.id);
      if (existing) {
        await runCommand(["npm", "run", "compliance:quarantine", "--", `--content=${packet.id}`, "--rule=autopilot_quarantine", "--delete-body"], { cwd: root, timeoutMs: 60_000 });
      } else {
        packet.editions.zh.status = "quarantined";
        packet.editions.zh.complianceStatus = "quarantined";
        await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
      }
      await setReviewWorkflowStatus(root, packet, "quarantined", editorResult.summary || "自动编辑部已隔离稿件。", {
        autopilot: {
          status: "quarantined",
          finishedAt: automationNowIso,
          lastEditorDecision: "quarantine",
          overrideFindings: editorResult.overrideFindings || [],
        },
      });
      return { contentId: packet.id, status: "quarantined" };
    }

    if (editorResult.decision === "approve") {
      packet.editorialAutopilot = {
        decision: "approved",
        summary: editorResult.summary,
        reviewRunId: autopilotReviewRunId(packet.id),
        reviewedAt: automationNowIso,
        expiresAt: new Date(automationNow.getTime() + Number(policy.publicationLeaseHours || 24) * 3_600_000).toISOString(),
        overrideFindings: editorResult.overrideFindings || [],
        publishLocales: editorResult.publishLocales || "all",
        confidence: editorResult.confidence,
        allowedJurisdictions: [...new Set(Object.values(policy.localeMarkets || {}).flat())],
        rewriteAttempts,
        reviewPasses: Number(currentWorkflow.autopilot?.reviewPasses || 1),
        sourceEditionHash: packet.sourceEditionHash,
        revision: packet.revision,
        agentVersion: editorResult.agentVersion || "configured-editor",
        reviewer: `editor-agent:${packet.id}`,
        policyHash: advisoryReport?.policyHash || null,
      };
      await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
      await setReviewWorkflowStatus(root, packet, "autopilot_publishing", editorResult.summary || "自动编辑部已批准，进入生产发布。", {
        autopilot: {
          status: "publishing",
          lastEditorDecision: "approve",
          overrideFindings: editorResult.overrideFindings || [],
        },
      });
      await runCommand(["npm", "run", "publish:agent", "--", `--content=${packet.id}`], { cwd: root, timeoutMs: 3_600_000 });
      return { contentId: packet.id, status: "published" };
    }

    if (rewriteAttempts >= AUTOPILOT_MAX_REWRITE_ATTEMPTS) {
      await setReviewWorkflowStatus(root, packet, "autopilot_failed", "自动编辑部已达到最大改稿次数。", {
        autopilot: {
          status: "failed",
          finishedAt: automationNowIso,
          lastEditorDecision: "rewrite",
          lastRewriteBrief: editorResult.rewriteBrief || null,
          overrideFindings: editorResult.overrideFindings || [],
          lastError: "rewrite_limit_reached",
        },
      });
      return { contentId: packet.id, status: "autopilot_failed", error: "rewrite_limit_reached" };
    }

    const rewritePromptPath = resolve(root, "pipeline/runtime", `${packet.id}.rewriter-prompt.json`);
    const rewriteOutputPath = resolve(root, "pipeline/runtime", `${packet.id}.rewriter-output.json`);
    await writePrivateJson(rewritePromptPath, {
      objective: "Rewrite the Chinese master to satisfy the editor's compliance brief without changing facts, entities, event scope, or creating non-Chinese editions.",
      packet: summarizePacket(packet),
      advisoryAudit: advisoryReport ? {
        contentId: advisoryReport.contentId || null,
        summary: advisoryReport.summary || null,
        findings: advisoryReport.findings || [],
      } : null,
      preaudit: summarizePreaudit(preaudit),
      structured: summarizeStructuredBundle(structured),
      rewriteBrief: editorResult.rewriteBrief,
      rewriteAttempt: rewriteAttempts + 1,
    });
    await setReviewWorkflowStatus(root, packet, "autopilot_rewriting", editorResult.summary || "自动编辑部正在改稿。", {
      autopilot: {
        status: "rewriting",
        rewriteAttempts: rewriteAttempts + 1,
        lastEditorDecision: "rewrite",
        lastRewriteBrief: editorResult.rewriteBrief || null,
        overrideFindings: editorResult.overrideFindings || [],
      },
    });
    const rewritten = await runJsonCommand(aiConfig.ai.rewriter.command, { EA_PROMPT_PATH: rewritePromptPath, EA_OUTPUT_PATH: rewriteOutputPath }, aiConfig.ai.rewriter.timeoutMs);
    normalizeReviewDraft(rewritten);
    assertDraftShape(rewritten, {
      references: {
        eventRefs: packet.eventRefs || [],
        entityRefs: packet.entityRefs || [],
        requiredFactRefs: [...new Set((packet.claims || []).flatMap((claim) => claim.factRefs || []))],
        optionalFactRefs: [],
      },
      entities: structured.entities,
    });
    packet = mergeRewrittenPacket(packet, rewritten);
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  }
}

const packetPaths = await loadPacketByIdOrFile();
const results = [];
for (const packetPath of packetPaths) {
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  if (!packet?.editions?.zh) continue;
  results.push(await runOnePacket(packetPath, resumePending ? "resume-pending" : "new-packet"));
}
console.log(JSON.stringify({ status: "autopilot_complete", processed: results.length, results }, null, 2));
