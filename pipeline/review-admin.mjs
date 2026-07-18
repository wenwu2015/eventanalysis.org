#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { legalRegistryPath, loadLegalRegistry, readJson, writeLegalRegistry, writePrivateJson } from "./lib/compliance-store.mjs";
import { validateLegalPack } from "./lib/compliance.mjs";
import {
  autoActivateRegistryLegalPack,
  blockedAutomationLimits,
  blockedItemResolutionStage,
  buildLegalSupportTemplate,
  buildItemWorkflowGuidance,
  collectOperatorJurisdictionWeakSignals,
  collectLegalDraftCandidateJurisdictions,
  detectOperatorJurisdictionFromSupportRecords,
  detectOperatorJurisdictionFromTexts,
  ensureLegalPackDrafts,
  importLegalSupportRecord,
  loadReviewAdminItem,
  normalizeLegalSupportRecord,
  nextBlockedLegalPack,
  loadReviewAdminState,
  parseLegalPackLines,
  parseOfficialSourcesInput,
  retargetLegalReturnTo,
  serializeOfficialSourcesInput,
  updateReviewPacketStatus,
  upsertLegalPack,
} from "./lib/review-admin.mjs";
import { renderReviewPreviewHtml } from "./lib/review-preview.mjs";
import { runCommand } from "./lib/command-runner.mjs";
import { activeReviewJob, writeReviewJob } from "./lib/review-jobs.mjs";
import { dynamicReviewRoute, reviewHtmlRoute, setReviewWorkflowStatus } from "./lib/review-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const previewRoot = resolve(root, "dist/preview-zh");
const privateReviewRoot = resolve(root, "private-review/html");
const privateTaskRoot = resolve(root, "private-legal/tasks");
const port = Number(process.env.PORT || 3210);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function formatDate(value) {
  if (!value) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function editionStatusText(status) {
  return {
    approved: "已批准",
    needs_review: "待编辑一键通过",
    published: "已入库",
    quarantined: "已隔离",
    withdrawn: "已撤回",
  }[status] || status;
}

function workflowStatusText(status) {
  return {
    deleted: "已删除",
    editorial_approved: "已批准待一键流转",
    published: "已发布",
    quarantined: "已隔离",
    release_blocked: "系统中断（未发布）",
    release_ready: "本地预发完成（未公开发布）",
    release_requested: "发布申请处理中（未公开发布）",
    release_review_required: "发布待人工复核",
    review_pending: "待编辑一键通过",
  }[status] || status;
}

function lifecycleStatusText(status) {
  return {
    draft: "新草稿",
    edited_pending_publish: "已编辑待发布",
    published: "已发布",
    deleted: "已删除",
  }[status] || status;
}

function readinessTone(status) {
  return status === "PASS" ? "ok" : "warn";
}

function workflowTone(status) {
  return {
    deleted: "warn",
    editorial_approved: "ok",
    published: "ok",
    quarantined: "warn",
    release_blocked: "warn",
    release_ready: "ok",
    release_requested: "ok",
    release_review_required: "warn",
    review_pending: "default",
  }[status] || "default";
}

function editorSurfaceStageText(item, guidance = null) {
  const workflowStatus = item?.workflow?.status || "";
  if (workflowStatus === "release_requested") return "已进入系统发布检查";
  if (workflowStatus === "release_blocked") return "已进入系统发布检查";
  if (workflowStatus === "release_review_required") return "待人工复核";
  if (workflowStatus === "release_ready") return "本地预发完成";
  if (workflowStatus === "published") return "已正式发布";
  if (workflowStatus === "deleted") return "已删除";
  return guidance?.stateLabel === "待编辑一键通过" ? "待编辑一键通过" : editionStatusText(item?.edition?.status);
}

function publicSurfaceStatusText(status) {
  return {
    release_requested: "公开站点尚未变更，系统正在跑本地预审和本地预发。",
    release_blocked: "公开站点未发布。这次只是后台系统中断，不是已经上线后回滚。",
    release_review_required: "公开站点尚未变更，当前停在人工复核前。",
    release_ready: "公开站点尚未变更，目前只完成了中文本地预发。",
  }[status] || "当前页面不把这一步视为公开发布结果。";
}

function editorVisibleWorkflowSummary(item, guidance = null) {
  const status = item?.workflow?.status || "";
  const blockers = guidance?.blockers || [];
  if (status === "release_requested") return "后台正在执行检查，公开站点还没有发布。";
  if (status === "release_ready") return "后台检查已通过，当前只完成了中文本地预发，公开站点还没有发布。";
  if (status === "release_review_required") return "后台要求人工复核，公开站点还没有发布。";
  if (status === "published") return "这篇稿件已经正式发布，后续改动应视为对线上版本的改版。";
  if (status === "deleted") return "这篇稿件已删除，当前保留的是可恢复的状态记录。";
  if (status === "release_blocked") {
    if (blockers.length) {
      if (blockers[0].includes("公开站点仍未发布")) return blockers[0];
      return `${blockers[0]} 公开站点仍未发布。`;
    }
    return "后台这次没有通过，但公开站点仍未发布。";
  }
  if (status === "editorial_approved") return "中文主稿已批准，还没有进入后台检查。";
  if (status === "review_pending") return "当前还停在编辑审稿阶段。";
  if (status === "quarantined") return "稿件已隔离，公开站点不会继续流转。";
  return "当前还没有进入公开发布结果。";
}

function editorVisibleQueueIssue(item, guidance = null) {
  const blockers = guidance?.blockers || [];
  if (blockers.length) {
    if (item?.metrics?.missing?.length) return blockers[0];
    return "打开稿件详情，看“为什么会卡在这里”，然后直接重跑一键审核通过。";
  }
  if (item?.workflow?.status === "release_requested") return "后台处理中，暂时无需额外操作。";
  if (item?.workflow?.status === "release_ready") return "已到本地预发完成阶段，可转发物审核。";
  return "当前没有额外问题。";
}

function appendMessage(path, key, value) {
  const url = new URL(path || "/", "http://127.0.0.1");
  url.searchParams.set(key, String(value || "").slice(0, 500));
  return `${url.pathname}${url.search}${url.hash}`;
}

function actionErrorMessage(error) {
  const text = String(error?.message || error || "").trim();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (/AgentPreAudit is invalid:|Automatic publication blocked and quarantined:|No locale has an approved publication jurisdiction|Requested locale is missing from content item:/.test(line) && !line.includes("${")) {
      return line.replace(/^Error:\s*/, "");
    }
  }
  const preferred = lines.find((line) => line.startsWith("Error: "));
  if (preferred) return preferred.replace(/^Error:\s*/, "");
  return lines.at(-1) || "Unknown action error";
}

function routeForDetail(id) {
  return `/items/${encodeURIComponent(id)}`;
}

function routeForLegal(contentId = "", pack = "") {
  const query = new URLSearchParams();
  if (contentId) query.set("content", contentId);
  if (pack) query.set("pack", pack);
  const suffix = query.toString();
  return `/legal${suffix ? `?${suffix}` : ""}`;
}

function routeForManualLegalTask(path = "") {
  const name = basename(String(path || "").trim());
  return name ? `/private-legal-task/${encodeURIComponent(name)}` : "";
}

function retiredLegalEntryPage(state, notice, error, current = null) {
  const guidance = current?.guidance || null;
  const body = `
    <section class="header">
      <p class="eyebrow">EventAnalysis 审稿工作台</p>
      <h1 class="title">旧法务入口已停用</h1>
      <p class="subtitle">编辑侧不再单独处理律师、法务或资料包步骤。请回到当前稿件，直接执行页面提示的当前动作。</p>
    </section>
    <section class="panel tone-warn">
      <h2>现在该怎么做</h2>
      ${current ? `<p class="meta">当前稿件：${escapeHtml(current.edition.title)}</p>` : `<p class="meta">当前没有定位到具体稿件。</p>`}
      ${guidance ? `<p class="meta">当前阶段：${escapeHtml(guidance.stateLabel)}</p><p class="meta">下一步：${escapeHtml(guidance.nextStep)}</p>` : `<p class="meta">请回审稿队列选择当前稿件。</p>`}
      <div class="actions">
        <a class="action-button primary" href="${escapeHtml(current ? routeForDetail(current.id) : "/")}">${escapeHtml(current ? "返回当前稿件" : "返回审稿队列")}</a>
      </div>
    </section>`;
  return page({ title: "旧法务入口已停用", body, notice, error });
}

function actionButton({ action, file, label, returnTo, tone = "default" }) {
  return `<form method="post" action="/actions" class="action-form"><input type="hidden" name="action" value="${escapeHtml(action)}"><input type="hidden" name="file" value="${escapeHtml(file)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button class="action-button ${tone}" type="submit">${escapeHtml(label)}</button></form>`;
}

function itemPrimaryEntryAction(item, guidance, returnTo) {
  if (guidance?.primaryAction) return guidanceActionButton(item, guidance.primaryAction, returnTo, "primary");
  if (item?.workflow?.status === "release_blocked") return approveAndSubmitButton(item, returnTo);
  return "";
}

function buildReviewHtmlButton(item, returnTo) {
  return actionButton({ action: "build_review_html", file: item.file, label: "生成审稿 HTML", returnTo, tone: "primary" });
}

function releaseRequestButton(item, returnTo) {
  return actionButton({ action: "submit_release_zh", file: item.file, label: "提交中文发布申请", returnTo });
}

function approveAndSubmitButton(item, returnTo) {
  return actionButton({ action: "approve_and_submit_zh", file: item.file, label: "一键审稿通过", returnTo, tone: "primary" });
}

function prButton(item, returnTo) {
  return actionButton({ action: "review_pr", file: item.file, label: "创建草稿 PR", returnTo });
}

function workflowBadge(label, tone = "default") {
  return `<span class="pill ${tone}">${escapeHtml(label)}</span>`;
}

function guidanceActionButton(item, action, returnTo, tone = "default") {
  if (!action) return "";
  if (action.type === "link") return `<a class="action-button ${tone}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
  return actionButton({ action: action.action, file: item.file, label: action.label, returnTo, tone });
}

function renderGuidanceActions(item, returnTo, { primaryOnly = false } = {}) {
  const primary = guidanceActionButton(item, item.guidance?.primaryAction, returnTo, "primary");
  const secondary = primaryOnly ? "" : (item.guidance?.secondaryActions || []).map((action) => guidanceActionButton(item, action, returnTo)).join("");
  return `${primary}${secondary}`;
}

function renderProblemEntryLinks({
  item,
  guidance = null,
  legalHref = "",
  packAnchor = "",
  packLabel = "发布资料包",
  includeDetailLink = false,
  includeReviewPreview = false,
  includeOperatorAnchor = false,
}) {
  if (!item) return "";
  const links = [];
  if (legalHref) links.push(`<a class="action-button" href="${escapeHtml(legalHref)}">阻断处理页</a>`);
  if (includeOperatorAnchor) links.push(`<a class="action-button" href="#operator-jurisdiction-panel">发布主体辖区</a>`);
  if (packAnchor) links.push(`<a class="action-button" href="${escapeHtml(packAnchor)}">${escapeHtml(packLabel)}</a>`);
  if (includeDetailLink) links.push(`<a class="action-button" href="${escapeHtml(routeForDetail(item.id))}">稿件详情</a>`);
  if (includeReviewPreview) links.push(`<a class="action-button" href="${escapeHtml(dynamicReviewRoute(item.id))}">动态审稿页</a>`);
  return links.join("");
}

function renderWorkflowStageFlow(status = "") {
  const labels = [
    ["review_pending", "一键通过"],
    ["editorial_approved", "待流转"],
    ["release_requested", "预审中"],
    ["release_blocked", "阻断处理"],
    ["release_review_required", "人工复核"],
    ["release_ready", "本地预发完成"],
  ];
  return `<div class="status-flow">${labels.map(([value, label]) => `<span class="status-step ${value === status ? "current" : ""}">${escapeHtml(label)}</span>`).join("")}</div>`;
}

async function loadPrivateEvidenceInventory(baseDir) {
  const privateEvidenceDir = resolve(baseDir, "private-evidence");
  const privateLegalDir = resolve(baseDir, "private-legal");
  const legalSupportDir = resolve(baseDir, "private-legal/support");
  const legalSupportExamplePath = resolve(baseDir, "pipeline/config/legal-support.example.json");
  let privateEvidenceFiles = [];
  let privateLegalFiles = [];
  let legalSupportFiles = [];
  try {
    privateEvidenceFiles = (await readdir(privateEvidenceDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {}
  try {
    privateLegalFiles = (await readdir(privateLegalDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {}
  try {
    legalSupportFiles = (await readdir(legalSupportDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {}
  return {
    privateEvidenceCount: privateEvidenceFiles.length,
    privateEvidencePreview: privateEvidenceFiles.slice(0, 4),
    privateLegalFiles,
    legalSupportCount: legalSupportFiles.length,
    legalSupportPreview: legalSupportFiles.slice(0, 4),
    legalSupportDir,
    legalSupportExamplePath,
  };
}

async function loadLegalSupportEntries(baseDir) {
  const supportDir = resolve(baseDir, "private-legal/support");
  const entries = [];
  const errors = [];
  const files = await readdir(supportDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of files.filter((value) => value.isFile() && value.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(supportDir, entry.name);
    const fallbackJurisdiction = entry.name.replace(/\.json$/i, "");
    try {
      const value = await readJson(path);
      const normalized = normalizeLegalSupportRecord(value, fallbackJurisdiction);
      entries.push({
        name: entry.name,
        path,
        jurisdiction: normalized.jurisdiction,
        normalized,
      });
    } catch (error) {
      errors.push({ name: entry.name, path, message: String(error?.message || error) });
    }
  }
  const byJurisdiction = new Map(entries.map((entry) => [entry.jurisdiction, entry]));
  const operatorDetection = detectOperatorJurisdictionFromSupportRecords(entries.map((entry) => entry.normalized));
  return {
    supportDir,
    entries,
    errors,
    byJurisdiction,
    operatorDetection,
  };
}

function legalSupportPath(baseDir, jurisdiction) {
  return resolve(baseDir, "private-legal/support", `${String(jurisdiction || "").trim().toUpperCase()}.json`);
}

async function createLegalSupportTemplate(baseDir, registry, jurisdiction, { operatorJurisdiction = false } = {}) {
  const code = String(jurisdiction || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") throw new Error("生成 support 骨架前需要真实的两位辖区代码");
  const path = legalSupportPath(baseDir, code);
  try {
    await access(path);
    throw new Error(`${code}.json 已存在于 private-legal/support，请直接编辑该文件`);
  } catch (error) {
    if (error?.message?.includes("已存在于 private-legal/support")) throw error;
    if (error?.code && error.code !== "ENOENT") throw error;
  }
  const existingPack = registry.packs?.find((entry) => entry.jurisdiction === code) || null;
  const template = buildLegalSupportTemplate(existingPack, code, { operatorJurisdiction });
  await writePrivateJson(path, template);
  return { path, template };
}

async function syncSupportFileFromPack(baseDir, registry, jurisdiction) {
  const code = String(jurisdiction || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") throw new Error("同步 support 前需要真实的两位辖区代码");
  const pack = registry.packs?.find((entry) => entry.jurisdiction === code) || null;
  if (!pack) throw new Error(`未找到 ${code} 的 legal pack，无法同步 support`);
  const path = legalSupportPath(baseDir, code);
  const template = buildLegalSupportTemplate(pack, code, {
    operatorJurisdiction: (registry.operatorJurisdictions || []).includes(code),
  });
  await writePrivateJson(path, template);
  return { path, template };
}

async function bootstrapLegalSupportTemplates(baseDir, registry, jurisdictions = [], { operatorJurisdiction = "" } = {}) {
  const created = [];
  const skipped = [];
  const unique = [...new Set((jurisdictions || []).map((value) => String(value || "").trim().toUpperCase()).filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
  const operatorCode = String(operatorJurisdiction || "").trim().toUpperCase();
  for (const jurisdiction of unique) {
    const path = legalSupportPath(baseDir, jurisdiction);
    try {
      await access(path);
      skipped.push(jurisdiction);
      continue;
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
    }
    const createdEntry = await createLegalSupportTemplate(baseDir, registry, jurisdiction, { operatorJurisdiction: jurisdiction === operatorCode });
    created.push({ jurisdiction, path: createdEntry.path });
  }
  return { created, skipped };
}

function page({ title, body, notice = "", error = "" }) {
  const autoRefreshSeconds = body.includes("data-auto-refresh=\"true\"") ? 5 : 0;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>${autoRefreshSeconds ? `<meta http-equiv="refresh" content="${autoRefreshSeconds}">` : ""}<style>
  :root {
    --bg: #f4efe5;
    --panel: #fffaf0;
    --ink: #1e1f1c;
    --muted: #5d6058;
    --line: #d6cdb8;
    --accent: #1e5c46;
    --accent-soft: #dcebdd;
    --warn: #9b5a17;
    --warn-soft: #f7e8d4;
    --danger: #8c2f2f;
    --danger-soft: #f7dede;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "PingFang SC","Noto Serif SC","Source Han Serif SC",serif; background: radial-gradient(circle at top, #fbf6ea 0, var(--bg) 48%, #eee4d0 100%); color: var(--ink); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .shell { width: min(1200px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 40px; }
  .header { display: grid; gap: 10px; padding: 24px 0 12px; }
  .title { margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 0.95; letter-spacing: -0.03em; }
  .subtitle { margin: 0; max-width: 760px; color: var(--muted); font-size: 1rem; line-height: 1.65; }
  .banner { margin: 16px 0 20px; padding: 14px 16px; border: 1px solid var(--line); background: var(--panel); }
  .banner.error { border-color: #d8aaaa; background: #fff0f0; color: #6d2020; }
  .grid { display: grid; gap: 18px; }
  .summary { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .panel { background: color-mix(in srgb, var(--panel) 94%, white 6%); border: 1px solid var(--line); padding: 16px; }
  .panel h2, .panel h3 { margin: 0 0 12px; font-size: 1rem; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .kpi { font-size: 2rem; line-height: 1; margin: 0 0 6px; }
  .meta { color: var(--muted); font-size: 0.95rem; line-height: 1.55; }
  .readiness { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .diagnostics { display: grid; gap: 18px; grid-template-columns: 1fr; }
  .tone-ok { background: var(--accent-soft); border-color: #b7d3b9; }
  .tone-warn { background: var(--warn-soft); border-color: #e8c691; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 14px 10px; vertical-align: top; border-top: 1px solid var(--line); text-align: left; }
  .table th { color: var(--muted); font-size: 0.9rem; font-weight: 600; }
  .pill { display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: 0.85rem; background: rgba(255,255,255,0.45); }
  .pill.warn { border-color: #c89b58; color: #8f560b; }
  .pill.ok { border-color: #7cad88; color: #184c39; }
  .stack { display: grid; gap: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .action-form { margin: 0; }
  .action-button { appearance: none; border: 1px solid var(--line); background: rgba(255,255,255,0.6); color: var(--ink); padding: 9px 12px; font: inherit; cursor: pointer; }
  .action-button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  .action-button.warn { border-color: #c89b58; color: #8f560b; }
  .action-button.danger { border-color: #ca8b8b; color: var(--danger); }
  .chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .details-block { margin-top: 14px; }
  .details-block summary { cursor: pointer; color: var(--accent); }
  .list { margin: 0; padding-left: 18px; }
  .list li { margin: 0 0 6px; }
  .queue-list { display: grid; gap: 14px; }
  .queue-card { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--line); background: rgba(255,255,255,0.34); }
  .queue-card.current { background: rgba(255,255,255,0.56); border-color: #c9bea5; }
  .queue-main { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
  .queue-title { font-size: 1.1rem; line-height: 1.45; color: var(--ink); }
  .queue-badges { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .queue-info { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .queue-info.focus { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) minmax(0, 0.95fr); }
  .queue-label { font-size: 0.95rem; }
  .queue-actions { padding-top: 4px; border-top: 1px solid var(--line); }
  .queue-compact { display: grid; gap: 10px; }
  .flow-block { display: grid; gap: 8px; }
  .flow-title { font-size: 0.92rem; color: var(--muted); }
  .flow-text { font-size: 1rem; line-height: 1.55; }
  .status-flow { display: flex; flex-wrap: wrap; gap: 8px; }
  .status-step { display: inline-flex; align-items: center; padding: 5px 10px; border: 1px dashed var(--line); border-radius: 999px; color: var(--muted); font-size: 0.84rem; }
  .status-step.current { border-style: solid; border-color: #7cad88; background: rgba(220,235,221,0.9); color: #184c39; }
  .inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: rgba(255,255,255,0.5); padding: 2px 6px; border: 1px solid var(--line); }
  .resolve-panel { display: grid; gap: 14px; }
  .resolve-list { display: grid; gap: 10px; margin: 0; }
  .resolve-item { padding: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.45); }
  .resolve-item.tight { padding: 10px 12px; }
  .form-grid { display: grid; gap: 10px; }
  .form-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .text-input { width: 100%; max-width: 180px; padding: 9px 10px; border: 1px solid var(--line); background: rgba(255,255,255,0.7); font: inherit; color: var(--ink); text-transform: uppercase; }
  .text-input.wide { max-width: none; text-transform: none; }
  .text-area { width: 100%; min-height: 92px; padding: 9px 10px; border: 1px solid var(--line); background: rgba(255,255,255,0.7); font: inherit; color: var(--ink); }
  .select-input { min-width: 140px; padding: 9px 10px; border: 1px solid var(--line); background: rgba(255,255,255,0.7); font: inherit; color: var(--ink); }
  .text-input.invalid, .text-area.invalid, .select-input.invalid { border-color: #c89b58; background: #fff4e6; }
  .label-warn { color: #8f560b; font-weight: 700; }
  .field-help { margin: -4px 0 4px; color: #8f560b; font-size: 0.88rem; line-height: 1.45; }
  .code-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .code-pill { display: inline-flex; align-items: center; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.6); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
  .processing-note { color: var(--warn); font-size: 0.92rem; }
  .pack-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .detail { display: grid; grid-template-columns: minmax(320px, 0.95fr) minmax(0, 1.45fr); gap: 18px; align-items: start; }
  .article { display: grid; gap: 18px; }
  .article h2 { font-size: 1.25rem; margin: 0 0 10px; }
  .article h3 { font-size: 1rem; margin: 0 0 8px; }
  .article p { margin: 0 0 12px; line-height: 1.8; }
  .hero { padding: 20px; background: linear-gradient(135deg, rgba(30,92,70,0.09), rgba(255,250,240,0.96)); border: 1px solid var(--line); }
  .hero h1 { margin: 0 0 10px; font-size: clamp(1.8rem, 2.8vw, 3rem); line-height: 1.06; }
  .eyebrow { color: var(--muted); margin: 0 0 6px; font-size: 0.95rem; }
  .timeline-item { display: grid; grid-template-columns: 76px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
  .timeline-item:first-child { border-top: 0; padding-top: 0; }
  .minute { color: var(--accent); font-weight: 700; }
  .claim { padding: 10px 0; border-top: 1px solid var(--line); }
  .claim:first-child { border-top: 0; padding-top: 0; }
  .footnote { margin-top: 20px; color: var(--muted); font-size: 0.92rem; line-height: 1.6; }
  .current-badge { display: inline-flex; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.7); border: 1px solid var(--line); font-size: 0.82rem; }
  .review-materials { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 960px) {
    .diagnostics { grid-template-columns: 1fr; }
    .queue-main { flex-direction: column; }
    .queue-badges { justify-content: flex-start; }
    .queue-info { grid-template-columns: 1fr; }
    .queue-info.focus { grid-template-columns: 1fr; }
    .detail { grid-template-columns: 1fr; }
  }
  </style></head><body><main class="shell">${notice ? `<div class="banner">${escapeHtml(notice)}</div>` : ""}${error ? `<div class="banner error">${escapeHtml(error)}</div>` : ""}${body}</main></body></html>`;
}

