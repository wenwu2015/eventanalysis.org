#!/usr/bin/env node
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const sourceArg = process.argv.find((value) => value.startsWith("--source="));
const sourceFile = resolve(root, sourceArg ? sourceArg.slice("--source=".length) : "content/review-packets/match-12812996-analysis-zh.json");
const port = Number(process.argv.find((value) => value.startsWith("--port="))?.slice("--port=".length) || 3215);
const withPr = process.argv.includes("--with-pr");

const sourcePacket = JSON.parse(await readFile(sourceFile, "utf8"));
const now = Date.now();
const testId = `${sourcePacket.id}-smoke-${now}`;
const testFile = `__review-admin-smoke-${now}.json`;
const testPath = resolve(root, "content/review-packets", testFile);
const stagedItemPath = resolve(root, "content/data/items", `${testId}.json`);
const reportPath = resolve(root, "private-compliance/reports", `${testId}-r1.json`);
const reviewHtmlPath = resolve(root, "private-review/html", testId, "index.html");
const reviewHtmlDir = resolve(root, "private-review/html", testId);
const workflowPath = resolve(root, "private-review/workflows", `${testId}.json`);
const redirects = [];
let child;

async function cleanup() {
  if (child && !child.killed) child.kill("SIGTERM");
  await Promise.all([
    rm(testPath, { force: true }),
    rm(stagedItemPath, { force: true }),
    rm(reportPath, { force: true }),
    rm(reviewHtmlPath, { force: true }),
    rm(reviewHtmlDir, { force: true, recursive: true }),
    rm(workflowPath, { force: true }),
  ]);
}

function summarizeRedirect(location) {
  const value = decodeURIComponent(location || "");
  const match = value.match(/[?&](?:notice|error)=([^&]+)/);
  return match ? match[1] : value;
}

async function waitForReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("review-admin server did not become ready");
}

async function fetchText(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function postAction(action, file, returnTo) {
  const body = new URLSearchParams({ action, file, returnTo });
  const response = await fetch(`http://127.0.0.1:${port}/actions`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const location = response.headers.get("location") || "";
  redirects.push({ action, status: response.status, location, summary: summarizeRedirect(location) });
  return { status: response.status, location };
}

async function waitForWorkflowStatus(expectedStatuses, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workflow = await readFile(workflowPath, "utf8").then((value) => JSON.parse(value)).catch(() => null);
    if (workflow && expectedStatuses.includes(workflow.status)) return workflow;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return null;
}

try {
  const packet = structuredClone(sourcePacket);
  packet.id = testId;
  packet.reviewedAt = null;
  packet.editions.zh.status = "needs_review";
  packet.editions.zh.complianceStatus = "unreviewed";
  delete packet.editions.zh.allowedJurisdictions;
  delete packet.editions.zh.complianceValidUntil;
  await writeFile(testPath, `${JSON.stringify(packet, null, 2)}\n`);

  child = spawn("node", ["pipeline/review-admin.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), EA_AI_CONFIG: "pipeline/config/ai.smoke.json" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForReady();

  const summary = { testId, testFile, redirects, withPr };
  const detailPath = `/items/${encodeURIComponent(testId)}`;

  const dashboard = await fetchText("/");
  summary.dashboardLoaded = dashboard.status === 200 && dashboard.text.includes(testId);

  const detailBefore = await fetchText(detailPath);
  summary.detailBeforeLoaded = detailBefore.status === 200 && detailBefore.text.includes("待自动审稿");

  const autopilotAction = await postAction("rerun_autopilot", testFile, detailPath);
  summary.autopilotActionRedirect = autopilotAction.location;
  summary.autopilotActionSummary = summarizeRedirect(autopilotAction.location);
  summary.autopilotActionErrored = autopilotAction.location.includes("error=");

  const detailQueued = await fetchText(detailPath);
  summary.processingVisible = detailQueued.text.includes("发布申请状态: 自动排队中")
    || detailQueued.text.includes("发布申请状态: 自动审稿中")
    || detailQueued.text.includes("发布申请状态: 自动改稿中")
    || detailQueued.text.includes("发布申请状态: 自动发布中")
    || detailQueued.text.includes("发布申请状态: 自动流程失败")
    || detailQueued.text.includes("发布申请状态: 已发布");

  const detailAfterReviewHtml = await fetchText(detailPath);
  summary.reviewHtmlVisible = detailAfterReviewHtml.text.includes("打开静态 HTML");
  summary.dynamicReviewVisible = detailAfterReviewHtml.text.includes("打开动态审稿页");
  summary.reviewHtmlCreated = await readFile(reviewHtmlPath, "utf8").then(() => true).catch(() => false);

  const detailDuringRelease = await fetchText(detailPath);
  summary.autopilotActiveVisible = detailDuringRelease.text.includes("自动编辑部")
    || detailDuringRelease.text.includes("自动审稿中")
    || detailDuringRelease.text.includes("自动发布中");
  summary.autopilotPendingNoticeVisible = detailDuringRelease.text.includes("当前稿件正在自动编辑部链路中处理");

  const workflow = await waitForWorkflowStatus(["autopilot_failed", "published", "quarantined"], 120_000);
  summary.workflowStatus = workflow?.status || null;
  summary.workflowReleaseDecision = workflow?.autopilot?.lastEditorDecision || null;
  const detailAfterRelease = await fetchText(detailPath);
  summary.autopilotFailedVisible = detailAfterRelease.text.includes("发布申请状态: 自动流程失败");
  summary.publishedVisible = detailAfterRelease.text.includes("发布申请状态: 已发布");
  summary.previewDetailStatus = /发布申请状态: ([^<]+)/.exec(detailAfterRelease.text)?.[1] || null;
  summary.stagedItemCreated = await readFile(stagedItemPath, "utf8").then(() => true).catch(() => false);
  summary.agentReportCreated = await readFile(reportPath, "utf8").then(() => true).catch(() => false);

  if (withPr) {
    const prAction = await postAction("review_pr", testFile, detailPath);
    summary.reviewPrRedirect = prAction.location;
    summary.reviewPrSummary = summarizeRedirect(prAction.location);
  }

  await postAction("quarantine_zh", testFile, detailPath);
  const detailQuarantined = await fetchText(detailPath);
  summary.quarantinedVisible = detailQuarantined.text.includes("发布申请状态: 已隔离");

  await postAction("reset_zh", testFile, detailPath);
  const detailReset = await fetchText(detailPath);
  summary.resetVisible = detailReset.text.includes("发布申请状态: 待自动审稿");

  const autopilotClosedLoop = ["autopilot_failed", "published", "quarantined"].includes(summary.workflowStatus);
  summary.result = summary.dashboardLoaded
    && summary.detailBeforeLoaded
    && summary.processingVisible
    && summary.dynamicReviewVisible
    && summary.autopilotActiveVisible
    && summary.quarantinedVisible
    && summary.resetVisible
    ? autopilotClosedLoop ? "PASS_WITH_WORKFLOW_STATE" : "BLOCK"
    : "BLOCK";

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await cleanup();
}
