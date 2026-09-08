import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveAutomationNow, resolveAutomationNowIso } from "./automation-clock.mjs";

export const AUTOPILOT_WORKFLOW_STATUSES = new Set([
  "autopilot_queued",
  "autopilot_reviewing",
  "autopilot_rewriting",
  "autopilot_publishing",
  "autopilot_failed",
  "published",
  "quarantined",
]);

export const AUTOPILOT_MAX_REWRITE_ATTEMPTS = 3;

export function autopilotReviewRunId(contentId) {
  return `editor-agent:${contentId}:${Date.now()}`;
}

export async function loadAiRuntimeConfig(root) {
  const localPath = process.env.EA_AI_CONFIG ? resolve(root, process.env.EA_AI_CONFIG) : resolve(root, "pipeline/config/ai.local.json");
  const fallbackPath = resolve(root, "pipeline/config/ai.example.json");
  try {
    const value = JSON.parse(await readFile(localPath, "utf8"));
    return value.ai ? value : { ai: value };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const value = JSON.parse(await readFile(fallbackPath, "utf8"));
    return value.ai ? value : { ai: value };
  }
}

export function autopilotApprovalOf(item, now = resolveAutomationNow(process.env.EA_NOW_ISO)) {
  const approval = item?.editorialAutopilot;
  if (!approval || approval.decision !== "approved") return null;
  if (approval.sourceEditionHash !== item.sourceEditionHash || Number(approval.revision) !== Number(item.revision)) return null;
  if (!approval.expiresAt || Number.isNaN(Date.parse(approval.expiresAt)) || new Date(approval.expiresAt) <= now) return null;
  if (!Array.isArray(approval.allowedJurisdictions) || !approval.allowedJurisdictions.length) return null;
  return approval;
}

export function autopilotRequestedLocales(rootData, requested = null, fallbackLocales = null) {
  const allLocales = (rootData || []).map(({ code }) => code).filter(Boolean);
  const nonChinese = allLocales.filter((code) => code !== "zh");
  const fallback = Array.isArray(fallbackLocales)
    ? fallbackLocales
    : String(fallbackLocales || "").split(",");
  const normalizedFallback = [...new Set(fallback.map((value) => String(value || "").trim()).filter(Boolean))]
    .filter((locale) => allLocales.includes(locale));
  if (!requested || requested === "all") return normalizedFallback.length ? normalizedFallback : ["zh", ...nonChinese];
  const values = Array.isArray(requested) ? requested : String(requested).split(",");
  const filtered = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  const available = filtered.filter((locale) => allLocales.includes(locale));
  return available.includes("zh") ? available : ["zh", ...available];
}

export function mergeRewrittenPacket(packet, rewritten) {
  return {
    ...rewritten,
    schemaVersion: packet.schemaVersion || rewritten.schemaVersion || 3,
    revision: packet.revision,
    riskClass: packet.riskClass,
    nexusJurisdictions: packet.nexusJurisdictions,
    sourceLocale: packet.sourceLocale,
    sourceRevision: packet.sourceRevision,
    sourceEditionHash: rewritten.sourceEditionHash || packet.sourceEditionHash,
  };
}

export function applyAutopilotPublicationState(item, { policy, locales, now = resolveAutomationNowIso(process.env.EA_NOW_ISO), approval, publish = true }) {
  const next = structuredClone(item);
  const requestedLocales = [...new Set((locales || []).map((locale) => String(locale || "").trim()).filter(Boolean))];
  if (!requestedLocales.length) throw new Error("Autopilot publication needs at least one locale");
  const publishableLocales = requestedLocales.filter((locale) => next.editions?.[locale]);
  if (!publishableLocales.length) throw new Error("Autopilot publication found no matching locales in item editions");
  next.reviewedAt ||= now;
  if (publish) next.publishedAt ||= now;
  next.qualityReview = {
    reviewer: approval.reviewer || "editor-agent:autopilot",
    decision: "approved",
    reviewedAt: now,
    overrideFindings: [...new Set(approval.overrideFindings || [])],
  };
  next.complianceReview = {
    reviewRunId: approval.reviewRunId,
    policyHash: approval.policyHash || null,
    auditedAt: approval.reviewedAt || now,
    expiresAt: approval.expiresAt,
    overrideFindings: [...new Set(approval.overrideFindings || [])],
  };
  next.editorialAutopilot = {
    decision: "approved",
    summary: approval.summary || "",
    reviewRunId: approval.reviewRunId,
    reviewedAt: approval.reviewedAt || now,
    expiresAt: approval.expiresAt,
    overrideFindings: [...new Set(approval.overrideFindings || [])],
    publishLocales: approval.publishLocales || "all",
    confidence: Number(approval.confidence || 0),
    allowedJurisdictions: [...new Set(approval.allowedJurisdictions || [])],
    rewriteAttempts: Number(approval.rewriteAttempts || 0),
    reviewPasses: Number(approval.reviewPasses || 1),
    sourceEditionHash: next.sourceEditionHash,
    revision: next.revision,
    agentVersion: approval.agentVersion || "configured-editor",
  };
  for (const locale of publishableLocales) {
    const edition = next.editions[locale];
    const allowed = (policy.localeMarkets?.[locale] || approval.allowedJurisdictions || []).filter(Boolean);
    edition.status = publish ? "published" : "approved";
    edition.complianceStatus = "passed";
    edition.complianceValidUntil = approval.expiresAt;
    edition.allowedJurisdictions = [...new Set(allowed)];
    edition.reviewer = "Event Analysis Autopilot Desk";
    if (publish) edition.slugFrozenAt ||= now;
  }
  return next;
}