function reviewLinks(item) {
  const links = [`<a href="${escapeHtml(dynamicReviewRoute(item.id))}">动态审稿页</a>`];
  if (item.readiness.reviewHtmlBuilt && item.workflow.preview?.reviewHtmlRoute) links.push(`<a href="${escapeHtml(item.workflow.preview.reviewHtmlRoute)}">静态 HTML</a>`);
  else links.push("静态 HTML 未生成");
  if (item.readiness.previewBuilt) links.push(`<a href="/preview${escapeHtml(item.readiness.previewPath)}">中文预发页</a>`);
  else links.push("中文预发页未生成");
  return links.map((value) => `<span class="meta">${value}</span>`).join("");
}

function legalPackDefinition() {
  return "这不是稿件正文，而是后台发布检查使用的私有发布资料包，内部字段名叫 legal pack。它至少要有官方依据哈希、审阅时间、失效时间和签名哈希；只有校验通过并处于 active，才会放行对应发布。";
}

function blockerReasonText(reason) {
  return {
    invalid_jurisdiction: "辖区未确认",
    invalid_official_sources: "官方依据缺失",
    invalid_reviewed_at: "审阅时间无效",
    missing_counsel_signature: "缺本地律师签名",
    pack_expired: "发布资料包已过期",
    pack_not_active: "发布资料包未激活",
    pack_too_long: "有效期超策略",
  }[reason] || reason;
}

function summarizePublicationFailures(failures) {
  const invalidJurisdictions = [];
  const reasonCounts = new Map();
  let publishingEntityJurisdictionUnconfirmed = false;
  for (const failure of failures || []) {
    if (failure === "publishing_entity_jurisdiction_unconfirmed") {
      publishingEntityJurisdictionUnconfirmed = true;
      continue;
    }
    if (!failure.startsWith("legal_pack_invalid:")) continue;
    const [, jurisdiction = "", reasons = ""] = failure.split(":");
    invalidJurisdictions.push(jurisdiction);
    for (const reason of reasons.split(",").filter(Boolean)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count, label: blockerReasonText(reason) }));
  return {
    invalidJurisdictions,
    invalidJurisdictionCount: invalidJurisdictions.length,
    publishingEntityJurisdictionUnconfirmed,
    topReasons,
  };
}

function findingsList(findings) {
  if (!findings?.length) return "<p class=\"meta\">当前没有记录到发布阻断项。</p>";
  return `<ul class="list">${findings.map((finding) => {
    const line = [
      finding.code,
      finding.jurisdiction ? `jurisdiction=${finding.jurisdiction}` : null,
      Array.isArray(finding.reasons) && finding.reasons.length ? `reasons=${finding.reasons.join(",")}` : null,
      finding.locale ? `locale=${finding.locale}` : null,
      finding.factId ? `fact=${finding.factId}` : null,
    ].filter(Boolean).join(" · ");
    return `<li>${escapeHtml(line || JSON.stringify(finding))}</li>`;
  }).join("")}</ul>`;
}

function legalStepBadge(done) {
  return `<span class="pill ${done ? "ok" : "warn"}">${done ? "已完成" : "待处理"}</span>`;
}

function currentFlowBadge(active) {
  return active ? `<span class="pill ok">当前</span>` : "";
}

function currentLegalStepNumber(stage = "") {
  return {
    operator: 1,
    drafts: 2,
    support: 3,
    pack: 4,
    retry: 5,
    detail: 5,
  }[stage] || 0;
}

function validationFieldStates(validation = null) {
  const reasons = new Set(validation?.findings || []);
  const counselInvalid = reasons.has("missing_counsel_signature");
  return {
    status: reasons.has("pack_not_active"),
    reviewedAt: reasons.has("invalid_reviewed_at"),
    expiresAt: reasons.has("pack_expired") || reasons.has("pack_too_long"),
    counsel: counselInvalid,
    officialSources: reasons.has("invalid_official_sources"),
  };
}

function fieldClass(baseClass, invalid) {
  return `${baseClass}${invalid ? " invalid" : ""}`;
}

function labelClass(invalid) {
  return invalid ? "meta label-warn" : "meta";
}

function fieldHelp(show, text) {
  return show ? `<p class="field-help">${escapeHtml(text)}</p>` : "";
}

function hiddenField(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${textValue(value)}">`;
}

function supportEntryHasMaterial(entry = null) {
  const normalized = entry?.normalized || {};
  return Boolean(
    String(normalized.reviewedAt || "").trim()
    || String(normalized.expiresAt || "").trim()
    || String(normalized.counselName || "").trim()
    || String(normalized.counselBarJurisdiction || "").trim()
    || String(normalized.counselSignatureHash || "").trim()
    || parseOfficialSourcesInput(normalized.officialSourcesText || "").length
  );
}

function textValue(value) {
  return escapeHtml(value == null ? "" : value);
}

function serializeUrlLines(urls = []) {
  return (urls || []).map((value) => String(value || "").trim()).filter(Boolean).join("\n");
}

function renderStepAction(action, tone = "primary") {
  if (!action) return "";
  if (action.type === "form") {
    return actionButton({ action: action.action, file: action.file, label: action.label, returnTo: action.returnTo || "/", tone });
  }
  return `<a class="action-button ${tone}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
}

function buildBlockedItemResolutionStep({
  item,
  operatorConfirmed,
  operatorSupportDetectedJurisdiction = "",
  operatorReport = null,
  currentCanRetry,
  currentNeedsDrafts,
  currentMissingDraftCodes,
  currentNeedsSupport,
  currentMissingSupportCodes,
  currentPrimarySupportCode,
  currentSupportReadyToImport,
  currentBlockedJurisdictions,
  currentPrimaryPackCode,
  focusedReturnTo,
  surface = "legal",
}) {
  const surfaceReturnTo = surface === "legal" ? focusedReturnTo : "/";
  const operatorManualRequired = !operatorConfirmed
    && !operatorSupportDetectedJurisdiction
    && Boolean(operatorReport)
    && !operatorReport.detectedJurisdiction;
  if (currentCanRetry) {
    return {
      title: "当前真正下一步：重新提交这篇稿件",
      detail: "这篇稿件当前阻断条件已解除，可以重新跑独立预审与本地预发。",
      primaryAction: {
        type: "form",
        action: "submit_release_zh",
        file: item.file,
        label: "重新提交中文发布申请",
        returnTo: surfaceReturnTo,
      },
    };
  }
  if (!operatorConfirmed) {
    return {
      title: "当前真正下一步：先确认发布主体辖区",
      detail: operatorSupportDetectedJurisdiction
        ? `support 材料里已经唯一标记 ${operatorSupportDetectedJurisdiction} 为发布主体辖区，可以先直接导入；如果这不是你确认的真实主体，再去手工改。`
        : operatorManualRequired
          ? "自动识别已经跑过，但公开页面仍没有唯一明确的主体辖区证据。下一步请直接进入手工确认入口，或补更强的公开证据 URL。"
        : "在发布主体辖区仍是 ZZ 之前，这篇稿件不会进入可发布状态。系统会先自动尝试识别主体辖区、补 draft、生成 support 骨架；如果公开页面没有唯一明确证据，再停到手工确认入口。",
      primaryAction: surface === "legal"
        ? operatorManualRequired
          ? { type: "link", href: "#operator-jurisdiction-panel", label: "发布主体辖区" }
          : { type: "form", action: "autofix_release_blockers", file: item.file, label: "先自动处理当前阻断", returnTo: surfaceReturnTo }
        : { type: "link", href: routeForDetail(item.id), label: "去当前稿件继续处理" },
    };
  }
  if (currentNeedsDrafts) {
    return {
      title: "当前真正下一步：先为这篇稿件生成 draft legal pack",
      detail: `这篇稿件还缺 ${currentMissingDraftCodes.join("、")} 的 pack 记录。系统可以先自动补骨架，再继续导入 support 或把你带到人工录入入口。`,
      primaryAction: {
        type: "form",
        action: surface === "legal" ? "autofix_release_blockers" : "bootstrap_legal_drafts",
        file: surface === "legal" ? item.file : "",
        label: surface === "legal" ? "先自动处理当前阻断" : "为本稿生成 draft legal pack",
        returnTo: surfaceReturnTo,
      },
      extraHiddenInputs: surface === "legal" ? null : {
        jurisdictions: currentBlockedJurisdictions.join(","),
      },
    };
  }
  if (currentNeedsSupport) {
    if (currentSupportReadyToImport && currentPrimarySupportCode) {
      return {
        title: `当前真正下一步：先导入 ${currentPrimarySupportCode} 的 support 材料`,
        detail: "该辖区的 support 文件里已经有真实字段。系统可以直接导入，再继续校验剩余缺口。",
        primaryAction: {
          type: "form",
          action: surface === "legal" ? "autofix_release_blockers" : "import_legal_support_pack",
          file: surface === "legal" ? item.file : "",
          label: surface === "legal" ? "先自动处理当前阻断" : `导入 ${currentPrimarySupportCode} support 到 legal pack`,
          returnTo: surfaceReturnTo,
        },
        extraHiddenInputs: surface === "legal" ? null : {
          jurisdiction: currentPrimarySupportCode,
        },
      };
    }
    return {
      title: "当前真正下一步：先补 support 材料骨架",
      detail: `当前稿件还缺 ${currentMissingSupportCodes.join("、")} 的 support 文件。系统可以先自动生成骨架，再把必须人工提供的真实律师、日期和官方依据留给你。`,
      primaryAction: {
        type: "form",
        action: surface === "legal" ? "autofix_release_blockers" : "bootstrap_legal_support_templates",
        file: surface === "legal" ? item.file : "",
        label: surface === "legal" ? "先自动处理当前阻断" : "为当前稿件生成 support 骨架",
        returnTo: surfaceReturnTo,
      },
      extraHiddenInputs: surface === "legal" ? null : {
        jurisdictions: currentMissingSupportCodes.join(","),
      },
    };
  }
  if (currentPrimaryPackCode) {
    return {
      title: `当前真正下一步：先补 ${currentPrimaryPackCode} 的发布资料包`,
      detail: "系统已自动做到上限：draft 已有，但还缺真实的官方来源、日期或律师签名哈希。先补完当前焦点辖区，再回来重提。",
      primaryAction: surface === "legal"
        ? { type: "link", href: `#pack-${currentPrimaryPackCode}`, label: `去补 ${currentPrimaryPackCode} 发布资料包` }
        : { type: "link", href: routeForDetail(item.id), label: "去当前稿件继续处理" },
    };
  }
  return {
    title: "当前真正下一步：回稿件详情检查剩余阻断",
    detail: "当前没有额外可自动执行的动作，先回稿件详情核对事实或工作流说明。",
    primaryAction: { type: "link", href: routeForDetail(item.id), label: "回稿件详情" },
  };
}

function renderBlockedDraftAction(step) {
  if (!step?.extraHiddenInputs || step.primaryAction?.type !== "form") {
    return renderStepAction(step?.primaryAction);
  }
  return `<form method="post" action="/actions" class="action-form">
    <input type="hidden" name="action" value="${escapeHtml(step.primaryAction.action || "")}">
    <input type="hidden" name="returnTo" value="${escapeHtml(step.primaryAction.returnTo || "/")}">
    ${Object.entries(step.extraHiddenInputs).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value || "")}">`).join("")}
    <button class="action-button primary" type="submit">${escapeHtml(step.primaryAction.label)}</button>
  </form>`;
}

function dashboardNextStep(state) {
  const scored = state.items.map((item) => {
    const guidance = item.guidance || buildItemWorkflowGuidance(item, state.registry, {
      packValidation: state.packValidation,
      operatorJurisdictionReport: state.operatorJurisdictionReport,
      supportByJurisdiction: state.supportSummary?.byJurisdiction,
    });
    const action = guidance.primaryAction || null;
    const actionKey = action?.type === "form" ? action.action : action?.type === "link" ? action.label : "";
    const rank = {
      approve_and_submit_zh: 0,
      submit_release_zh: 1,
      review_pr: 2,
      build_review_html: 3,
      "去补事实包": 4,
      "查看详情": 5,
      "": 6,
    }[actionKey] ?? 7;
    const factGapCount = item.metrics?.missing?.length || 0;
    return { item, guidance, rank, factGapCount };
  }).sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.factGapCount !== right.factGapCount) return left.factGapCount - right.factGapCount;
    return left.item.id.localeCompare(right.item.id);
  });
  const current = scored[0];
  if (current) {
    const fallbackAction = { type: "link", href: routeForDetail(current.item.id), label: "查看详情" };
    const title = current.guidance.nextStep;
    return {
      title,
      detail: current.guidance.why,
      item: current.item,
      action: current.guidance.primaryAction?.type === "form"
        ? { ...current.guidance.primaryAction, file: current.guidance.primaryAction.file || current.item.file, returnTo: current.guidance.primaryAction.returnTo || "/" }
        : (current.guidance.primaryAction || fallbackAction),
    };
  }
  return null;
}

function serializeOfficialSourceUrls(sources = []) {
  return (sources || []).map((source) => source?.url || "").filter(Boolean).join("\n");
}

async function fetchOfficialSources(urls = [], now = new Date()) {
  const results = [];
  for (const originalUrl of urls) {
    const url = String(originalUrl || "").trim();
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`官方来源 URL 无效：${url}`);
    }
    if (parsed.protocol !== "https:") throw new Error(`官方来源必须使用 https：${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal });
      if ([401, 403, 429].includes(response.status)) throw new Error(`官方来源 ${url} 返回 ${response.status}，按策略停止`);
      if (!response.ok) throw new Error(`官方来源 ${url} 返回 ${response.status}，无法自动抓取`);
      const buffer = Buffer.from(await response.arrayBuffer());
      results.push({
        url: response.url || url,
        checkedAt: now.toISOString(),
        contentHash: createHash("sha256").update(buffer).digest("hex"),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`官方来源 ${url} 抓取超时，按策略停止`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

export {
  defaultLegalFocus,
  fetchOfficialSources,
  manualLegalTaskKey,
  manualLegalTaskNextLabel,
  manualLegalTaskNextStatus,
  manualLegalTaskStatusLabel,
  updateManualLegalTaskRegistry,
};

const OPERATOR_JURISDICTION_SEED_URLS = [
  "https://eventanalysis.org/en/football/legal/",
  "https://eventanalysis.org/en/football/",
  "https://eventanalysis.org/",
];

const OPERATOR_JURISDICTION_URL_HINTS = ["legal", "privacy", "terms", "about", "contact", "imprint", "notice", "policy", "corrections"];

function shouldInspectOperatorEvidenceUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "eventanalysis.org") return false;
    const path = url.pathname.toLowerCase();
    return OPERATOR_JURISDICTION_URL_HINTS.some((hint) => path.includes(hint));
  } catch {
    return false;
  }
}

function collectOperatorEvidenceUrls(html = "", baseUrl = "") {
  const urls = new Set();
  const patterns = [
    /href=["']([^"'#]+)["']/gi,
    /content=["'](https:\/\/eventanalysis\.org[^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of String(html || "").matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      try {
        const absolute = new URL(raw, baseUrl).toString();
        if (shouldInspectOperatorEvidenceUrl(absolute)) urls.add(absolute);
      } catch {}
    }
  }
  return [...urls].sort();
}

async function fetchOperatorJurisdictionEvidence() {
  const queue = [...OPERATOR_JURISDICTION_SEED_URLS];
  const seen = new Set();
  const results = [];
  while (queue.length && results.length < 12) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal });
      if ([401, 403, 429].includes(response.status)) throw new Error(`发布主体识别来源 ${url} 返回 ${response.status}，按策略停止`);
      const text = response.ok ? await response.text() : "";
      results.push({
        url,
        finalUrl: response.url || url,
        status: response.status,
        text,
      });
      if (response.ok) {
        for (const discovered of collectOperatorEvidenceUrls(text, response.url || url)) {
          if (!seen.has(discovered)) queue.push(discovered);
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`发布主体识别来源 ${url} 抓取超时，按策略停止`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

async function fetchOperatorJurisdictionEvidenceFromUrls(urls = []) {
  const results = [];
  for (const originalUrl of urls) {
    const url = String(originalUrl || "").trim();
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`发布主体识别 URL 无效：${url}`);
    }
    if (parsed.protocol !== "https:") throw new Error(`发布主体识别 URL 必须使用 https：${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal });
      if ([401, 403, 429].includes(response.status)) throw new Error(`发布主体识别来源 ${url} 返回 ${response.status}，按策略停止`);
      results.push({
        url,
        finalUrl: response.url || url,
        status: response.status,
        text: response.ok ? await response.text() : "",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`发布主体识别来源 ${url} 抓取超时，按策略停止`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

function dashboardPage(state, notice, error) {
  const hasActiveProcessing = state.workflowCounts.release_requested > 0;
  const nextStep = dashboardNextStep(state);
  const focusItem = nextStep?.item || state.items[0] || null;
  const focusGuidance = focusItem
    ? (focusItem.guidance || buildItemWorkflowGuidance(focusItem, state.registry, {
      packValidation: state.packValidation,
      operatorJurisdictionReport: state.operatorJurisdictionReport,
      supportByJurisdiction: state.supportSummary?.byJurisdiction,
    }))
    : null;
  const focusProblemEntryLinks = focusItem
    ? renderProblemEntryLinks({
      item: focusItem,
      guidance: focusGuidance,
      includeDetailLink: true,
      includeReviewPreview: true,
    })
    : "";
  const blockedCount = state.workflowCounts.release_blocked;
  const queueCards = state.items.map((item) => {
    const isFocus = focusItem?.id === item.id;
    const guidance = item.guidance || buildItemWorkflowGuidance(item, state.registry, {
      packValidation: state.packValidation,
      operatorJurisdictionReport: state.operatorJurisdictionReport,
      supportByJurisdiction: state.supportSummary?.byJurisdiction,
    });
    const surfaceStage = editorSurfaceStageText(item, guidance);
    const reviewLinks = [
      `<a href="${escapeHtml(dynamicReviewRoute(item.id))}">动态审稿页</a>`,
      item.readiness.reviewHtmlBuilt ? `<a href="${escapeHtml(reviewHtmlRoute(item.id))}">静态 HTML</a>` : "",
      item.readiness.previewBuilt ? `<a href="/preview${escapeHtml(item.readiness.previewPath)}">中文预发页</a>` : "",
      `<a href="${escapeHtml(routeForDetail(item.id))}">稿件详情</a>`,
    ].filter(Boolean).join(" · ");
    return `<article class="queue-card ${isFocus ? "current" : ""}">
        <div class="stack">
          <a class="queue-title" href="${routeForDetail(item.id)}">${escapeHtml(item.edition.title)}</a>
          <span class="meta">${escapeHtml(item.edition.homeName)} vs ${escapeHtml(item.edition.awayName)} · ${escapeHtml(item.edition.competition || "未标注赛事")}</span>
          <div class="queue-badges">
            ${workflowBadge(lifecycleStatusText(item.workflow?.lifecycle?.status || "draft"))}
            ${workflowBadge(surfaceStage)}
            ${workflowBadge(workflowStatusText(item.workflow.status), workflowTone(item.workflow.status))}
          </div>
          ${isFocus ? `<span class="meta">这是当前焦点稿件。主动作只保留在上方“当前建议动作”。</span>` : ""}
          <span class="meta">生命周期状态: ${escapeHtml(lifecycleStatusText(item.workflow?.lifecycle?.status || "draft"))}</span>
          <span class="meta">当前阶段: ${escapeHtml(guidance.stateLabel)}</span>
          <span class="meta">下一步: ${escapeHtml(guidance.nextStep)}</span>
          <span class="meta">当前情况: ${escapeHtml(editorVisibleWorkflowSummary(item, guidance))}</span>
          <span class="meta">事实包缺口: ${escapeHtml(item.metrics.missing.length ? item.metrics.missing.join("、") : "无")}</span>
          <span class="meta">双源确认: ${escapeHtml(item.metrics.coreSourceConfirmations ?? "未记录")}</span>
          <span class="meta">问题入口: ${escapeHtml(editorVisibleQueueIssue(item, guidance))}</span>
          <p class="meta">审稿材料: ${reviewLinks}</p>
          ${isFocus ? "" : `<p class="meta"><a href="${escapeHtml(routeForDetail(item.id))}">查看这篇稿件详情</a></p>`}
        </div>
    </article>`;
  }).join("");
  const body = `
    <section class="header" ${hasActiveProcessing ? "data-auto-refresh=\"true\"" : ""}>
      <p class="eyebrow">EventAnalysis 审稿工作台</p>
      <h1 class="title">中文审稿、一键通过、系统发布检查</h1>
      <p class="subtitle">编辑侧只保留一个核心动作：<code>一键审稿通过</code>。点击后系统会自动批准中文、补生成私有审稿材料，并在后台继续做预审和中文本地预发；没过也只会记成系统中断，不会公开发布。</p>
      ${hasActiveProcessing ? `<p class="processing-note">检测到发布申请正在处理中，页面每 5 秒自动刷新一次。</p>` : ""}
    </section>
    ${nextStep && focusItem && focusGuidance ? `<section class="panel tone-${state.readiness.publicationStatus === "PASS" ? "ok" : "warn"}">
      <p class="eyebrow">当前建议动作</p>
      <h2>《${escapeHtml(focusItem.edition.title)}》</h2>
      <p class="meta">${escapeHtml(focusItem.edition.homeName)} vs ${escapeHtml(focusItem.edition.awayName)} · ${escapeHtml(focusItem.edition.competition || "未标注赛事")}</p>
      ${renderWorkflowStageFlow(focusItem.workflow.status)}
      <div class="resolve-list">
        <div class="resolve-item">
          <strong class="flow-title">当前状态</strong>
          <p class="flow-text">${escapeHtml(focusGuidance.stateLabel)}</p>
          <p class="meta">${escapeHtml(editorVisibleWorkflowSummary(focusItem, focusGuidance))}</p>
        </div>
        <div class="resolve-item">
          <strong class="flow-title">下一步只做这一件事</strong>
          <p class="flow-text">${escapeHtml(nextStep.title)}</p>
          <p class="meta">${escapeHtml(editorVisibleWorkflowSummary(focusItem, focusGuidance))}</p>
          <div class="actions">${renderStepAction(nextStep.action)}</div>
        </div>
        <div class="resolve-item">
          <strong class="flow-title">审稿材料</strong>
          <div class="review-materials">
            <a class="action-button" href="${escapeHtml(dynamicReviewRoute(focusItem.id))}">动态审稿页</a>
            ${focusItem.readiness.reviewHtmlBuilt ? `<a class="action-button" href="${escapeHtml(reviewHtmlRoute(focusItem.id))}">静态 HTML</a>` : ""}
            <a class="action-button" href="${escapeHtml(routeForDetail(focusItem.id))}">稿件详情</a>
          </div>
          <p class="meta">事实包缺口: ${escapeHtml(focusItem.metrics.missing.length ? focusItem.metrics.missing.join("、") : "无")}</p>
          <p class="meta">双源确认: ${escapeHtml(focusItem.metrics.coreSourceConfirmations ?? "未记录")}</p>
        </div>
        <div class="resolve-item">
          <strong class="flow-title">遇到问题时直接进这里</strong>
          ${focusProblemEntryLinks ? `<div class="actions">${focusProblemEntryLinks}</div>` : `<p class="meta">当前没有额外问题入口。</p>`}
        </div>
      </div>
    </section>` : ""}
    <section class="grid summary">
      <article class="panel"><p class="kpi">${state.workflowCounts.total}</p><p class="meta">当前审稿候选</p></article>
      <article class="panel"><p class="kpi">${state.workflowCounts.review_pending}</p><p class="meta">待编辑一键通过</p></article>
      <article class="panel"><p class="kpi">${state.workflowCounts.release_requested}</p><p class="meta">发布申请处理中</p></article>
      <article class="panel"><p class="kpi">${blockedCount}</p><p class="meta">系统中断（未发布）</p></article>
      <article class="panel"><p class="kpi">${state.workflowCounts.release_review_required}</p><p class="meta">待人工复核</p></article>
      <article class="panel"><p class="kpi">${state.workflowCounts.release_ready}</p><p class="meta">本地预发完成</p></article>
      <article class="panel"><p class="kpi">${state.lifecycleCounts.edited_pending_publish}</p><p class="meta">已编辑待发布</p></article>
    </section>
    ${blockedCount ? `<section class="panel tone-warn">
      <h2>系统中断摘要</h2>
      <p class="meta">当前有 ${blockedCount} 篇稿件的后台检查没有通过，但公开站点都还没有发布。编辑侧只需要看当前动作、事实缺口和详情页里的问题入口。</p>
    </section>` : ""}
    <section class="panel">
      <h2>审稿队列</h2>
      <div class="queue-list">${queueCards || `<p class="meta">当前没有稿件。</p>`}</div>
    </section>
    <p class="footnote">说明：编辑侧只保留 <code>一键审稿通过</code>。后台若缺事实、授权或命令条件，会自动记为 <code>release_blocked</code>，但仍保持未公开发布。</p>`;
  return page({ title: "EventAnalysis 审稿工作台", body, notice, error });
}

function detailPage(state, notice, error) {
  const item = state.current;
  const guidance = item.guidance || buildItemWorkflowGuidance(item, state.registry, {
    operatorJurisdictionReport: state.operatorJurisdictionReport,
    supportByJurisdiction: state.supportSummary?.byJurisdiction,
  });
  const surfaceStage = editorSurfaceStageText(item, guidance);
  const hasActiveProcessing = item.workflow.status === "release_requested";
  const detailPrimaryAction = itemPrimaryEntryAction(item, guidance, routeForDetail(item.id));
  const problemEntryLinks = renderProblemEntryLinks({ item, guidance, includeReviewPreview: true });
  const continuity = item.metrics.continuity.length
    ? `<ul class="list">${item.metrics.continuity.map((entry) => `<li>${escapeHtml(entry.teamName)} 首发延续率 ${escapeHtml(entry.continuityRate)}%，共有 ${escapeHtml(entry.sharedStarters)}/${escapeHtml(entry.currentStarters)} 名首发连续出场</li>`).join("")}</ul>`
    : "<p class=\"meta\">未找到对应阵容延续数据。</p>";
  const missing = item.metrics.missing.length ? item.metrics.missing.map((value) => `<span class="pill warn">${escapeHtml(value)}</span>`).join(" ") : `<span class="pill ok">事实完整</span>`;
  const sections = item.edition.sections.map((section) => `<section class="panel"><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p><p class="meta">Claim: ${escapeHtml((paragraph.claimRefs || []).join(", "))}</p>`).join("")}</section>`).join("");
  const timeline = item.edition.timeline?.length
    ? item.edition.timeline.map((entry) => `<div class="timeline-item"><div class="minute">${escapeHtml(entry.minute)}</div><div><div>${escapeHtml(entry.label)}</div><div class="meta">Claim: ${escapeHtml((entry.claimRefs || []).join(", "))}</div></div></div>`).join("")
    : "<p class=\"meta\">此稿件没有时间线。</p>";
  const claims = item.item.claims?.length
    ? item.item.claims.map((claim) => `<div class="claim"><strong>${escapeHtml(claim.id)}</strong><div class="meta">${escapeHtml(claim.kind)} · ${escapeHtml((claim.factRefs || []).join(", "))}</div><p>${escapeHtml(claim.summary)}</p></div>`).join("")
    : "<p class=\"meta\">此稿件没有 claim。</p>";
  const body = `
    <section class="header" ${hasActiveProcessing ? "data-auto-refresh=\"true\"" : ""}>
      <p class="eyebrow"><a href="/">返回审稿队列</a></p>
      <h1 class="title">稿件详情</h1>
      <p class="subtitle">先看当前动作和下一步。稿件正文、事实摘要和后台原始记录仍然保留，但不是你现在必须先处理的部分。</p>
      ${hasActiveProcessing ? `<p class="processing-note">当前稿件的发布申请正在处理中，页面每 5 秒自动刷新一次。</p>` : ""}
    </section>
    <section class="hero">
      <p class="eyebrow">${escapeHtml(item.edition.competition || "未标注赛事")} · ${escapeHtml(surfaceStage)}</p>
      <h1>${escapeHtml(item.edition.title)}</h1>
      <p class="subtitle">${escapeHtml(item.edition.deck)}</p>
      <div class="actions">
        ${detailPrimaryAction}
      </div>
    </section>
    <section class="detail">
      <aside class="grid">
        <section class="panel tone-warn">
          <h3>当前唯一动作</h3>
          <p class="meta">当前阶段: ${escapeHtml(guidance.stateLabel)}</p>
          <p class="meta">下一步: ${escapeHtml(guidance.nextStep)}</p>
          <p class="meta">当前情况: ${escapeHtml(editorVisibleWorkflowSummary(item, guidance))}</p>
          <div class="actions">${detailPrimaryAction}</div>
          ${problemEntryLinks ? `<p class="meta">遇到问题时直接进这里</p><div class="actions">${problemEntryLinks}</div>` : ""}
        </section>
        <section class="panel">
          <h3>当前流转</h3>
          <p class="meta">生命周期状态: ${escapeHtml(lifecycleStatusText(item.workflow?.lifecycle?.status || "draft"))}</p>
          <p class="meta">编辑侧当前阶段: ${escapeHtml(surfaceStage)}</p>
          <p class="meta">发布申请状态: ${escapeHtml(workflowStatusText(item.workflow.status))}</p>
          <p class="meta">公开结果: ${escapeHtml(editorVisibleWorkflowSummary(item, guidance))}</p>
          <p class="meta">最近审阅: ${escapeHtml(formatDate(item.item.reviewedAt))}</p>
          <p class="meta">工作流更新时间: ${escapeHtml(formatDate(item.workflow.updatedAt))}</p>
        </section>
        <section class="panel">
          <h3>为什么会卡在这里</h3>
          ${guidance.blockers?.length ? `<ul class="list">${guidance.blockers.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul><p class="meta">这里按“如果你现在重新提交，系统会真实命中的阻断范围”来算，不再把旧报告里已经过时的范围混进当前操作清单。</p>` : `<p class="meta">${escapeHtml(guidance.why)}</p>`}
        </section>
        <section class="panel">
          <h3>审稿材料</h3>
          <p class="meta"><a href="${escapeHtml(dynamicReviewRoute(item.id))}">打开动态审稿页</a></p>
          <p class="meta">${item.readiness.reviewHtmlBuilt && item.workflow.preview?.reviewHtmlRoute ? `<a href="${escapeHtml(item.workflow.preview.reviewHtmlRoute)}">打开静态 HTML</a>` : "静态 HTML 尚未生成"}</p>
          <p class="meta">${item.readiness.previewBuilt ? `<a href="/preview${escapeHtml(item.readiness.previewPath)}">打开中文预发页</a>` : "中文预发页尚未生成"}</p>
        </section>
        <section class="panel">
          <h3>事实核查摘要</h3>
          <p class="meta">双源确认数: ${escapeHtml(item.metrics.coreSourceConfirmations ?? "未记录")}</p>
          <p class="meta">交锋样本数: ${escapeHtml(item.metrics.h2hMatches ?? "未记录")}</p>
          <div class="stack">${missing}</div>
        </section>
        <section class="panel">
          <h3>阵容延续</h3>
          ${continuity}
        </section>
        <details class="panel details-block">
          <summary>后台原始记录再展开</summary>
          <p class="meta">这里保留上一次发布申请失败时写入的原始阻断记录，用于审计追踪；它不一定等于你现在重提时仍需要处理的当前步骤。</p>
          ${findingsList(item.workflow.release?.findings)}
        </details>
        <section class="panel">
          <h3>比赛信息</h3>
          <p class="meta">${escapeHtml(item.edition.homeName)} vs ${escapeHtml(item.edition.awayName)}</p>
          <p class="meta">赛事时间: ${escapeHtml(formatDate(item.event?.startedAt || item.evidence?.match?.startedAt))}</p>
          <p class="meta">事实包状态: ${escapeHtml(item.evidence?.status || "未找到")}</p>
          <p class="meta">比分: ${escapeHtml(item.evidence?.match ? `${item.evidence.match.homeScore} - ${item.evidence.match.awayScore}` : item.edition.resultLabel || "未记录")}</p>
        </section>
        <details class="panel details-block">
          <summary>非当前动作再展开</summary>
          <p class="meta">这些按钮会改变工作流状态，但不是当前推荐的发布推进动作。</p>
          <div class="actions">
            ${actionButton({ action: "quarantine_zh", file: item.file, label: "隔离稿件", returnTo: routeForDetail(item.id), tone: "danger" })}
          </div>
        </details>
      </aside>
      <div class="article">
        <details class="panel details-block">
          <summary>稿件正文再展开</summary>
          ${sections}
        </details>
        <details class="panel details-block">
          <summary>时间线再展开</summary>
          ${timeline}
        </details>
        <details class="panel details-block">
          <summary>需要核对 Claims 时再展开</summary>
          ${claims}
        </details>
      </div>
    </section>`;
  return page({ title: item.edition.title, body, notice, error });
}

function legalPackStateText(validation) {
  if (!validation) return "未创建";
  const findings = (validation.findings || []).filter((reason) => reason !== "pack_not_active");
  if (!findings.length) return validation.ok ? "可用" : "待补齐真实字段后自动切到 active";
  return validation.ok ? "可用" : `无效：${findings.map((reason) => packRequirementText(reason)).join("；")}`;
}

function packRequirementText(reason) {
  return {
    invalid_jurisdiction: "辖区代码必须是已确认的两位国家/地区代码。",
    invalid_official_sources: "至少需要一条可访问的 https 官方来源。可以先填 URL，保存时系统会自动尝试补 checkedAt 与 contentHash。",
    invalid_reviewed_at: "需要填写有效的 reviewedAt 时间。",
    missing_counsel_signature: "需要本地律师姓名、执业辖区和真实 64 位 signatureHash。",
    pack_expired: "需要填写未来有效的 expiresAt 时间。",
    pack_not_active: "补齐其余必填字段后，再把状态切到 active。",
    pack_too_long: "expiresAt 不能超过策略允许的最长有效期。",
  }[reason] || reason;
}

function validationSummaryText(validation) {
  if (validation.ok) return "当前校验通过";
  return `当前仍缺：${validation.findings.map((reason) => packRequirementText(reason)).join("；")}`;
}

function packFieldTodoItems(pack = null, fieldState = {}) {
  const items = [];
  if (fieldState.reviewedAt) items.push("补 reviewedAt，有效时间不能为空。");
  if (fieldState.expiresAt) items.push("补 expiresAt，且必须是未来有效时间。");
  if (fieldState.counsel) items.push("补 counsel.name / counsel.barJurisdiction / counsel.signatureHash。");
  if (fieldState.officialSources) items.push("至少补 1 条 officialSources。可以先填 URL，保存时系统会自动尝试补 checkedAt 与 contentHash。");
  return items;
}

function buildManualLegalPackTemplate(jurisdiction = "", pack = null, fieldState = {}) {
  const reviewedAt = String(pack?.reviewedAt || "").trim() || "<填写 ISO 时间，例如 2026-07-17T00:00:00Z>";
  const expiresAt = String(pack?.expiresAt || "").trim() || "<填写未来 ISO 时间，例如 2026-10-17T00:00:00Z>";
  const counselName = String(pack?.counsel?.name || "").trim() || "<本地律师姓名>";
  const counselBarJurisdiction = String(pack?.counsel?.barJurisdiction || "").trim() || `<执业辖区代码，例如 ${jurisdiction || "AR"}>`;
  const counselSignatureHash = String(pack?.counsel?.signatureHash || "").trim() || "<64位十六进制 signatureHash>";
  const officialSourceLines = serializeOfficialSourcesInput(pack?.officialSources || []).trim();
  const officialSources = officialSourceLines || "<https://official-source.example/doc>";
  const missingFields = [
    fieldState.reviewedAt ? "reviewedAt" : "",
    fieldState.expiresAt ? "expiresAt" : "",
    fieldState.counsel ? "counsel.name / counsel.barJurisdiction / counsel.signatureHash" : "",
    fieldState.officialSources ? "officialSources" : "",
  ].filter(Boolean);
  return [
    `当前辖区: ${jurisdiction || "<jurisdiction>"}`,
    `当前必须补齐: ${missingFields.join("；") || "无"}`,
    "",
    `jurisdiction: ${jurisdiction || "<jurisdiction>"}`,
    `reviewedAt: ${reviewedAt}`,
    `expiresAt: ${expiresAt}`,
    `counsel.name: ${counselName}`,
    `counsel.barJurisdiction: ${counselBarJurisdiction}`,
    `counsel.signatureHash: ${counselSignatureHash}`,
    "officialSources:",
    officialSources.split("\n").map((line) => `  ${line}`).join("\n"),
    "",
    "说明:",
    "- officialSources 可以先只给 https 官方 URL；保存时系统会自动尝试补 checkedAt 和 contentHash。",
    "- reviewedAt / expiresAt / 律师信息 / signatureHash 必须是真实材料，系统不会代填。",
  ].join("\n");
}

function manualLegalTaskPath(rootDir, contentId = "", jurisdiction = "", now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  const safeContentId = String(contentId || "content").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const safeJurisdiction = String(jurisdiction || "XX").replace(/[^A-Z0-9_-]+/g, "");
  return resolve(rootDir, "private-legal/tasks", `${stamp}-${safeContentId}-${safeJurisdiction}.md`);
}

function manualLegalTaskTail(contentId = "", jurisdiction = "") {
  const safeContentId = String(contentId || "content").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const safeJurisdiction = String(jurisdiction || "XX").replace(/[^A-Z0-9_-]+/g, "");
  return `${safeContentId}-${safeJurisdiction}.md`;
}

function manualLegalTaskStatusPath(rootDir) {
  return resolve(rootDir, "private-legal/task-status.json");
}

function manualLegalTaskKey(contentId = "", jurisdiction = "") {
  return `${String(contentId || "").trim()}::${String(jurisdiction || "").trim().toUpperCase()}`;
}

async function loadManualLegalTaskRegistry(rootDir, { required = false } = {}) {
  const path = manualLegalTaskStatusPath(rootDir);
  try {
    const value = await readJson(path);
    return value && typeof value === "object" ? value : { version: 1, tasks: {} };
  } catch (error) {
    if (!required && error.code === "ENOENT") return { version: 1, tasks: {} };
    throw error;
  }
}

function updateManualLegalTaskRegistry(registry = {}, {
  contentId = "",
  jurisdiction = "",
  status = "",
  path = "",
}, now = new Date()) {
  const key = manualLegalTaskKey(contentId, jurisdiction);
  const tasks = { ...(registry.tasks || {}) };
  const existing = tasks[key] || {};
  tasks[key] = {
    ...existing,
    contentId: String(contentId || "").trim(),
    jurisdiction: String(jurisdiction || "").trim().toUpperCase(),
    status: String(status || existing.status || "generated").trim(),
    path: String(path || existing.path || "").trim(),
    updatedAt: now.toISOString(),
  };
  return {
    version: 1,
    tasks,
  };
}

async function saveManualLegalTaskStatus(rootDir, payload, now = new Date()) {
  const registry = await loadManualLegalTaskRegistry(rootDir, { required: false });
  const next = updateManualLegalTaskRegistry(registry, payload, now);
  await writePrivateJson(manualLegalTaskStatusPath(rootDir), next);
  return next;
}

function manualLegalTaskStatusLabel(status = "") {
  return {
    generated: "已生成",
    sent: "已发出",
    received: "已回传",
    applied: "已应用到 legal pack",
  }[status] || "未记录";
}

function manualLegalTaskNextStatus(status = "") {
  return {
    generated: "sent",
    sent: "received",
  }[status] || "";
}

function manualLegalTaskNextLabel(status = "") {
  return {
    generated: "标记已发出",
    sent: "标记已回传",
  }[status] || "";
}

function renderManualTaskStatusEntry({
  jurisdiction = "",
  entry = null,
  nextStatus = "",
  nextLabel = "",
  returnTo = "/",
  contentId = "",
}) {
  if (!entry) return `<li>${escapeHtml(jurisdiction)}: 未生成</li>`;
  return `<li>${escapeHtml(jurisdiction)}: ${escapeHtml(manualLegalTaskStatusLabel(entry.status))}${entry.generatedAt ? `（任务单 ${escapeHtml(formatDate(entry.generatedAt))}）` : ""}${entry.statusUpdatedAt ? `；状态更新 ${escapeHtml(formatDate(entry.statusUpdatedAt))}` : ""}${entry.path ? ` · <a href="${escapeHtml(routeForManualLegalTask(entry.path))}">打开任务单</a>` : ""}${entry.path && nextStatus && nextLabel ? `<form method="post" action="/actions" class="action-form"><input type="hidden" name="action" value="set_legal_task_status"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><input type="hidden" name="contentId" value="${escapeHtml(contentId)}"><input type="hidden" name="jurisdiction" value="${escapeHtml(jurisdiction)}"><input type="hidden" name="status" value="${escapeHtml(nextStatus)}"><button class="action-button" type="submit">${escapeHtml(nextLabel)}</button></form>` : ""}</li>`;
}

async function loadManualLegalTaskEntries(rootDir, contentId = "", jurisdictions = []) {
  const taskDir = resolve(rootDir, "private-legal/tasks");
  const codes = uniqueNonZzJurisdictions(jurisdictions);
  const byJurisdiction = new Map(codes.map((jurisdiction) => [jurisdiction, null]));
  const registry = await loadManualLegalTaskRegistry(rootDir, { required: false });
  if (!contentId || !codes.length) return { taskDir, byJurisdiction };
  const files = await readdir(taskDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const jurisdiction of codes) {
    const tail = manualLegalTaskTail(contentId, jurisdiction);
    const matches = files
      .filter((entry) => entry.isFile() && entry.name.endsWith(tail))
      .map((entry) => resolve(taskDir, entry.name));
    if (!matches.length) continue;
    const dated = await Promise.all(matches.map(async (path) => ({ path, stat: await stat(path) })));
    dated.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || right.path.localeCompare(left.path));
    const taskRecord = registry.tasks?.[manualLegalTaskKey(contentId, jurisdiction)] || null;
    byJurisdiction.set(jurisdiction, {
      path: dated[0].path,
      generatedAt: dated[0].stat.mtime.toISOString(),
      status: taskRecord?.status || "generated",
      statusUpdatedAt: taskRecord?.updatedAt || dated[0].stat.mtime.toISOString(),
    });
  }
  for (const jurisdiction of codes) {
    if (byJurisdiction.get(jurisdiction)) continue;
    const taskRecord = registry.tasks?.[manualLegalTaskKey(contentId, jurisdiction)] || null;
    if (!taskRecord) continue;
    byJurisdiction.set(jurisdiction, {
      path: taskRecord.path || "",
      generatedAt: "",
      status: taskRecord.status || "generated",
      statusUpdatedAt: taskRecord.updatedAt || "",
    });
  }
  return { taskDir, byJurisdiction };
}

async function writeManualLegalTask(rootDir, {
  content = null,
  contentId = "",
  jurisdiction = "",
  pack = null,
  fieldState = {},
  validation = null,
}, now = new Date()) {
  const taskPath = manualLegalTaskPath(rootDir, contentId || content?.id || "content", jurisdiction, now);
  const taskDocument = buildManualLegalPackTaskDocument({
    content,
    jurisdiction,
    pack,
    fieldState,
    validation,
  });
  await mkdir(resolve(taskPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(taskPath, `${taskDocument}\n`, { mode: 0o600 });
  await saveManualLegalTaskStatus(rootDir, {
    contentId: contentId || content?.id || "content",
    jurisdiction,
    status: "generated",
    path: taskPath,
  }, now);
  return taskPath;
}

function buildManualLegalPackTaskDocument({
  content = null,
  jurisdiction = "",
  pack = null,
  fieldState = {},
  validation = null,
}) {
  const template = buildManualLegalPackTemplate(jurisdiction, pack, fieldState);
  const title = content?.edition?.title || content?.id || "未命名稿件";
  const matchLabel = content?.edition
    ? `${content.edition.homeName} vs ${content.edition.awayName} · ${content.edition.competition || "未标注赛事"}`
    : "未记录比赛信息";
  return [
    `# ${jurisdiction} legal pack 补料任务单`,
    "",
    `- 稿件: ${title}`,
    `- 比赛: ${matchLabel}`,
    `- 当前状态: ${validation ? legalPackStateText(validation) : "未记录"}`,
    `- 日期: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## 填写模板",
    "```text",
    template,
    "```",
    "",
    "## 提交说明",
    "- 这份任务单只用于私有合规补料，不得公开发布。",
    "- officialSources 可以先给 https 官方 URL；系统保存时会自动尝试补 checkedAt 和 contentHash。",
    "- reviewedAt、expiresAt、律师信息、signatureHash 必须来自真实法务材料。",
    "",
  ].join("\n");
}

function renderActionChecklist(title, items, tone = "warn", { collapsed = false, summary = "" } = {}) {
  if (!items?.length) return "";
  if (!collapsed) {
    return `<section class="panel tone-${tone}">
      <h2>${escapeHtml(title)}</h2>
      <ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>`;
  }
  return `<details class="panel details-block tone-${tone}">
    <summary>${escapeHtml(title)}</summary>
    ${summary ? `<p class="meta">${escapeHtml(summary)}</p>` : ""}
    <ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  </details>`;
}

function renderFlowSection({
  active,
  title,
  summary,
  body,
  id = "",
  tone = "warn",
}) {
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  if (active) {
    return `<article class="panel tone-${tone}"${idAttr}>
      <h2>${escapeHtml(title)}</h2>
      ${summary ? `<p class="meta">${escapeHtml(summary)}</p>` : ""}
      ${body}
    </article>`;
  }
  return `<details class="panel details-block tone-${tone}"${idAttr}>
    <summary>${escapeHtml(title)}</summary>
    ${summary ? `<p class="meta">${escapeHtml(summary)}</p>` : ""}
    <p class="meta">当前步骤不是这里。先处理页面顶部的当前主动作；需要回头核对时再展开本节。</p>
  </details>`;
}

function defaultLegalFocus(state) {
  const releaseBlocked = state.items.find((item) => item.workflow?.status === "release_blocked");
  const fallback = releaseBlocked
    || state.items.find((item) => item.workflow?.status === "release_review_required")
    || state.items.find((item) => item.workflow?.status === "editorial_approved")
    || null;
  if (!fallback) return { currentId: "", packCode: "" };
  const operatorCode = String(state.registry.operatorJurisdictions?.[0] || "").trim().toUpperCase();
  const blockedCodes = uniqueNonZzJurisdictions(fallback.legal?.blockedJurisdictions || []);
  return {
    currentId: fallback.id,
    packCode: blockedCodes[0] || (/^[A-Z]{2}$/.test(operatorCode) && operatorCode !== "ZZ" ? operatorCode : ""),
  };
}

function legalPage(state, notice, error, currentId = "", focusedPackCode = "", evidenceInventory = null, legalSupport = null, taskEntries = null) {
  const current = currentId ? state.items.find((item) => item.id === currentId) || null : null;
  const currentGuidance = current?.guidance || (current ? buildItemWorkflowGuidance(current, state.registry, {
    packValidation: state.packValidation,
    operatorJurisdictionReport: state.operatorJurisdictionReport,
    supportByJurisdiction: state.supportSummary?.byJurisdiction,
  }) : null);
  const currentBlockedJurisdictions = current?.legal?.blockedJurisdictions?.filter((jurisdiction) => jurisdiction !== "ZZ") || [];
  const currentPacks = currentBlockedJurisdictions.map((jurisdiction) => ({
    jurisdiction,
    validation: state.packValidation.get(jurisdiction) || null,
  }));
  const allDraftCandidates = collectLegalDraftCandidateJurisdictions(state.registry, state.items);
  const allDraftStatuses = allDraftCandidates.map((jurisdiction) => ({
    jurisdiction,
    validation: state.packValidation.get(jurisdiction) || null,
  }));
  const activePackCount = allDraftStatuses.filter(({ validation }) => validation?.ok).length;
  const invalidPackCount = allDraftStatuses.filter(({ validation }) => validation && !validation.ok).length;
  const missingPackCount = allDraftStatuses.filter(({ validation }) => !validation).length;
  const coverageQueue = state.registry.coverageQueue || {};
  const operatorCode = state.registry.operatorJurisdictions?.[0] || "";
  const operatorConfirmed = Boolean(operatorCode && operatorCode !== "ZZ");
  const currentCanRetry = currentGuidance?.primaryAction?.action === "submit_release_zh";
  const currentNeedsDrafts = currentBlockedJurisdictions.some((jurisdiction) => !state.packValidation.get(jurisdiction));
  const currentMissingDraftCodes = currentBlockedJurisdictions.filter((jurisdiction) => !state.packValidation.get(jurisdiction));
  const currentInvalidPackCodes = currentBlockedJurisdictions.filter((jurisdiction) => !state.packValidation.get(jurisdiction)?.ok);
  const invalidPackCodes = allDraftStatuses.filter(({ validation }) => !validation?.ok).map(({ jurisdiction }) => jurisdiction);
  const focusedJurisdiction = String(focusedPackCode || "").trim().toUpperCase();
  const currentPackChoices = [...new Set([
    ...(focusedJurisdiction ? [focusedJurisdiction] : []),
    ...currentBlockedJurisdictions,
    ...(operatorConfirmed ? [operatorCode] : []),
  ])].filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ");
  const packFocusChoices = currentPackChoices.length
    ? currentPackChoices
    : [...new Set([
      ...(focusedJurisdiction ? [focusedJurisdiction] : []),
      ...(operatorConfirmed ? [operatorCode] : []),
      ...invalidPackCodes.slice(0, 12),
    ])].filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ");
  const packFocusCode = packFocusChoices.includes(focusedJurisdiction)
    ? focusedJurisdiction
    : currentBlockedJurisdictions[0] || (operatorConfirmed ? operatorCode : invalidPackCodes[0] || "");
  const focusPack = packFocusCode ? state.registry.packs.find((pack) => pack.jurisdiction === packFocusCode) || {
    jurisdiction: packFocusCode,
    status: "draft",
    reviewedAt: null,
    expiresAt: null,
    counsel: { name: "", barJurisdiction: "", signatureHash: "" },
    officialSources: [],
    notes: [],
  } : null;
  const focusPackValidation = packFocusCode ? state.packValidation.get(packFocusCode) || null : null;
  const focusPackRequirements = focusPackValidation?.ok ? [] : (focusPackValidation?.findings || []).map((reason) => packRequirementText(reason));
  const focusPackFieldState = validationFieldStates(focusPackValidation);
  const focusPackTodoItems = packFieldTodoItems(focusPack, focusPackFieldState);
  const showPackStatusField = false;
  const showPackReviewedAtField = focusPackFieldState.reviewedAt;
  const showPackExpiresAtField = focusPackFieldState.expiresAt;
  const showPackCounselField = focusPackFieldState.counsel;
  const showPackOfficialSourcesField = focusPackFieldState.officialSources;
  const hiddenPackFieldCount = [
    showPackReviewedAtField,
    showPackExpiresAtField,
    showPackCounselField,
    showPackOfficialSourcesField,
  ].filter((value) => !value).length;
  const focusPackSourceUrls = serializeOfficialSourceUrls(focusPack?.officialSources || []);
  const focusPackHasRefreshableUrls = Boolean(focusPackSourceUrls);
  const focusPackSupport = packFocusCode ? legalSupport?.byJurisdiction?.get(packFocusCode) || null : null;
  const focusSupportDraft = packFocusCode
    ? (focusPackSupport?.normalized || normalizeLegalSupportRecord(buildLegalSupportTemplate(focusPack, packFocusCode, {
      operatorJurisdiction: operatorConfirmed && operatorCode === packFocusCode,
    }), packFocusCode))
    : null;
  const focusSupportPath = packFocusCode ? legalSupportPath(root, packFocusCode) : "";
  const operatorSupport = operatorConfirmed ? legalSupport?.byJurisdiction?.get(operatorCode) || null : null;
  const currentSupportJurisdictions = [...new Set([
    ...currentBlockedJurisdictions,
    ...(operatorConfirmed ? [operatorCode] : []),
  ])].filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ");
  const currentMissingSupportCodes = currentSupportJurisdictions.filter((value) => !legalSupport?.byJurisdiction?.has(value));
  const currentSupportEntries = currentSupportJurisdictions.map((value) => legalSupport?.byJurisdiction?.get(value)).filter(Boolean);
  const currentImportableSupportCodes = currentSupportEntries.filter((entry) => supportEntryHasMaterial(entry)).map((entry) => entry.jurisdiction);
  const currentPrimarySupportCode = currentImportableSupportCodes[0] || currentSupportJurisdictions[0] || "";
  const currentNeedsSupport = currentMissingSupportCodes.length > 0 || currentImportableSupportCodes.length > 0;
  const operatorSupportDetectedJurisdiction = legalSupport?.operatorDetection?.detectedJurisdiction || "";
  const currentPrimaryPackCode = currentInvalidPackCodes[0] || currentMissingDraftCodes[0] || packFocusCode || "";
  const currentTaskExportCodes = uniqueNonZzJurisdictions(currentInvalidPackCodes.length ? currentInvalidPackCodes : currentBlockedJurisdictions);
  const currentTaskStatuses = currentTaskExportCodes.map((jurisdiction) => ({
    jurisdiction,
    entry: taskEntries?.byJurisdiction?.get(jurisdiction) || null,
    nextStatus: manualLegalTaskNextStatus(taskEntries?.byJurisdiction?.get(jurisdiction)?.status || "generated"),
    nextLabel: manualLegalTaskNextLabel(taskEntries?.byJurisdiction?.get(jurisdiction)?.status || "generated"),
  }));
  const primaryTaskStatus = currentTaskStatuses.find((entry) => entry.jurisdiction === currentPrimaryPackCode)
    || currentTaskStatuses.find((entry) => Boolean(entry.entry))
    || currentTaskStatuses[0]
    || null;
  const secondaryTaskStatuses = primaryTaskStatus
    ? currentTaskStatuses.filter((entry) => entry.jurisdiction !== primaryTaskStatus.jurisdiction)
    : [];
  const currentOperatorSuggestionCodes = uniqueNonZzJurisdictions([
    ...currentBlockedJurisdictions,
    ...currentSupportJurisdictions,
    currentPrimaryPackCode,
    currentPrimarySupportCode,
  ]);
  const nextAfterFocusPack = nextBlockedLegalPack(currentInvalidPackCodes, packFocusCode);
  const focusedReturnTo = routeForLegal(current?.id || "", packFocusCode);
  const operatorReport = state.operatorJurisdictionReport || null;
  const operatorEvidenceUrlDraft = operatorReport?.mode === "user_supplied_urls"
    ? serializeUrlLines(operatorReport.inputUrls || operatorReport.urls?.map((entry) => entry.url) || [])
    : "";
  const operatorAutoSummary = operatorConfirmed
    ? `发布主体辖区已经确认成 ${operatorCode}，这一步当前不需要自动识别。`
    : legalSupport?.operatorDetection?.detectedJurisdiction
      ? `本地 support 材料里已经唯一标记 ${legalSupport.operatorDetection.detectedJurisdiction} 为发布主体辖区，可以直接导入。`
    : operatorReport?.detectedJurisdiction
      ? `最近一次自动识别已经命中 ${operatorReport.detectedJurisdiction}；如果这就是你确认的真实主体辖区，可以直接保存。`
      : operatorReport?.mode === "user_supplied_urls"
        ? "最近一次外部公开 URL 扫描没有找到唯一明确辖区，只能继续等待更强的公开证据或人工确认。"
        : "如果站内或外部公开页面出现唯一明确的主体辖区表述，系统可以自动回填；否则会保持 ZZ 不动。";
  const autoActions = [
    operatorAutoSummary,
    currentPrimaryPackCode
      ? `${currentPrimaryPackCode} legal pack 可以自动抓取公开官方来源 URL 的 contentHash；当真实字段都补齐并通过校验后，系统也会自动切到 active。`
      : "选中一个具体辖区后，系统才会为该辖区自动抓取官方来源哈希。",
    currentCanRetry
      ? "当前阻断条件已经解除，系统下一步就只剩重新提交中文发布申请。"
      : "在主体辖区和当前稿件所需 legal pack 都补齐之前，系统不会显示重新提交按钮。",
  ];
  const manualActions = [
    operatorConfirmed
      ? `仍需确保 ${operatorCode} 本身这份 pack 的真实字段补齐并通过校验；通过后系统会自动切到 active。`
      : "你必须提供真实确认过的发布主体辖区；系统不会根据邮箱后缀、语言、AWS 区域或球队辖区去猜。",
    ...(currentInvalidPackCodes.length
      ? [`当前稿件优先要补的辖区是 ${currentInvalidPackCodes.join("、")}；不需要先补完整个站点。`]
      : []),
    "每个 legal pack 都必须有人工提供 reviewedAt、未来有效的 expiresAt、本地律师姓名/执业辖区、以及真实 64 位 signatureHash。",
    "officialSources 即使能自动抓 hash，也仍然需要你提供真实的官方 URL；系统不会伪造来源内容。",
  ];
  const automationLimits = blockedAutomationLimits({
    operatorConfirmed,
    operatorReport,
    currentInvalidPackCodes,
    currentCanRetry,
  });
  const legalNextStep = current ? buildBlockedItemResolutionStep({
    item: current,
    operatorConfirmed,
    operatorSupportDetectedJurisdiction,
    operatorReport,
    currentCanRetry,
    currentNeedsDrafts,
    currentMissingDraftCodes,
    currentNeedsSupport,
    currentMissingSupportCodes,
    currentPrimarySupportCode,
    currentSupportReadyToImport: currentImportableSupportCodes.length > 0,
    currentBlockedJurisdictions,
    currentPrimaryPackCode,
    focusedReturnTo,
    surface: "legal",
  }) : null;
  const currentStage = current ? blockedItemResolutionStage({
    operatorConfirmed,
    currentCanRetry,
    currentNeedsDrafts,
    currentNeedsSupport,
    currentPrimaryPackCode,
  }) : "global";
  const currentStep = currentLegalStepNumber(currentStage);
  const currentProblemEntryLinks = current ? renderProblemEntryLinks({
    item: current,
    packAnchor: currentStage === "pack" || currentStage === "support" || currentStage === "drafts"
      ? (currentPrimaryPackCode ? `#pack-${currentPrimaryPackCode}` : "")
      : "",
    packLabel: currentPrimaryPackCode ? `${currentPrimaryPackCode} 发布资料包` : "发布资料包",
    includeOperatorAnchor: currentStage === "operator" && !operatorConfirmed,
    includeDetailLink: currentStage === "detail" || currentStage === "retry",
  }) : "";
  const visibleProblemEntryLinks = ((currentStage === "operator" && legalNextStep?.primaryAction?.type === "link" && legalNextStep.primaryAction.href === "#operator-jurisdiction-panel")
    || ((currentStage === "pack" || currentStage === "drafts" || currentStage === "support")
      && legalNextStep?.primaryAction?.type === "link"
      && legalNextStep.primaryAction.href === `#pack-${currentPrimaryPackCode}`))
    ? ""
    : currentProblemEntryLinks;
  const inlineNextStepNote = legalNextStep?.primaryAction?.type === "link" && legalNextStep.primaryAction.href === "#operator-jurisdiction-panel"
    ? "当前主按钮就在下方“发布主体辖区”表单里：保存发布主体辖区。"
    : (legalNextStep?.primaryAction?.type === "link" && currentPrimaryPackCode && legalNextStep.primaryAction.href === `#pack-${currentPrimaryPackCode}`
      ? `当前主按钮就在下方“${currentPrimaryPackCode} 发布资料包”表单里：保存发布资料包。`
      : "");
  const showOperatorManualEditor = !current || currentStage === "operator";
  const showPackEditor = !current || currentStage === "pack";
  const focusPackSupportHasMaterial = supportEntryHasMaterial(focusPackSupport);
  const remainingPackCodesAfterFocus = currentInvalidPackCodes.filter((code) => code !== packFocusCode);
  const currentPackQueueSummary = currentPrimaryPackCode
    ? (remainingPackCodesAfterFocus.length
      ? `当前先处理 ${currentPrimaryPackCode}，完成后自动切到 ${remainingPackCodesAfterFocus[0]}${remainingPackCodesAfterFocus.length > 1 ? `，后面还剩 ${remainingPackCodesAfterFocus.slice(1).join("、")}` : ""}。`
      : `当前只剩 ${currentPrimaryPackCode} 这一个辖区。补完后就会回到重新提交。`)
    : "当前没有明确的焦点辖区。";
  const currentBlockedScopeSummary = currentInvalidPackCodes.length
    ? `${currentInvalidPackCodes.join("、")} ${operatorConfirmed ? "" : "以及发布主体辖区 "}会阻断这次重提。`
    : (operatorConfirmed ? "当前没有剩余辖区阻断。" : "当前仍缺发布主体辖区。");
  const focusSupportSummary = focusPackSupport
    ? `当前已发现 ${focusPackSupport.name}${focusPackSupportHasMaterial ? "，里面有可导入材料。" : "，但里面还没有真实可导入字段。"}`
    : `当前还没有 ${packFocusCode || "该辖区"} 的 support 文件。`;
  const body = `
    <section class="header">
      <p class="eyebrow"><a href="/">返回审稿工作台</a></p>
      <h1 class="title">系统发布条件处理台</h1>
      <p class="subtitle">这里专门处理 <code>release_blocked</code>。编辑侧不需要单独走律师或法务流程；这里只有后台发布条件补齐和重新提交动作。系统不会自动伪造签名、官方依据或有效日期，也不会从邮箱后缀、语言、AWS 区域或球队辖区反推发布主体。</p>
    </section>
    ${legalNextStep ? `<section class="panel tone-warn">
      <h2>${escapeHtml(legalNextStep.title)}</h2>
      <p class="meta">${escapeHtml(legalNextStep.detail)}</p>
      <p class="meta">当前没有更多可安全自动执行的动作。下一步必须补真实发布资料，系统不会代填签名、有效日期或官方来源。</p>
      ${current ? `<p class="meta">${escapeHtml(currentPackQueueSummary)}</p>` : ""}
      ${inlineNextStepNote ? `<p class="meta">${escapeHtml(inlineNextStepNote)}</p>` : `<div class="actions">${renderBlockedDraftAction(legalNextStep)}</div>`}
      ${visibleProblemEntryLinks ? `<p class="meta">遇到问题可直接跳到：</p><div class="actions">${visibleProblemEntryLinks}</div>` : ""}
    </section>` : ""}
    <details class="panel details-block">
      <summary>不清楚系统发布资料是什么，或要看补充说明时再展开</summary>
      <p class="meta">${escapeHtml(legalPackDefinition())}</p>
    ${renderActionChecklist("为什么系统现在不能自动放行", automationLimits, "warn", {
      collapsed: true,
      summary: "这里解释为什么系统停在当前步骤，以及哪些字段不能自动伪造。",
    })}
    ${renderActionChecklist("系统现在能自动帮你做什么", autoActions, "ok", {
      collapsed: true,
      summary: "这里只列安全、确定性的自动动作，不包括律师签名和有效期这类人工字段。",
    })}
    ${renderActionChecklist("仍然必须你提供的真实材料", manualActions, "warn", {
      collapsed: true,
      summary: "这些字段是最终放行前的硬门槛，系统只能提示，不能代填。",
    })}
    ${evidenceInventory ? `<details class="panel details-block">
      <summary>仓库里当前已发现的私有材料</summary>
      <p class="meta">比赛事实材料: <span class="inline-code">${escapeHtml(evidenceInventory.privateEvidenceCount)}</span> 个 private-evidence 文件${evidenceInventory.privateEvidencePreview.length ? `，例如 ${escapeHtml(evidenceInventory.privateEvidencePreview.join("、"))}` : ""}。</p>
      <p class="meta">法务材料: private-legal 当前共有 <span class="inline-code">${escapeHtml(evidenceInventory.privateLegalFiles.length)}</span> 个文件；其中 support 目录下的结构化法务支撑文件 <span class="inline-code">${escapeHtml(evidenceInventory.legalSupportCount)}</span> 个${evidenceInventory.legalSupportPreview.length ? `，例如 ${escapeHtml(evidenceInventory.legalSupportPreview.join("、"))}` : ""}。</p>
      ${evidenceInventory.legalSupportCount === 0 ? `<p class="meta">这表示仓库里目前只有发布资料包注册表和自动识别报告，还没有可直接回填律师、日期或官方依据的结构化私有法务文件。</p>` : `<p class="meta">当前页面只围绕焦点辖区推进；support 里的真实材料只有在命中当前辖区时才会参与自动导入。</p>`}
      <p class="meta">支持目录: <span class="inline-code">${escapeHtml(evidenceInventory.legalSupportDir)}</span></p>
      <p class="meta">模板文件: <span class="inline-code">${escapeHtml(evidenceInventory.legalSupportExamplePath)}</span></p>
    </details>` : ""}
    ${legalSupport ? `<details class="panel details-block">
      <summary>support 扫描结果</summary>
      <p class="meta">${escapeHtml(focusSupportSummary)}</p>
      ${packFocusCode ? `<p class="meta">当前焦点辖区: <span class="inline-code">${escapeHtml(packFocusCode)}</span>${nextAfterFocusPack ? `；下一辖区: <span class="inline-code">${escapeHtml(nextAfterFocusPack)}</span>` : ""}</p>` : ""}
      ${legalSupport.operatorDetection?.detectedJurisdiction ? `<p class="meta">support 已唯一标记发布主体辖区: <span class="inline-code">${escapeHtml(legalSupport.operatorDetection.detectedJurisdiction)}</span></p>` : legalSupport.operatorDetection?.ambiguous ? `<p class="meta">support 里同时标记了多个发布主体辖区: ${escapeHtml(legalSupport.operatorDetection.jurisdictions.join("、"))}</p>` : `<p class="meta">support 里当前没有唯一明确的发布主体辖区标记。</p>`}
      ${legalSupport.errors.length ? `<p class="meta">这些 support 文件读取失败，修复后才会出现导入按钮：</p><ul class="list">${legalSupport.errors.map((entry) => `<li>${escapeHtml(entry.name)}：${escapeHtml(entry.message)}</li>`).join("")}</ul>` : `<p class="meta">当前没有 support 解析错误。</p>`}
      ${packFocusCode && !focusPackSupport ? `<form method="post" action="/actions" class="action-form">
        <input type="hidden" name="action" value="bootstrap_legal_support_template">
        <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
        <input type="hidden" name="jurisdiction" value="${escapeHtml(packFocusCode)}">
        <input type="hidden" name="operatorJurisdiction" value="${escapeHtml(operatorConfirmed && operatorCode === packFocusCode ? "1" : "")}">
        <button class="action-button" type="submit">只为当前辖区生成 support 骨架</button>
      </form>` : ""}
    </details>` : ""}
    <details class="panel details-block">
      <summary>查看完整处理步骤</summary>
      <div class="resolve-list">
        <div class="resolve-item">
          <div class="toolbar"><strong>1. 确认发布主体辖区</strong>${legalStepBadge(operatorConfirmed)}${currentFlowBadge(currentStep === 1)}</div>
          <p class="meta">${operatorConfirmed ? `当前已填写 ${operatorCode}。` : "仓库里目前只有占位值 ZZ，没有单独的已确认主体档案；系统不能替你猜，只能等你填入已确认的两位代码。"}</p>
        </div>
        <div class="resolve-item">
          <div class="toolbar"><strong>2. 准备发布资料包骨架</strong>${legalStepBadge(current ? !currentNeedsDrafts : missingPackCount === 0)}${currentFlowBadge(currentStep === 2)}</div>
          <p class="meta">${current
            ? (currentNeedsDrafts ? `当前稿件还缺 ${currentBlockedJurisdictions.filter((jurisdiction) => !state.packValidation.get(jurisdiction)).join("、")} 的 pack 记录，可以先生成 draft 骨架。` : `当前焦点 ${currentPrimaryPackCode || packFocusCode || "辖区"} 的 pack 记录已经存在。`)
            : (missingPackCount === 0 ? "全站当前候选辖区都已经有 draft 或 active 记录。" : `还有 ${missingPackCount} 个候选辖区没有发布资料包记录，可以安全生成 draft 骨架。`)}</p>
        </div>
        <div class="resolve-item">
          <div class="toolbar"><strong>3. 准备 support 材料</strong>${legalStepBadge(current ? !currentNeedsSupport : true)}${currentFlowBadge(currentStep === 3)}</div>
          <p class="meta">${current
            ? (currentNeedsSupport
              ? (currentMissingSupportCodes.length
                ? `当前先处理 ${packFocusCode || currentPrimarySupportCode}；如果该辖区没有 support，就只为它生成骨架。`
                : `当前已有 ${currentImportableSupportCodes.join("、")} 的 support 文件可导入发布资料包。`)
              : (focusPackSupport
                ? "当前焦点辖区的 support 已存在，但里面还没有触发自动导入的真实材料。"
                : "当前焦点辖区暂时不需要 support 补料。"))
            : "support 目录用于承接结构化私有法务材料；只有填入真实内容后才会推进发布资料包。"}
          </p>
        </div>
        <div class="resolve-item">
          <div class="toolbar"><strong>4. 补齐可发布发布资料包</strong>${legalStepBadge(current ? currentInvalidPackCodes.length === 0 : invalidPackCount === 0)}${currentFlowBadge(currentStep === 4)}</div>
          <p class="meta">${current
            ? (currentInvalidPackCodes.length === 0 ? "当前稿件所需的发布资料包都已通过校验。" : `当前先补 ${packFocusCode || currentPrimaryPackCode}；${remainingPackCodesAfterFocus.length ? `补完后会继续切到 ${remainingPackCodesAfterFocus.join("、")}。` : "补完后即可进入重新提交。"} `)
            : (invalidPackCount === 0 ? "当前候选辖区的发布资料包都已通过校验。" : `仍有 ${invalidPackCount} 个辖区的资料包无效；这一步必须由人工补入官方来源、日期和本地律师签名哈希。`)}</p>
        </div>
        ${current ? `<div class="resolve-item">
          <div class="toolbar"><strong>5. 重新提交当前稿件</strong>${legalStepBadge(currentCanRetry)}${currentFlowBadge(currentStep === 5)}</div>
          <p class="meta">${currentCanRetry ? "本稿件当前阻断条件已解除，可以重新跑一次独立预审与本地预发。" : `只有 ${packFocusCode || currentPrimaryPackCode || "当前辖区"}${remainingPackCodesAfterFocus.length ? ` 以及后续 ${remainingPackCodesAfterFocus.join("、")}` : ""} 都补齐后，这一步才会出现重新提交按钮。`}</p>
        </div>` : ""}
      </div>
    </details>
    </details>
    <details class="panel details-block">
      <summary>${currentStage === "pack" || currentStage === "drafts" || currentStage === "support" ? "如需核对当前阻断范围再展开" : "查看当前阻断范围"}</summary>
      <section class="diagnostics">
      ${renderFlowSection({
        active: !current || currentStage === "operator",
        title: currentStage === "operator" ? "现在就处理：发布主体辖区" : "处理完当前步骤后再看：发布主体辖区",
        summary: operatorCode && operatorCode !== "ZZ"
          ? `当前已填写 ${operatorCode}，但仍需该辖区存在有效发布资料包。`
          : "当前仍是占位值 ZZ 或为空，这会直接阻断所有发布申请。",
        id: "operator-jurisdiction-panel",
        tone: state.readiness.publicationStatus === "PASS" ? "ok" : "warn",
        body: `
        <p class="meta">当前值: <span class="inline-code">${escapeHtml(operatorCode || "未设置")}</span></p>
        <p class="meta">${showOperatorManualEditor ? "当前步骤只需要先确认主体辖区。上方主按钮会优先尝试自动推进；如果自动证据不够，再展开下面的手工入口。" : "当前步骤暂时不需要再改发布主体辖区。"}
        </p>
        ${showOperatorManualEditor ? (currentStage === "operator"
          ? `<div class="resolve-panel">`
          : `<details class="details-block">
          <summary>需要手工确认或切换识别方式时再展开</summary>`)
          : ""}
          ${currentOperatorSuggestionCodes.length ? `<div class="resolve-item tight">
            <strong>当前稿件可直接确认的辖区候选</strong>
            <p class="meta">系统不会替你猜，但你可以基于已确认的法务事实，直接把当前稿件相关辖区设为发布主体辖区。</p>
            <div class="actions">${currentOperatorSuggestionCodes.map((code) => `<form method="post" action="/actions" class="action-form">
              <input type="hidden" name="action" value="set_operator_jurisdiction">
              <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
              <input type="hidden" name="jurisdiction" value="${escapeHtml(code)}">
              <button class="action-button" type="submit">确认 ${escapeHtml(code)} 为发布主体辖区</button>
            </form>`).join("")}</div>
          </div>` : ""}
          <form method="post" action="/actions" class="form-grid">
            <input type="hidden" name="action" value="set_operator_jurisdiction">
            <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
            <label class="meta" for="operator-jurisdiction">输入已确认的两位国家/地区代码</label>
            <div class="form-row">
              <input class="text-input" id="operator-jurisdiction" name="jurisdiction" value="${escapeHtml(operatorCode && operatorCode !== "ZZ" ? operatorCode : "")}" maxlength="2" placeholder="如 CN / US">
              <button class="action-button primary" type="submit">保存发布主体辖区</button>
            </div>
          </form>
          <div class="resolve-item tight">
            <strong>系统现在可自动做的事</strong>
            <p class="meta">${escapeHtml(operatorAutoSummary)}</p>
            <div class="actions">
              ${legalSupport?.operatorDetection?.detectedJurisdiction ? `<form method="post" action="/actions" class="action-form">
                <input type="hidden" name="action" value="apply_operator_jurisdiction_from_support">
                <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
                <button class="action-button primary" type="submit">用 support 材料确认发布主体辖区</button>
              </form>` : ""}
              <form method="post" action="/actions" class="action-form">
                <input type="hidden" name="action" value="autodetect_operator_jurisdiction">
                <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
                <button class="action-button" type="submit">自动识别发布主体辖区</button>
              </form>
            </div>
            ${operatorConfirmed && !operatorSupport ? `<p class="meta">当前还没有 ${escapeHtml(operatorCode)} 的 support 文件。如果你准备从本地私有法务材料推进，可以先生成该辖区的 support 骨架。</p><form method="post" action="/actions" class="action-form">
              <input type="hidden" name="action" value="bootstrap_legal_support_template">
              <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
              <input type="hidden" name="jurisdiction" value="${escapeHtml(operatorCode)}">
              <input type="hidden" name="operatorJurisdiction" value="1">
              <button class="action-button" type="submit">生成 ${escapeHtml(operatorCode)} support 骨架</button>
            </form>` : ""}
          </div>
          ${focusSupportDraft ? `<div class="resolve-item tight">
            <strong>如果你手里已经有私有法务材料</strong>
            <p class="meta">你可以直接在这一步填写 ${escapeHtml(packFocusCode)} 的 support，并勾选“这份 support 同时确认当前辖区就是发布主体辖区”。保存后系统会自动同步到发布资料包；如果官方来源 URL 已填写但 hash 缺失，也会继续尝试补抓。</p>
            <p class="meta">${focusPackSupport ? `当前文件：` : "将创建文件："}<span class="inline-code">${escapeHtml(focusSupportPath)}</span></p>
            <form method="post" action="/actions" class="form-grid">
              <input type="hidden" name="action" value="save_legal_support">
              <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
              <input type="hidden" name="jurisdiction" value="${escapeHtml(packFocusCode)}">
              <label class="meta" for="operator-support-status">support.status</label>
              <select class="select-input" id="operator-support-status" name="status">
                <option value="draft" ${focusSupportDraft.status === "draft" ? "selected" : ""}>draft</option>
                <option value="active" ${focusSupportDraft.status === "active" ? "selected" : ""}>active</option>
              </select>
              <label class="meta" for="operator-support-reviewed-at">support.reviewedAt</label>
              <input class="text-input wide" id="operator-support-reviewed-at" name="reviewedAt" value="${textValue(focusSupportDraft.reviewedAt)}" placeholder="2026-07-16T00:00:00Z">
              <label class="meta" for="operator-support-expires-at">support.expiresAt</label>
              <input class="text-input wide" id="operator-support-expires-at" name="expiresAt" value="${textValue(focusSupportDraft.expiresAt)}" placeholder="2026-10-14T00:00:00Z">
              <label class="meta" for="operator-support-counsel-name">support.counsel.name</label>
              <input class="text-input wide" id="operator-support-counsel-name" name="counselName" value="${textValue(focusSupportDraft.counselName)}" placeholder="Local counsel name">
              <label class="meta" for="operator-support-bar-jurisdiction">support.counsel.barJurisdiction</label>
              <input class="text-input" id="operator-support-bar-jurisdiction" name="counselBarJurisdiction" value="${textValue(focusSupportDraft.counselBarJurisdiction)}" maxlength="2" placeholder="如 GB / AR">
              <label class="meta" for="operator-support-signature-hash">support.counsel.signatureHash</label>
              <input class="text-input wide" id="operator-support-signature-hash" name="counselSignatureHash" value="${textValue(focusSupportDraft.counselSignatureHash)}" placeholder="64 位十六进制哈希">
              <label class="meta" for="operator-support-official-sources">support.officialSources</label>
              <textarea class="text-area" id="operator-support-official-sources" name="officialSourcesText" placeholder="每行一条：https://example.gov/doc | 2026-07-16T00:00:00Z | 64hexhash">${textValue(focusSupportDraft.officialSourcesText)}</textarea>
              <label class="meta" for="operator-support-notes">support.notes</label>
              <textarea class="text-area" id="operator-support-notes" name="notesText" placeholder="每行一条备注">${textValue(focusSupportDraft.notesText)}</textarea>
              <label class="meta" for="operator-support-operator-flag">
                <input id="operator-support-operator-flag" type="checkbox" name="operatorJurisdiction" value="1" ${focusSupportDraft.operatorJurisdiction || (!operatorConfirmed && packFocusCode ? "checked" : "")}>
                这份 support 同时确认当前辖区就是发布主体辖区
              </label>
              <div class="actions"><button class="action-button primary" type="submit">保存 support 材料并同步发布资料包</button></div>
            </form>
          </div>` : ""}
          <div class="resolve-item tight">
            <strong>默认自动识别不够时</strong>
            <p class="meta">上面的按钮会先扫描站内公开 legal/about/contact 页面；如果你手里有更强的公开证据 URL，可以在这里单独输入。</p>
            <form method="post" action="/actions" class="form-grid">
              <input type="hidden" name="action" value="detect_operator_jurisdiction_from_urls">
              <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
              <label class="meta" for="operator-evidence-urls">用外部公开证据 URL 自动识别</label>
              <textarea class="text-area" id="operator-evidence-urls" name="operatorEvidenceUrlsText" placeholder="每行一个 https URL；只会使用页面正常加载后的公开内容">${textValue(operatorEvidenceUrlDraft)}</textarea>
              <div class="actions"><button class="action-button" type="submit">用这些 URL 识别并回填</button></div>
            </form>
          </div>
        ${showOperatorManualEditor ? (currentStage === "operator" ? `</div>` : `</details>`) : ""}
        ${operatorReport ? `<details class="details-block">
          <summary>查看最近一次自动识别结果</summary>
          <p class="meta">检查时间: ${escapeHtml(formatDate(operatorReport.checkedAt))}</p>
          <p class="meta">模式: ${escapeHtml(operatorReport.mode === "user_supplied_urls" ? "外部公开证据 URL" : "站内公开页面自动发现")}</p>
          <p class="meta">结论: ${escapeHtml(operatorReport.detectedJurisdiction ? `检测到 ${operatorReport.detectedJurisdiction}` : operatorReport.ambiguous ? `命中多个候选：${operatorReport.jurisdictions.join("、")}` : "未发现唯一明确辖区")}</p>
          ${operatorReport.diagnostics ? `<p class="meta">本次扫描 ${escapeHtml(operatorReport.diagnostics.scannedSources)} 个公开页面，其中 ${escapeHtml(operatorReport.diagnostics.contextualSourceCount)} 个页面出现了主体辖区相关措辞，共命中 ${escapeHtml(operatorReport.diagnostics.contextualLineCount)} 段上下文。</p><p class="meta">${escapeHtml(operatorReport.diagnostics.note || "")}</p>` : ""}
          ${operatorReport.urls?.length ? `<p class="meta">本次实际扫描的 URL：</p><ul class="list">${operatorReport.urls.map((entry) => `<li>${escapeHtml(entry.url)}${entry.finalUrl && entry.finalUrl !== entry.url ? ` -> ${escapeHtml(entry.finalUrl)}` : ""} · ${escapeHtml(entry.status)}</li>`).join("")}</ul>` : ""}
          ${operatorReport.weakSignals?.length ? `<p class="meta">当前只发现这些公开弱信号，仍不足以自动确认辖区：</p><ul class="list">${operatorReport.weakSignals.map((entry) => `<li>${escapeHtml(entry.sourceUrl)} · ${escapeHtml(entry.evidence)}</li>`).join("")}</ul>` : ""}
          ${operatorReport.findings?.length ? `<ul class="list">${operatorReport.findings.map((entry) => `<li>${escapeHtml(entry.jurisdiction)} · ${escapeHtml(entry.sourceUrl)} · ${escapeHtml(entry.evidence)}</li>`).join("")}</ul>` : `<p class="meta">当前没有找到可自动回填的公开证据。</p>`}
        </details>` : `<p class="meta">自动识别只会在检测到唯一明确辖区时回填；否则保持不变。</p>`}
        <p class="meta">实际文件: <span class="inline-code">${escapeHtml(legalRegistryPath(root))}</span></p>
        `,
      })}
      ${renderFlowSection({
        active: !current || currentStage === "pack" || currentStage === "drafts" || currentStage === "support",
        title: !current
          ? "全局发布资料包摘要"
          : (currentStage === "pack" || currentStage === "drafts" || currentStage === "support" ? "现在就参考：当前阻断范围摘要" : "如果需要再展开：当前阻断范围摘要"),
        summary: current
          ? currentBlockedScopeSummary
          : (state.readiness.publicationFailures.length ? "当前发布阻断仍然存在，需补齐辖区和发布资料包。" : "当前没有发布资料包阻断。"),
        tone: state.readiness.publicationStatus === "PASS" ? "ok" : "warn",
        body: `
        <p class="meta">自动化发布状态: ${escapeHtml(state.readiness.publicationStatus)}</p>
        <div class="code-list">${(state.registry.operatorJurisdictions || []).map((code) => `<span class="code-pill">${escapeHtml(code)}</span>`).join("") || `<span class="code-pill">未设置</span>`}</div>
        <p class="meta">${current
          ? `当前稿件阻断辖区共 ${currentBlockedJurisdictions.length || 0} 个，其中当前焦点是 ${packFocusCode || currentPrimaryPackCode || "未确定"}。`
          : `draft 候选共 ${allDraftCandidates.length} 个，其中可用 ${activePackCount}、无效 ${invalidPackCount}、未创建 ${missingPackCount}。`}</p>
        ${!current && missingPackCount > 0 ? `<div class="actions">
          <form method="post" action="/actions" class="action-form">
            <input type="hidden" name="action" value="bootstrap_all_legal_drafts">
            <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
            <button class="action-button" type="submit">为全站缺口生成 draft 发布资料包</button>
          </form>
        </div>` : `<p class="meta">${current ? "当前稿件模式下不显示全站批量动作，避免把问题范围放大。" : "当前不需要再批量生成 draft 骨架。"}</p>`}
        ${packFocusCode ? `<p class="meta">当前焦点辖区: <span class="inline-code">${escapeHtml(packFocusCode)}</span>${nextAfterFocusPack ? `；下一辖区: <span class="inline-code">${escapeHtml(nextAfterFocusPack)}</span>` : ""}</p>` : ""}
        ${remainingPackCodesAfterFocus.length ? `<p class="meta">后续仍待处理: ${escapeHtml(remainingPackCodesAfterFocus.join("、"))}</p>` : `<p class="meta">当前没有剩余后续辖区。</p>`}
        `,
      })}
      </section>
    </details>
    ${current ? renderFlowSection({
      active: currentStage === "detail" || currentStage === "retry",
      title: currentStage === "detail" || currentStage === "retry" ? "现在就核对：当前稿件阻断" : "如果不清楚为什么卡住，再展开：当前稿件阻断",
      summary: `当前稿件真正会阻断这次重提的辖区: ${currentInvalidPackCodes.join("、") || "无"}${operatorConfirmed ? "" : "；发布主体辖区也还未确认"}。`,
      tone: "warn",
      body: `
      <p class="meta"><a href="${escapeHtml(routeForDetail(current.id))}">${escapeHtml(current.edition.title)}</a></p>
      <p class="meta">当前阶段: ${escapeHtml(currentGuidance?.stateLabel || current.workflow.status)}</p>
      <p class="meta">下一步: ${escapeHtml(currentGuidance?.nextStep || current.workflow.summary || "未记录")}</p>
      ${currentGuidance?.blockers?.length ? `<ul class="list">${currentGuidance.blockers.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>` : `<p class="meta">当前稿件没有额外阻断说明。</p>`}
      <div class="resolve-panel">
        <div class="resolve-item">
          <strong>当前阻断范围</strong>
          <p class="meta">${escapeHtml(currentBlockedScopeSummary)}</p>
          <p class="meta">${escapeHtml(currentPackQueueSummary)}</p>
        </div>
        <div class="resolve-item">
          <strong>当前可执行动作</strong>
          ${legalNextStep ? `<p class="meta">${escapeHtml(legalNextStep.detail)}</p><div class="actions">${renderBlockedDraftAction(legalNextStep)}</div>` : `<p class="meta">当前没有可自动执行的下一步。</p>`}
          ${currentProblemEntryLinks ? `<p class="meta">遇到问题可直接跳到：</p><div class="actions">${currentProblemEntryLinks}</div>` : ""}
        </div>
      </div>
      `,
    }) : ""}
    ${focusPack ? renderFlowSection({
      active: !current || currentStage === "pack" || currentStage === "drafts" || currentStage === "support",
      title: currentStage === "pack" || currentStage === "drafts" || currentStage === "support"
        ? `现在就处理：${packFocusCode} 发布资料包`
        : `处理完当前步骤后再看：${packFocusCode} 发布资料包`,
      summary: `当前校验：${legalPackStateText(focusPackValidation)}。当前只需要补缺失字段；保存后系统会自动重抓可抓的官方来源哈希并重新校验。`,
      id: `pack-${packFocusCode}`,
      tone: focusPackValidation?.ok ? "ok" : "warn",
      body: `
      ${focusPackTodoItems.length
        ? `<div class="resolve-item"><strong>现在要补的字段</strong><ul class="list">${focusPackTodoItems.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul><p class="meta">保存后系统会自动尝试：补官方来源哈希、重新校验、通过时自动切 active。${nextAfterFocusPack ? `补完 ${escapeHtml(packFocusCode)} 后，下一步会自动切到 ${escapeHtml(nextAfterFocusPack)}。` : ""}</p></div>`
        : focusPackRequirements.length
          ? `<div class="resolve-item"><strong>当前还缺什么</strong><ul class="list">${focusPackRequirements.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></div>`
          : `<p class="meta">这个 pack 当前已经通过校验。</p>`}
      ${currentStage === "pack" || currentStage === "drafts" || currentStage === "support" ? `<details class="details-block">
        <summary>需要辅助信息时再展开</summary>
        <div class="resolve-item tight">
          <strong>当前辅助动作</strong>
          <p class="meta">当前主动作是先保存这份发布资料包。你可以先在 officialSources 里只填官方 URL；保存时系统会自动尝试补抓 checkedAt 和 contentHash。只有自动补抓后仍缺失时，才需要额外点重抓按钮。</p>
          ${focusPackSupport ? `<p class="meta">已发现对应 support 文件: <span class="inline-code">${escapeHtml(focusPackSupport.name)}</span>${focusPackSupportHasMaterial ? "，但当前步骤仍以直接补发布资料包为主。" : "，但里面还没有可导入的真实字段。"} </p>` : `<p class="meta">如果你手里后续拿到结构化私有法务材料，再放进 <span class="inline-code">${escapeHtml(evidenceInventory?.legalSupportDir || resolve(root, "private-legal/support"))}</span> 即可；当前步骤不用先处理 support。</p>`}
          ${focusPackHasRefreshableUrls ? `<form method="post" action="/actions" class="action-form">
            <input type="hidden" name="action" value="refresh_official_sources">
            <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
            <input type="hidden" name="jurisdiction" value="${escapeHtml(packFocusCode)}">
            <input type="hidden" name="officialSourceUrlsText" value="${escapeHtml(focusPackSourceUrls)}">
            <button class="action-button" type="submit">重新抓取已填官方来源哈希</button>
          </form>` : `<p class="meta">当前还没有已填的官方 URL，所以这一步暂时没有额外辅助按钮。</p>`}
        </div>
      </details>` : ""}
      ${showPackEditor ? `<div class="pack-grid">` : `<details class="details-block"><summary>需要手工录入 ${escapeHtml(packFocusCode)} 发布资料包时再展开</summary><div class="pack-grid">`}
        <form method="post" action="/actions" class="panel form-grid">
          <input type="hidden" name="action" value="save_legal_pack">
          <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
          <input type="hidden" name="contentId" value="${escapeHtml(current?.id || "")}">
          <input type="hidden" name="jurisdiction" value="${escapeHtml(packFocusCode)}">
          ${showPackStatusField ? `<label class="${labelClass(focusPackFieldState.status)}" for="pack-status">状态</label>
          <select class="${fieldClass("select-input", focusPackFieldState.status)}" id="pack-status" name="status">
            <option value="draft" ${focusPack.status === "draft" ? "selected" : ""}>draft</option>
            <option value="active" ${focusPack.status === "active" ? "selected" : ""}>active</option>
          </select>
          ${fieldHelp(focusPackFieldState.status, "这一步要切到 active 才能解除该辖区阻断。")}` : hiddenField("status", focusPack.status)}
          ${showPackReviewedAtField ? `<label class="${labelClass(focusPackFieldState.reviewedAt)}" for="pack-reviewed-at">reviewedAt</label>
          <input class="${fieldClass("text-input wide", focusPackFieldState.reviewedAt)}" id="pack-reviewed-at" name="reviewedAt" value="${textValue(focusPack.reviewedAt)}" placeholder="2026-07-16T00:00:00Z">
          ${fieldHelp(focusPackFieldState.reviewedAt, "reviewedAt 需要是有效时间，且不能留空。")}` : hiddenField("reviewedAt", focusPack.reviewedAt)}
          ${showPackExpiresAtField ? `<label class="${labelClass(focusPackFieldState.expiresAt)}" for="pack-expires-at">expiresAt</label>
          <input class="${fieldClass("text-input wide", focusPackFieldState.expiresAt)}" id="pack-expires-at" name="expiresAt" value="${textValue(focusPack.expiresAt)}" placeholder="2026-10-14T00:00:00Z">
          ${fieldHelp(focusPackFieldState.expiresAt, "expiresAt 需要是未来有效时间，并符合策略允许的最长有效期。")}` : hiddenField("expiresAt", focusPack.expiresAt)}
          ${showPackCounselField ? `<label class="${labelClass(focusPackFieldState.counsel)}" for="pack-counsel-name">counsel.name</label>
          <input class="${fieldClass("text-input wide", focusPackFieldState.counsel)}" id="pack-counsel-name" name="counselName" value="${textValue(focusPack.counsel?.name)}" placeholder="Local counsel name">
          <label class="${labelClass(focusPackFieldState.counsel)}" for="pack-bar-jurisdiction">counsel.barJurisdiction</label>
          <input class="${fieldClass("text-input", focusPackFieldState.counsel)}" id="pack-bar-jurisdiction" name="counselBarJurisdiction" value="${textValue(focusPack.counsel?.barJurisdiction)}" maxlength="2" placeholder="如 GB / AR">
          <label class="${labelClass(focusPackFieldState.counsel)}" for="pack-signature-hash">counsel.signatureHash</label>
          <input class="${fieldClass("text-input wide", focusPackFieldState.counsel)}" id="pack-signature-hash" name="counselSignatureHash" value="${textValue(focusPack.counsel?.signatureHash)}" placeholder="64 位十六进制哈希">
          ${fieldHelp(focusPackFieldState.counsel, "需要本地律师姓名、执业辖区和真实 64 位 signatureHash。")}`
            : `${hiddenField("counselName", focusPack.counsel?.name)}${hiddenField("counselBarJurisdiction", focusPack.counsel?.barJurisdiction)}${hiddenField("counselSignatureHash", focusPack.counsel?.signatureHash)}`}
          ${showPackOfficialSourcesField ? `<label class="${labelClass(focusPackFieldState.officialSources)}" for="pack-official-sources">officialSources</label>
          <textarea class="${fieldClass("text-area", focusPackFieldState.officialSources)}" id="pack-official-sources" name="officialSourcesText" placeholder="每行一条：https://example.gov/doc 或 https://example.gov/doc | 2026-07-16T00:00:00Z | 64hexhash">${textValue(serializeOfficialSourcesInput(focusPack.officialSources || []))}</textarea>
          ${fieldHelp(focusPackFieldState.officialSources, "至少需要一条可访问的 https 官方来源。你可以先只填 URL；保存时系统会自动尝试补 checkedAt 与 contentHash。")}`
            : hiddenField("officialSourcesText", serializeOfficialSourcesInput(focusPack.officialSources || []))}
          ${hiddenField("notesText", (focusPack.notes || []).join("\n"))}
          ${hiddenPackFieldCount ? `<p class="meta">已通过校验的字段保持原值，不在这一步展开。</p>` : ""}
          <div class="actions"><button class="action-button primary" type="submit">保存发布资料包</button></div>
        </form>
        ${currentStage === "support" || !current ? `<article class="panel">
          <h3>support 私有材料</h3>
          <p class="meta">这里保存当前辖区的结构化私有法务材料。保存后系统会自动同步到发布资料包，并在只填了官方 URL 但还没 hash 时尝试补抓。</p>
          <p class="meta">${focusPackSupport ? `当前已存在 support 文件：` : "当前还没有 support 文件；你可以直接在这里创建。"}<span class="inline-code">${escapeHtml(focusSupportPath)}</span></p>
          <form method="post" action="/actions" class="form-grid">
              <input type="hidden" name="action" value="save_legal_support">
              <input type="hidden" name="returnTo" value="${escapeHtml(focusedReturnTo)}">
              <input type="hidden" name="contentId" value="${escapeHtml(current?.id || "")}">
              <input type="hidden" name="jurisdiction" value="${escapeHtml(packFocusCode)}">
            <label class="meta" for="support-status">support.status</label>
            <select class="select-input" id="support-status" name="status">
              <option value="draft" ${focusSupportDraft?.status === "draft" ? "selected" : ""}>draft</option>
              <option value="active" ${focusSupportDraft?.status === "active" ? "selected" : ""}>active</option>
            </select>
            <label class="meta" for="support-reviewed-at">support.reviewedAt</label>
            <input class="text-input wide" id="support-reviewed-at" name="reviewedAt" value="${textValue(focusSupportDraft?.reviewedAt)}" placeholder="2026-07-16T00:00:00Z">
            <label class="meta" for="support-expires-at">support.expiresAt</label>
            <input class="text-input wide" id="support-expires-at" name="expiresAt" value="${textValue(focusSupportDraft?.expiresAt)}" placeholder="2026-10-14T00:00:00Z">
            <label class="meta" for="support-counsel-name">support.counsel.name</label>
            <input class="text-input wide" id="support-counsel-name" name="counselName" value="${textValue(focusSupportDraft?.counselName)}" placeholder="Local counsel name">
            <label class="meta" for="support-bar-jurisdiction">support.counsel.barJurisdiction</label>
            <input class="text-input" id="support-bar-jurisdiction" name="counselBarJurisdiction" value="${textValue(focusSupportDraft?.counselBarJurisdiction)}" maxlength="2" placeholder="如 GB / AR">
            <label class="meta" for="support-signature-hash">support.counsel.signatureHash</label>
            <input class="text-input wide" id="support-signature-hash" name="counselSignatureHash" value="${textValue(focusSupportDraft?.counselSignatureHash)}" placeholder="64 位十六进制哈希">
            <label class="meta" for="support-official-sources">support.officialSources</label>
            <textarea class="text-area" id="support-official-sources" name="officialSourcesText" placeholder="每行一条：https://example.gov/doc | 2026-07-16T00:00:00Z | 64hexhash">${textValue(focusSupportDraft?.officialSourcesText)}</textarea>
            <label class="meta" for="support-notes">support.notes</label>
            <textarea class="text-area" id="support-notes" name="notesText" placeholder="每行一条备注">${textValue(focusSupportDraft?.notesText)}</textarea>
            <label class="meta" for="support-operator-flag">
              <input id="support-operator-flag" type="checkbox" name="operatorJurisdiction" value="1" ${focusSupportDraft?.operatorJurisdiction ? "checked" : ""}>
              这份 support 同时确认当前辖区就是发布主体辖区
            </label>
            <div class="actions"><button class="action-button primary" type="submit">保存 support 材料并同步发布资料包</button></div>
          </form>
          <p class="meta">如果勾选了“发布主体辖区”，保存后系统会同时更新发布主体辖区，并把该辖区加入当前发布资料包流转。</p>
        </article>` : ``}
      </div>${showPackEditor ? "" : `</details>`}
      `,
    }) : ""}
    <details class="panel details-block">
      <summary>不清楚这些字段是什么时再展开</summary>
      <ul class="list">
        <li>必须有真实的 <span class="inline-code">jurisdiction</span>、<span class="inline-code">reviewedAt</span>、<span class="inline-code">expiresAt</span>。</li>
        <li>必须有本地律师信息和真实的 <span class="inline-code">signatureHash</span>；这里不能自动生成。</li>
        <li>必须有真实可访问的官方来源、检查时间和内容哈希；这里不能自动伪造。</li>
        <li>只有校验通过的 <code>active</code> pack 才能解除发布阻断。</li>
      </ul>
    </details>`;
  return page({ title: "EventAnalysis 阻断处理台", body, notice, error });
}

async function serveStaticFrom(rootDir, pathname, stripPrefix, response) {
  let path = resolve(rootDir, `.${pathname.slice(stripPrefix.length) || "/"}`);
  if (path !== rootDir && !path.startsWith(rootDir + sep)) throw new Error("Invalid path");
  try {
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
  } catch {
    if (!extname(pathname)) path = resolve(path, "index.html");
  }
  await access(path);
  response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  createReadStream(path).pipe(response);
}

async function readForm(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function redirect(response, location) {
  response.writeHead(303, { location });
  response.end();
}

function parseJsonCommandResult(result) {
  const lines = String(result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines.at(-1) || "{}");
}

function commandFromEnv(envKey, fallback) {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string" || !part.length)) {
    throw new Error(`${envKey} must be a JSON array of command strings`);
  }
  return parsed;
}

function releaseSummaryNotice(file, summary) {
  if (summary.workflowStatus === "release_ready") return `已完成 ${file} 的中文本地预发，可交付发物审核`;
  if (summary.workflowStatus === "release_review_required") return `已记录 ${file} 的人工复核需求`;
  if (summary.workflowStatus === "release_blocked") return `已记录 ${file} 的系统中断，公开站点未发布，请查看稿件详情`;
  return `已更新 ${file} 的发布申请状态`;
}

async function nextLegalFollowupReturnTo(returnTo = "/") {
  const url = new URL(returnTo || "/", "http://127.0.0.1");
  if (url.pathname !== "/legal") return `${url.pathname}${url.search}${url.hash}`;
  const contentId = url.searchParams.get("content");
  if (!contentId) return "/";
  const state = await loadReviewAdminState(root);
  const current = state.items.find((item) => item.id === contentId);
  if (!current) return "/";
  return routeForDetail(current.id);
}

async function nextLegalFollowupNotice(returnTo = "/") {
  const url = new URL(returnTo || "/", "http://127.0.0.1");
  if (url.pathname === "/legal") return "下一步：回当前稿件继续处理";
  return "";
}

function uniqueNonZzJurisdictions(values = []) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
}

async function refreshPackOfficialSourcesIfNeeded(registry, jurisdiction) {
  const code = String(jurisdiction || "").trim().toUpperCase();
  const existing = registry.packs?.find((entry) => entry.jurisdiction === code) || null;
  if (!existing) return { registry, refreshed: false };
  const urls = (existing.officialSources || []).map((entry) => String(entry?.url || "").trim()).filter(Boolean);
  const needsRefresh = urls.length > 0 && (existing.officialSources || []).some((entry) => entry?.url && (!entry.checkedAt || !entry.contentHash));
  if (!needsRefresh) return { registry, refreshed: false };
  const officialSources = await fetchOfficialSources(urls, new Date());
  return {
    refreshed: true,
    registry: upsertLegalPack(registry, {
      jurisdiction: code,
      status: existing.status || "draft",
      reviewedAt: existing.reviewedAt || "",
      expiresAt: existing.expiresAt || "",
      counselName: existing.counsel?.name || "",
      counselBarJurisdiction: existing.counsel?.barJurisdiction || "",
      counselSignatureHash: existing.counsel?.signatureHash || "",
      officialSourcesText: serializeOfficialSourcesInput(officialSources),
      notesText: (existing.notes || []).join("\n"),
    }),
  };
}

export { refreshPackOfficialSourcesIfNeeded };

function autoActivatePackIfReady(registry, jurisdiction, policy, now = new Date()) {
  return autoActivateRegistryLegalPack(registry, jurisdiction, policy, now);
}

async function autoResolveReleaseBlockers(reviewItem, returnTo = "/") {
  const notices = [];
  const now = new Date();
  const loadCurrentContext = async () => {
    const state = await loadReviewAdminState(root);
    const current = state.items.find((item) => item.id === reviewItem.id);
    if (!current) throw new Error(`Review item not found: ${reviewItem.id}`);
    const legalSupport = await loadLegalSupportEntries(root);
    return { state, current, legalSupport };
  };

  let { state, current, legalSupport } = await loadCurrentContext();
  let registry = state.registry;

  if (current.legal?.operatorJurisdictionUnconfirmed) {
    const supportDetected = legalSupport.operatorDetection?.detectedJurisdiction || "";
    if (supportDetected) {
      const supportEntry = legalSupport.byJurisdiction.get(supportDetected);
      const imported = importLegalSupportRecord(registry, supportEntry?.normalized || { jurisdiction: supportDetected }, supportDetected);
      let nextRegistry = {
        ...imported.registry,
        operatorJurisdictions: [supportDetected],
        coverageQueue: {
          ...(imported.registry.coverageQueue || {}),
          operator: [supportDetected],
        },
      };
      nextRegistry = autoActivatePackIfReady(nextRegistry, supportDetected, state.policy, now).registry;
      const drafted = ensureLegalPackDrafts(nextRegistry, [supportDetected], new Date());
      await writeLegalRegistry(root, drafted.registry);
      notices.push(`已自动根据 support 材料确认发布主体辖区为 ${supportDetected}`);
      ({ state, current, legalSupport } = await loadCurrentContext());
      registry = state.registry;
    } else {
      const candidates = collectLegalDraftCandidateJurisdictions(state.registry, state.items);
      const sources = await fetchOperatorJurisdictionEvidence();
      const detection = detectOperatorJurisdictionFromTexts(sources, candidates);
      const weakSignals = collectOperatorJurisdictionWeakSignals(sources);
      const report = {
        checkedAt: new Date().toISOString(),
        mode: "site_discovery",
        urls: sources.map(({ url, finalUrl, status }) => ({ url, finalUrl, status })),
        detectedJurisdiction: detection.detectedJurisdiction,
        ambiguous: detection.ambiguous,
        jurisdictions: detection.jurisdictions,
        findings: detection.findings,
        weakSignals,
        diagnostics: {
          scannedSources: sources.length,
          contextualSourceCount: detection.contextualSourceCount || 0,
          contextualLineCount: detection.contextualLineCount || 0,
          note: detection.findings.length
            ? "至少一个公开页面出现了明确的主体辖区线索。"
            : weakSignals.length
              ? "公开页面只暴露了联系邮箱、版权或静态出版说明，这些都不足以唯一确认发布主体辖区。"
              : "已扫描当前公开 legal/about/contact 相关页面，但没有找到包含 registered / governed by / based in 等明确主体辖区措辞的公开文本。",
        },
      };
      await writePrivateJson(resolve(root, "private-legal/operator-jurisdiction-report.json"), report);
      if (!detection.detectedJurisdiction) {
        return appendMessage(routeForDetail(reviewItem.id), "notice", detection.ambiguous
          ? `未自动推进：公开证据命中了多个主体辖区候选 ${detection.jurisdictions.join("、")}，请手工确认`
          : "未自动识别到唯一明确的发布主体辖区；请展开手工入口确认");
      }
      const nextRegistry = {
        ...registry,
        operatorJurisdictions: [detection.detectedJurisdiction],
        coverageQueue: {
          ...(registry.coverageQueue || {}),
          operator: [detection.detectedJurisdiction],
        },
      };
      const drafted = ensureLegalPackDrafts(nextRegistry, [detection.detectedJurisdiction], new Date());
      await writeLegalRegistry(root, drafted.registry);
      await bootstrapLegalSupportTemplates(root, drafted.registry, [detection.detectedJurisdiction], { operatorJurisdiction: detection.detectedJurisdiction });
      notices.push(`已自动识别发布主体辖区为 ${detection.detectedJurisdiction}`);
      ({ state, current, legalSupport } = await loadCurrentContext());
      registry = state.registry;
    }
  }

  let applicableJurisdictions = uniqueNonZzJurisdictions([
    ...(current.legal?.blockedJurisdictions || []),
    ...((state.registry.operatorJurisdictions || [])[0] ? [state.registry.operatorJurisdictions[0]] : []),
  ]);
  const missingDraftCodes = applicableJurisdictions.filter((jurisdiction) => !state.packValidation.get(jurisdiction));
  if (missingDraftCodes.length) {
    const drafted = ensureLegalPackDrafts(registry, missingDraftCodes, new Date());
    if (drafted.created.length) {
      await writeLegalRegistry(root, drafted.registry);
      notices.push(`已自动补齐 draft legal pack：${drafted.created.join("、")}`);
      ({ state, current, legalSupport } = await loadCurrentContext());
      registry = state.registry;
    }
  }

  applicableJurisdictions = uniqueNonZzJurisdictions([
    ...(current.legal?.blockedJurisdictions || []),
    ...((state.registry.operatorJurisdictions || [])[0] ? [state.registry.operatorJurisdictions[0]] : []),
  ]);
  const operatorCode = String(state.registry.operatorJurisdictions?.[0] || "").trim().toUpperCase();
  const missingSupportCodes = applicableJurisdictions.filter((jurisdiction) => !legalSupport.byJurisdiction.has(jurisdiction));
  if (missingSupportCodes.length) {
    const bootstrapped = await bootstrapLegalSupportTemplates(root, registry, missingSupportCodes, { operatorJurisdiction: operatorCode });
    if (bootstrapped.created.length) {
      notices.push(`已自动生成 support 骨架：${bootstrapped.created.map((entry) => entry.jurisdiction).join("、")}`);
      ({ state, current, legalSupport } = await loadCurrentContext());
      registry = state.registry;
    }
  }

  applicableJurisdictions = uniqueNonZzJurisdictions([
    ...(current.legal?.blockedJurisdictions || []),
    ...((state.registry.operatorJurisdictions || [])[0] ? [state.registry.operatorJurisdictions[0]] : []),
  ]);
  const importableSupportCodes = applicableJurisdictions.filter((jurisdiction) => {
    const entry = legalSupport.byJurisdiction.get(jurisdiction);
    return entry && supportEntryHasMaterial(entry);
  });
  if (importableSupportCodes.length) {
    let nextRegistry = registry;
    for (const jurisdiction of importableSupportCodes) {
      const entry = legalSupport.byJurisdiction.get(jurisdiction);
      nextRegistry = importLegalSupportRecord(nextRegistry, entry.normalized, jurisdiction).registry;
      nextRegistry = autoActivatePackIfReady(nextRegistry, jurisdiction, state.policy, now).registry;
    }
    await writeLegalRegistry(root, nextRegistry);
    notices.push(`已自动导入 support 材料到 legal pack：${importableSupportCodes.join("、")}`);
    ({ state, current, legalSupport } = await loadCurrentContext());
    registry = state.registry;
  }

  applicableJurisdictions = uniqueNonZzJurisdictions([
    ...(current.legal?.blockedJurisdictions || []),
    ...((state.registry.operatorJurisdictions || [])[0] ? [state.registry.operatorJurisdictions[0]] : []),
  ]);
  const refreshedCodes = [];
  let refreshedRegistry = registry;
  for (const jurisdiction of applicableJurisdictions) {
    const refreshed = await refreshPackOfficialSourcesIfNeeded(refreshedRegistry, jurisdiction);
    if (!refreshed.refreshed) continue;
    refreshedRegistry = autoActivatePackIfReady(refreshed.registry, jurisdiction, state.policy, now).registry;
    refreshedCodes.push(jurisdiction);
  }
  if (refreshedCodes.length) {
    await writeLegalRegistry(root, refreshedRegistry);
    notices.push(`已自动刷新官方来源哈希：${refreshedCodes.join("、")}`);
    ({ state, current, legalSupport } = await loadCurrentContext());
  }

  const focusCode = uniqueNonZzJurisdictions(current.legal?.blockedJurisdictions || [])[0] || "";
  const nextReturnTo = await nextLegalFollowupReturnTo(routeForDetail(reviewItem.id));
  const nextStep = await nextLegalFollowupNotice(nextReturnTo);
  const summary = notices.length ? notices.join("；") : "当前没有额外可自动推进的阻断步骤";
  return appendMessage(nextReturnTo, "notice", `${summary}${nextStep ? `；${nextStep}` : ""}`);
}

async function startReleaseRequestFlow(reviewItem, {
  file,
  returnTo,
  action,
  forceApprove = false,
} = {}) {
  const releaseJob = await activeReviewJob(root, reviewItem.id, "release-request");
  if (releaseJob) {
    return appendMessage(returnTo, "notice", `${file} 的发布申请已经在处理中，请等待自动刷新结果`);
  }

  let reviewHtmlCreated = false;
  if (forceApprove || reviewItem.edition?.status !== "approved") {
    await updateReviewPacketStatus(root, file, "zh", "approved");
  }
  if (!reviewItem.readiness.reviewHtmlBuilt) {
    await runCommand(["npm", "run", "review:html", "--", `content/review-packets/${file}`], { cwd: root, timeoutMs: 900_000 });
    reviewHtmlCreated = true;
  }

  await setReviewWorkflowStatus(root, reviewItem, "release_requested", forceApprove
    ? "已通过编辑一键审核，正在执行独立预审与本地预发检查。"
    : "已提交中文发布申请，正在执行独立预审与本地预发检查。", {
    release: {
      requestedAt: new Date().toISOString(),
      requestedLocales: ["zh"],
      previewPath: reviewItem.readiness.previewPath,
    },
  });
  const child = spawn("node", ["pipeline/release-request.mjs", `content/review-packets/${file}`, "--locales=zh"], {
    cwd: root,
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
  });
  await writeReviewJob(root, reviewItem.id, "release-request", {
    pid: child.pid,
    action,
    file,
    startedAt: new Date().toISOString(),
  });
  child.unref();

  if (forceApprove) {
    return appendMessage(returnTo, "notice", `已一键通过 ${file}${reviewHtmlCreated ? "，并自动生成私有审稿 HTML" : ""}，正在后台执行中文发布检查`);
  }
  return appendMessage(returnTo, "notice", `已提交 ${file} 的中文发布申请${reviewHtmlCreated ? "，并自动补生成私有审稿 HTML" : ""}，正在后台处理中`);
}

async function handleAction(form) {
  const returnTo = form.returnTo || "/";
  if (form.action === "bootstrap_legal_support_templates") {
    const jurisdictions = String(form.jurisdictions || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (!jurisdictions.length) throw new Error("没有需要生成 support 骨架的辖区");
    const registry = await loadLegalRegistry(root, { required: false });
    const result = await bootstrapLegalSupportTemplates(root, registry, jurisdictions, {
      operatorJurisdiction: String(form.operatorJurisdiction || "").trim().toUpperCase(),
    });
    const createdText = result.created.length ? `已生成 support 骨架：${result.created.map((entry) => entry.jurisdiction).join("、")}` : "这些辖区的 support 骨架已存在";
    const skippedText = result.skipped.length ? `；已存在：${result.skipped.join("、")}` : "";
    return appendMessage(returnTo, "notice", `${createdText}${skippedText}`);
  }
  if (form.action === "bootstrap_legal_support_template") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    const operatorJurisdiction = ["1", "true", "yes", "on"].includes(String(form.operatorJurisdiction || "").trim().toLowerCase());
    const registry = await loadLegalRegistry(root, { required: false });
    const created = await createLegalSupportTemplate(root, registry, jurisdiction, { operatorJurisdiction });
    return appendMessage(returnTo, "notice", `已生成 ${jurisdiction} 的 support 骨架：${created.path}`);
  }
  if (form.action === "apply_operator_jurisdiction_from_support") {
    const support = await loadLegalSupportEntries(root);
    const detected = support.operatorDetection?.detectedJurisdiction;
    if (!detected) {
      throw new Error(support.operatorDetection?.ambiguous
        ? `support 材料里命中了多个发布主体辖区：${support.operatorDetection.jurisdictions.join("、")}`
        : "support 材料里没有唯一明确的发布主体辖区标记");
    }
    const supportEntry = support.byJurisdiction.get(detected);
    const registry = await loadLegalRegistry(root, { required: false });
    const imported = importLegalSupportRecord(registry, supportEntry?.normalized || { jurisdiction: detected }, detected);
    let next = {
      ...imported.registry,
      operatorJurisdictions: [detected],
      coverageQueue: {
        ...(imported.registry.coverageQueue || {}),
        operator: [detected],
      },
    };
    const policy = (await loadReviewAdminState(root)).policy;
    next = autoActivatePackIfReady(next, detected, policy, new Date()).registry;
    const drafted = ensureLegalPackDrafts(next, [detected], new Date());
    await writeLegalRegistry(root, drafted.registry);
    await syncSupportFileFromPack(root, drafted.registry, detected);
    const nextReturnTo = await nextLegalFollowupReturnTo(retargetLegalReturnTo(returnTo, detected));
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    return appendMessage(nextReturnTo, "notice", `已根据 support 材料确认发布主体辖区为 ${detected}，并同步导入该辖区 legal pack${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "import_legal_support_pack") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") throw new Error("请选择要导入的 legal pack 辖区");
    const support = await loadLegalSupportEntries(root);
    const supportEntry = support.byJurisdiction.get(jurisdiction);
    if (!supportEntry) throw new Error(`未找到 ${jurisdiction} 的 support 材料，请先把 ${jurisdiction}.json 放到 private-legal/support`);
    const registry = await loadLegalRegistry(root, { required: false });
    const policy = (await loadReviewAdminState(root)).policy;
    const imported = importLegalSupportRecord(registry, supportEntry.normalized, jurisdiction);
    const promoted = autoActivatePackIfReady(imported.registry, jurisdiction, policy, new Date());
    await writeLegalRegistry(root, promoted.registry);
    await syncSupportFileFromPack(root, promoted.registry, jurisdiction);
    const pack = promoted.registry.packs.find((entry) => entry.jurisdiction === jurisdiction);
    const validation = validateLegalPack(pack, policy);
    const nextReturnTo = await nextLegalFollowupReturnTo(returnTo);
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    const activationNotice = promoted.activated ? "，并已自动切到 active" : "";
    return appendMessage(nextReturnTo, "notice", `已从 support 材料导入 ${jurisdiction} legal pack${activationNotice}，${validationSummaryText(validation)}${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "set_operator_jurisdiction") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") throw new Error("发布主体辖区必须是已确认的两位代码，且不能继续使用 ZZ");
    const registry = await loadLegalRegistry(root, { required: false });
    const next = {
      ...registry,
      operatorJurisdictions: [jurisdiction],
      coverageQueue: {
        ...(registry.coverageQueue || {}),
        operator: [jurisdiction],
      },
    };
    const drafted = ensureLegalPackDrafts(next, [jurisdiction], new Date());
    await writeLegalRegistry(root, drafted.registry);
    const supportBootstrap = await bootstrapLegalSupportTemplates(root, drafted.registry, [jurisdiction], { operatorJurisdiction: jurisdiction });
    const summary = drafted.created.includes(jurisdiction)
      ? `已将发布主体辖区更新为 ${jurisdiction}，并自动创建该辖区的 draft legal pack`
      : `已将发布主体辖区更新为 ${jurisdiction}，该辖区 legal pack 已存在`;
    const supportSummary = supportBootstrap.created.length ? "，同时生成了对应 support 骨架" : "";
    const nextReturnTo = await nextLegalFollowupReturnTo(retargetLegalReturnTo(returnTo, jurisdiction));
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    return appendMessage(nextReturnTo, "notice", `${summary}${supportSummary}${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "bootstrap_legal_drafts") {
    const jurisdictions = String(form.jurisdictions || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (!jurisdictions.length) throw new Error("没有可生成草稿的辖区");
    const registry = await loadLegalRegistry(root, { required: false });
    const result = ensureLegalPackDrafts(registry, jurisdictions, new Date());
    await writeLegalRegistry(root, result.registry);
    const summary = result.created.length ? `已生成 draft legal pack：${result.created.join(", ")}` : "这些辖区的 legal pack 已存在，未新增草稿";
    return appendMessage(returnTo, "notice", summary);
  }
  if (form.action === "bootstrap_all_legal_drafts") {
    const state = await loadReviewAdminState(root);
    const jurisdictions = collectLegalDraftCandidateJurisdictions(state.registry, state.items);
    if (!jurisdictions.length) throw new Error("当前没有可生成草稿的辖区");
    const result = ensureLegalPackDrafts(state.registry, jurisdictions, new Date());
    await writeLegalRegistry(root, result.registry);
    const summary = result.created.length
      ? `已为全站缺口生成 draft legal pack：${result.created.join(", ")}`
      : "全站缺口对应的 legal pack 已存在，未新增草稿";
    return appendMessage(returnTo, "notice", summary);
  }
  if (form.action === "autodetect_operator_jurisdiction") {
    const state = await loadReviewAdminState(root);
    const candidates = collectLegalDraftCandidateJurisdictions(state.registry, state.items);
    const sources = await fetchOperatorJurisdictionEvidence();
    const detection = detectOperatorJurisdictionFromTexts(sources, candidates);
    const weakSignals = collectOperatorJurisdictionWeakSignals(sources);
    const report = {
      checkedAt: new Date().toISOString(),
      mode: "site_discovery",
      urls: sources.map(({ url, finalUrl, status }) => ({ url, finalUrl, status })),
      detectedJurisdiction: detection.detectedJurisdiction,
      ambiguous: detection.ambiguous,
      jurisdictions: detection.jurisdictions,
      findings: detection.findings,
      weakSignals,
      diagnostics: {
        scannedSources: sources.length,
        contextualSourceCount: detection.contextualSourceCount || 0,
        contextualLineCount: detection.contextualLineCount || 0,
        note: detection.findings.length
          ? "至少一个公开页面出现了明确的主体辖区线索。"
          : weakSignals.length
            ? "公开页面只暴露了联系邮箱、版权或静态出版说明，这些都不足以唯一确认发布主体辖区。"
            : "已扫描当前公开 legal/about/contact 相关页面，但没有找到包含 registered / governed by / based in 等明确主体辖区措辞的公开文本。",
      },
    };
    await writePrivateJson(resolve(root, "private-legal/operator-jurisdiction-report.json"), report);
    if (!detection.detectedJurisdiction) {
      return appendMessage(returnTo, "notice", detection.ambiguous
        ? `自动识别命中了多个候选辖区：${detection.jurisdictions.join("、")}，未自动改写`
        : "自动识别未发现唯一明确的发布主体辖区，保持当前配置不变");
    }
    const registry = await loadLegalRegistry(root, { required: false });
    const next = {
      ...registry,
      operatorJurisdictions: [detection.detectedJurisdiction],
      coverageQueue: {
        ...(registry.coverageQueue || {}),
        operator: [detection.detectedJurisdiction],
      },
    };
    const drafted = ensureLegalPackDrafts(next, [detection.detectedJurisdiction], new Date());
    await writeLegalRegistry(root, drafted.registry);
    await bootstrapLegalSupportTemplates(root, drafted.registry, [detection.detectedJurisdiction], { operatorJurisdiction: detection.detectedJurisdiction });
    const nextReturnTo = await nextLegalFollowupReturnTo(retargetLegalReturnTo(returnTo, detection.detectedJurisdiction));
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    return appendMessage(nextReturnTo, "notice", `自动识别并回填发布主体辖区为 ${detection.detectedJurisdiction}，并补了对应 support 骨架${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "detect_operator_jurisdiction_from_urls") {
    const state = await loadReviewAdminState(root);
    const candidates = collectLegalDraftCandidateJurisdictions(state.registry, state.items);
    const urls = parseLegalPackLines(form.operatorEvidenceUrlsText || "");
    if (!urls.length) throw new Error("至少提供一个公开证据 https URL");
    const sources = await fetchOperatorJurisdictionEvidenceFromUrls(urls);
    const detection = detectOperatorJurisdictionFromTexts(sources, candidates);
    const weakSignals = collectOperatorJurisdictionWeakSignals(sources);
    const report = {
      checkedAt: new Date().toISOString(),
      inputUrls: urls,
      urls: sources.map(({ url, finalUrl, status }) => ({ url, finalUrl, status })),
      detectedJurisdiction: detection.detectedJurisdiction,
      ambiguous: detection.ambiguous,
      jurisdictions: detection.jurisdictions,
      findings: detection.findings,
      weakSignals,
      diagnostics: {
        scannedSources: sources.length,
        contextualSourceCount: detection.contextualSourceCount || 0,
        contextualLineCount: detection.contextualLineCount || 0,
        note: detection.findings.length
          ? "外部公开证据中出现了明确的主体辖区线索。"
          : weakSignals.length
            ? "这些外部公开页面只暴露了邮箱、版权或静态出版说明，仍不足以唯一确认发布主体辖区。"
            : "这些外部公开页面没有出现 registered / governed by / based in 等明确主体辖区措辞。",
      },
      mode: "user_supplied_urls",
    };
    await writePrivateJson(resolve(root, "private-legal/operator-jurisdiction-report.json"), report);
    if (!detection.detectedJurisdiction) {
      return appendMessage(returnTo, "notice", detection.ambiguous
        ? `这些 URL 命中了多个候选辖区：${detection.jurisdictions.join("、")}，未自动改写`
        : "这些 URL 仍未提供唯一明确的发布主体辖区，保持当前配置不变");
    }
    const registry = await loadLegalRegistry(root, { required: false });
    const next = {
      ...registry,
      operatorJurisdictions: [detection.detectedJurisdiction],
      coverageQueue: {
        ...(registry.coverageQueue || {}),
        operator: [detection.detectedJurisdiction],
      },
    };
    const drafted = ensureLegalPackDrafts(next, [detection.detectedJurisdiction], new Date());
    await writeLegalRegistry(root, drafted.registry);
    await bootstrapLegalSupportTemplates(root, drafted.registry, [detection.detectedJurisdiction], { operatorJurisdiction: detection.detectedJurisdiction });
    const nextReturnTo = await nextLegalFollowupReturnTo(retargetLegalReturnTo(returnTo, detection.detectedJurisdiction));
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    return appendMessage(nextReturnTo, "notice", `已根据公开证据回填发布主体辖区为 ${detection.detectedJurisdiction}，并补了对应 support 骨架${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "export_legal_pack_task") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") throw new Error("请选择要导出的真实辖区代码");
    const contentId = String(form.contentId || "").trim();
    const state = await loadReviewAdminState(root);
    const current = contentId ? state.items.find((item) => item.id === contentId) || null : null;
    const pack = state.registry.packs.find((entry) => entry.jurisdiction === jurisdiction) || null;
    const validation = state.packValidation.get(jurisdiction) || null;
    const taskPath = await writeManualLegalTask(root, {
      content: current,
      contentId: contentId || "content",
      jurisdiction,
      pack,
      fieldState: validationFieldStates(validation),
      validation,
    }, new Date());
    return appendMessage(returnTo, "notice", `已生成 ${jurisdiction} 补料任务单：${taskPath}`);
  }
  if (form.action === "export_legal_pack_tasks") {
    const contentId = String(form.contentId || "").trim();
    const jurisdictions = uniqueNonZzJurisdictions(String(form.jurisdictions || "").split(","));
    if (!contentId) throw new Error("缺少当前稿件 ID");
    if (!jurisdictions.length) throw new Error("当前没有可导出的阻断辖区");
    const state = await loadReviewAdminState(root);
    const current = state.items.find((item) => item.id === contentId) || null;
    if (!current) throw new Error(`未找到稿件：${contentId}`);
    const written = [];
    for (const jurisdiction of jurisdictions) {
      const pack = state.registry.packs.find((entry) => entry.jurisdiction === jurisdiction) || null;
      const validation = state.packValidation.get(jurisdiction) || null;
      const taskPath = await writeManualLegalTask(root, {
        content: current,
        contentId,
        jurisdiction,
        pack,
        fieldState: validationFieldStates(validation),
        validation,
      }, new Date());
      written.push({ jurisdiction, path: taskPath });
    }
    return appendMessage(returnTo, "notice", `已为当前稿件批量生成 ${written.length} 份补料任务单：${written.map((entry) => `${entry.jurisdiction} -> ${entry.path}`).join("；")}`);
  }
  if (form.action === "set_legal_task_status") {
    const contentId = String(form.contentId || "").trim();
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    const status = String(form.status || "").trim();
    if (!contentId) throw new Error("缺少当前稿件 ID");
    if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") throw new Error("缺少有效辖区代码");
    if (!["generated", "sent", "received", "applied"].includes(status)) throw new Error("未知任务状态");
    const registry = await loadManualLegalTaskRegistry(root, { required: false });
    let existing = registry.tasks?.[manualLegalTaskKey(contentId, jurisdiction)] || null;
    if (!existing?.path) {
      const taskEntries = await loadManualLegalTaskEntries(root, contentId, [jurisdiction]);
      const fallback = taskEntries.byJurisdiction.get(jurisdiction) || null;
      if (!fallback?.path) throw new Error(`当前没有 ${jurisdiction} 的补料任务单，先生成任务单再更新状态`);
      existing = { ...(existing || {}), path: fallback.path };
    }
    await saveManualLegalTaskStatus(root, {
      contentId,
      jurisdiction,
      status,
      path: existing.path,
    }, new Date());
    return appendMessage(returnTo, "notice", `已将 ${jurisdiction} 补料任务单状态更新为：${manualLegalTaskStatusLabel(status)}`);
  }
  if (form.action === "save_legal_pack") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    const contentId = String(form.contentId || "").trim();
    const registry = await loadLegalRegistry(root, { required: false });
    let next = upsertLegalPack(registry, {
      jurisdiction,
      status: form.status,
      reviewedAt: form.reviewedAt,
      expiresAt: form.expiresAt,
      counselName: form.counselName,
      counselBarJurisdiction: form.counselBarJurisdiction,
      counselSignatureHash: form.counselSignatureHash,
      officialSourcesText: form.officialSourcesText,
      notesText: form.notesText,
      status: "draft",
    });
    const refreshed = await refreshPackOfficialSourcesIfNeeded(next, jurisdiction);
    next = refreshed.registry;
    const policy = (await loadReviewAdminState(root)).policy;
    const promoted = autoActivatePackIfReady(next, jurisdiction, policy, new Date());
    next = promoted.registry;
    await writeLegalRegistry(root, next);
    await syncSupportFileFromPack(root, next, jurisdiction);
    const pack = next.packs.find((entry) => entry.jurisdiction === jurisdiction);
    const validation = validateLegalPack(pack, policy);
    const nextReturnTo = await nextLegalFollowupReturnTo(returnTo);
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    const refreshNotice = refreshed.refreshed ? "，并已自动补抓官方来源哈希" : "";
    const activationNotice = promoted.activated ? "，并已自动切到 active" : "";
    if (contentId) {
      await saveManualLegalTaskStatus(root, {
        contentId,
        jurisdiction,
        status: validation.ok ? "applied" : "received",
      }, new Date());
    }
    return appendMessage(nextReturnTo, "notice", `已保存 ${jurisdiction} 的 legal pack，并同步 support 材料${refreshNotice}${activationNotice}，${validationSummaryText(validation)}${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "save_legal_support") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    const contentId = String(form.contentId || "").trim();
    const normalized = normalizeLegalSupportRecord({
      jurisdiction,
      status: form.status,
      reviewedAt: form.reviewedAt,
      expiresAt: form.expiresAt,
      counselName: form.counselName,
      counselBarJurisdiction: form.counselBarJurisdiction,
      counselSignatureHash: form.counselSignatureHash,
      officialSourcesText: form.officialSourcesText,
      notesText: form.notesText,
      operatorJurisdiction: ["1", "true", "yes", "on"].includes(String(form.operatorJurisdiction || "").trim().toLowerCase()),
    }, jurisdiction);
    const supportDocument = {
      jurisdiction: normalized.jurisdiction,
      status: normalized.status,
      operatorJurisdiction: normalized.operatorJurisdiction,
      reviewedAt: normalized.reviewedAt,
      expiresAt: normalized.expiresAt,
      counsel: {
        name: normalized.counselName,
        barJurisdiction: normalized.counselBarJurisdiction,
        signatureHash: normalized.counselSignatureHash,
      },
      officialSources: parseOfficialSourcesInput(normalized.officialSourcesText),
      notes: parseLegalPackLines(normalized.notesText),
    };
    await writePrivateJson(legalSupportPath(root, jurisdiction), supportDocument);
    let registry = await loadLegalRegistry(root, { required: false });
    let next = importLegalSupportRecord(registry, normalized, jurisdiction).registry;
    let operatorNotice = "";
    if (normalized.operatorJurisdiction) {
      next = {
        ...next,
        operatorJurisdictions: [jurisdiction],
        coverageQueue: {
          ...(next.coverageQueue || {}),
          operator: [jurisdiction],
        },
      };
      operatorNotice = `，并确认 ${jurisdiction} 为发布主体辖区`;
    }
    next = ensureLegalPackDrafts(next, [jurisdiction], new Date()).registry;
    const refreshed = await refreshPackOfficialSourcesIfNeeded(next, jurisdiction);
    next = refreshed.registry;
    const policy = (await loadReviewAdminState(root)).policy;
    const promoted = autoActivatePackIfReady(next, jurisdiction, policy, new Date());
    next = promoted.registry;
    await writeLegalRegistry(root, next);
    await syncSupportFileFromPack(root, next, jurisdiction);
    const pack = next.packs.find((entry) => entry.jurisdiction === jurisdiction);
    const validation = validateLegalPack(pack, policy);
    const nextReturnTo = await nextLegalFollowupReturnTo(retargetLegalReturnTo(returnTo, jurisdiction));
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    const refreshNotice = refreshed.refreshed ? "，并已自动补抓官方来源哈希" : "";
    const activationNotice = promoted.activated ? "，并已自动切到 active" : "";
    if (contentId) {
      await saveManualLegalTaskStatus(root, {
        contentId,
        jurisdiction,
        status: validation.ok ? "applied" : "received",
      }, new Date());
    }
    return appendMessage(nextReturnTo, "notice", `已保存 ${jurisdiction} 的 support 材料${operatorNotice}，并同步到 legal pack${refreshNotice}${activationNotice}；${validationSummaryText(validation)}${nextStep ? `；${nextStep}` : ""}`);
  }
  if (form.action === "refresh_official_sources") {
    const jurisdiction = String(form.jurisdiction || "").trim().toUpperCase();
    const urls = parseLegalPackLines(form.officialSourceUrlsText || "");
    if (!urls.length) throw new Error("至少提供一个 https 官方来源 URL");
    const registry = await loadLegalRegistry(root, { required: false });
    const existing = registry.packs?.find((pack) => pack.jurisdiction === jurisdiction) || null;
    const officialSources = await fetchOfficialSources(urls, new Date());
    let next = upsertLegalPack(registry, {
      jurisdiction,
      status: existing?.status || "draft",
      reviewedAt: existing?.reviewedAt || "",
      expiresAt: existing?.expiresAt || "",
      counselName: existing?.counsel?.name || "",
      counselBarJurisdiction: existing?.counsel?.barJurisdiction || "",
      counselSignatureHash: existing?.counsel?.signatureHash || "",
      officialSourcesText: serializeOfficialSourcesInput(officialSources),
      notesText: (existing?.notes || []).join("\n"),
    });
    const policy = (await loadReviewAdminState(root)).policy;
    const promoted = autoActivatePackIfReady(next, jurisdiction, policy, new Date());
    next = promoted.registry;
    await writeLegalRegistry(root, next);
    await syncSupportFileFromPack(root, next, jurisdiction);
    const pack = next.packs.find((entry) => entry.jurisdiction === jurisdiction);
    const validation = validateLegalPack(pack, policy);
    const nextReturnTo = await nextLegalFollowupReturnTo(returnTo);
    const nextStep = await nextLegalFollowupNotice(nextReturnTo);
    const activationNotice = promoted.activated ? "，并已自动切到 active" : "";
    return appendMessage(nextReturnTo, "notice", `已抓取 ${jurisdiction} 的 ${officialSources.length} 条官方来源哈希，并同步 support 材料${activationNotice}，${validationSummaryText(validation)}${nextStep ? `；${nextStep}` : ""}`);
  }
  if (!form.file) throw new Error("缺少 review packet 文件名");
  const detailState = await loadReviewAdminState(root);
  const reviewItem = detailState.items.find((item) => item.file === form.file);
  if (!reviewItem) throw new Error(`Review item not found: ${form.file}`);
  if (form.action === "autofix_release_blockers") {
    return autoResolveReleaseBlockers(reviewItem, returnTo);
  }
  const releaseJob = await activeReviewJob(root, reviewItem.id, "release-request");
  if (releaseJob && !["submit_release_zh", "preview_zh", "approve_and_submit_zh"].includes(form.action)) {
    throw new Error("该稿件的发布申请仍在处理中，请等待处理完成后再执行其他动作");
  }
  if (form.action === "approve_zh") {
    await updateReviewPacketStatus(root, form.file, "zh", "approved");
    await setReviewWorkflowStatus(root, reviewItem, "editorial_approved", "中文主稿已批准，等待生成审稿材料或提交发布申请。");
    return appendMessage(returnTo, "notice", `已将 ${form.file} 标记为 approved`);
  }
  if (form.action === "approve_and_submit_zh") {
    return startReleaseRequestFlow(reviewItem, {
      file: form.file,
      returnTo,
      action: form.action,
      forceApprove: true,
    });
  }
  if (form.action === "reset_zh") {
    await updateReviewPacketStatus(root, form.file, "zh", "needs_review");
    await setReviewWorkflowStatus(root, reviewItem, "review_pending", "稿件已退回待编辑一键通过。");
    return appendMessage(returnTo, "notice", `已将 ${form.file} 退回 needs_review`);
  }
  if (form.action === "quarantine_zh") {
    await updateReviewPacketStatus(root, form.file, "zh", "quarantined");
    await setReviewWorkflowStatus(root, reviewItem, "quarantined", "稿件已隔离，禁止进入发布申请。");
    return appendMessage(returnTo, "notice", `已将 ${form.file} 标记为 quarantined`);
  }
  if (form.action === "build_review_html") {
    const result = await runCommand(["npm", "run", "review:html", "--", `content/review-packets/${form.file}`], { cwd: root, timeoutMs: 900_000 });
    const summary = parseJsonCommandResult(result);
    return appendMessage(returnTo, "notice", `已生成 ${form.file} 的私有审稿 HTML：${summary.reviewHtmlRoute || reviewHtmlRoute(reviewItem.id)}`);
  }
  if (form.action === "submit_release_zh" || form.action === "preview_zh") {
    return startReleaseRequestFlow(reviewItem, {
      file: form.file,
      returnTo,
      action: form.action,
      forceApprove: false,
    });
  }
  if (form.action === "review_pr") {
    const result = await runCommand(commandFromEnv("EA_REVIEW_PR_COMMAND_JSON", ["npm", "run", "review:pr"]), { cwd: root, timeoutMs: 180_000 });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "草稿 PR 已创建";
    return appendMessage(returnTo, "notice", line);
  }
  throw new Error(`未知动作: ${form.action}`);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/preview/") || pathname === "/preview") {
      await serveStaticFrom(previewRoot, pathname, "/preview", response);
      return;
    }
    if (pathname.startsWith("/private-review/")) {
      await serveStaticFrom(privateReviewRoot, pathname, "/private-review", response);
      return;
    }
    if (pathname.startsWith("/private-legal-task/")) {
      await serveStaticFrom(privateTaskRoot, pathname, "/private-legal-task", response);
      return;
    }
    if (pathname.startsWith("/review-preview/")) {
      const id = pathname.slice("/review-preview/".length);
      const state = await loadReviewAdminItem(root, id);
      if (!state) throw new Error("Review item not found");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderReviewPreviewHtml(state.current));
      return;
    }
    if (request.method === "POST" && pathname === "/actions") {
      const form = await readForm(request);
      try {
        redirect(response, await handleAction(form));
      } catch (error) {
        redirect(response, appendMessage(form.returnTo || "/", "error", actionErrorMessage(error)));
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new Error("Method not allowed");
    const notice = url.searchParams.get("notice") || "";
    const error = url.searchParams.get("error") || "";
    if (pathname === "/") {
      const state = await loadReviewAdminState(root);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(dashboardPage(state, notice, error));
      return;
    }
    if (pathname === "/legal") {
      const state = await loadReviewAdminState(root);
      const fallbackFocus = defaultLegalFocus(state);
      const currentId = url.searchParams.get("content") || fallbackFocus.currentId;
      const current = currentId ? state.items.find((item) => item.id === currentId) || null : null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(retiredLegalEntryPage(state, notice, error, current));
      return;
    }
    if (pathname.startsWith("/items/")) {
      const id = pathname.slice("/items/".length);
      const state = await loadReviewAdminItem(root, id);
      if (!state) throw new Error("Review item not found");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(detailPage(state, notice, error));
      return;
    }
    throw new Error("Not found");
  } catch (error) {
    console.error("[review-admin]", error);
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(/Method not allowed/.test(String(error.message)) ? 405 : 404, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error.message || "Not found"));
  }
});

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Review admin running on http://127.0.0.1:${port}`);
  });
}
