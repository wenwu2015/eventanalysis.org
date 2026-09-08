#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const sourceArg = process.argv.find((value) => value.startsWith("--source="));
const sourceFile = resolve(root, sourceArg ? sourceArg.slice("--source=".length) : "content/review-packets/match-12812996-analysis-zh.json");
const port = Number(process.argv.find((value) => value.startsWith("--port="))?.slice("--port=".length) || 3216);

const sourcePacket = JSON.parse(await readFile(sourceFile, "utf8"));
const now = Date.now();
const testId = `${sourcePacket.id}-e2e-${now}`;
const testFile = `__review-admin-e2e-${now}.json`;
const testPath = resolve(root, "content/review-packets", testFile);
const stagedItemPath = resolve(root, "content/data/items", `${testId}.json`);
const reportPath = resolve(root, "private-compliance/reports", `${testId}-r1.json`);
const reviewHtmlPath = resolve(root, "private-review/html", testId, "index.html");
const reviewHtmlDir = resolve(root, "private-review/html", testId);
const workflowPath = resolve(root, "private-review/workflows", `${testId}.json`);
const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Users/a1111/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell",
];

let server;
const summary = {
  port,
  testId,
  testFile,
  checks: [],
};

function recordCheck(name, details = {}) {
  summary.checks.push({ name, ...details });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  await Promise.all([
    rm(testPath, { force: true }),
    rm(stagedItemPath, { force: true }),
    rm(reportPath, { force: true }),
    rm(reviewHtmlPath, { force: true }),
    rm(reviewHtmlDir, { force: true, recursive: true }),
    rm(workflowPath, { force: true }),
  ]);
}

async function browserExecutablePath() {
  for (const candidate of browserCandidates) if (await pathExists(candidate)) return candidate;
  throw new Error(`No browser executable found. Checked: ${browserCandidates.join(", ")}`);
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("review-admin server did not become ready");
}

async function workflowState() {
  return JSON.parse(await readFile(workflowPath, "utf8"));
}

async function waitForText(page, text, timeoutMs = 10_000) {
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), text, { timeout: timeoutMs });
}

async function waitForWorkflowStatus(expectedStatuses, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const workflow = await workflowState();
      if (expectedStatuses.includes(workflow.status)) return workflow;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Workflow did not reach one of: ${expectedStatuses.join(", ")}`);
}

async function clickAndWaitNavigation(page, target, expectedText) {
  const before = page.url();
  await target.click();
  await page.waitForURL((url) => url.toString() !== before, { timeout: 5_000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  if (expectedText) await waitForText(page, expectedText);
}

async function clickButtonIn(page, container, label, expectedText) {
  const button = container.getByRole("button", { name: label, exact: true });
  await clickAndWaitNavigation(page, button, expectedText);
}

async function openLinkIn(page, container, label, expectedText) {
  const link = container.getByRole("link", { name: label, exact: true });
  await clickAndWaitNavigation(page, link, expectedText);
}

async function openLocator(page, locator, expectedText) {
  await clickAndWaitNavigation(page, locator.first(), expectedText);
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

  server = spawn("node", ["pipeline/review-admin.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      EA_AI_CONFIG: "pipeline/config/ai.smoke.json",
      EA_REVIEW_PR_COMMAND_JSON: JSON.stringify(["node", "tests/helpers/mock-review-pr.mjs"]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();

  const browser = await chromium.launch({
    executablePath: await browserExecutablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const dashboardUrl = `http://127.0.0.1:${port}/`;
  const detailUrl = `http://127.0.0.1:${port}/items/${encodeURIComponent(testId)}`;
  const dynamicReviewUrl = `http://127.0.0.1:${port}/review-preview/${encodeURIComponent(testId)}`;
  const staticReviewUrl = `http://127.0.0.1:${port}/private-review/${encodeURIComponent(testId)}/`;
  const rowLink = page.locator(`a[href="/items/${encodeURIComponent(testId)}"]`);

  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await waitForText(page, "审稿队列");
  assert.ok(await rowLink.count() >= 1, "Synthetic review row should be present on dashboard");
  const row = page.locator("article.queue-card").filter({ has: rowLink });
  recordCheck("dashboard_loaded", { ok: true });

  await clickButtonIn(page, row, "重新触发自动审稿", "自动编辑部监控台");
  workflow = await workflowState();
  assert.ok(["autopilot_queued", "autopilot_reviewing", "autopilot_rewriting", "autopilot_publishing", "autopilot_failed", "published"].includes(workflow.status));
  await waitForText(page, "自动编辑部监控台");
  workflow = await waitForWorkflowStatus(["autopilot_failed", "published", "quarantined"], 120_000);
  recordCheck("dashboard_autopilot", { ok: true, workflowStatus: workflow.status, decision: workflow.autopilot?.lastEditorDecision || null });

  await openLocator(page, rowLink, "稿件详情");
  assert.equal(page.url(), detailUrl);
  recordCheck("detail_opened", { ok: true });

  recordCheck("detail_loaded", { ok: true });

  await openLinkIn(page, page.locator("main"), "打开动态审稿页", "此页面仅用于私有审稿与发物审核");
  assert.equal(page.url(), dynamicReviewUrl);
  recordCheck("detail_dynamic_review_link", { ok: true });

  await page.goBack({ waitUntil: "domcontentloaded" });
  await waitForText(page, "稿件详情");

  if (await page.getByRole("link", { name: "打开静态 HTML", exact: true }).count()) {
    await openLinkIn(page, page.locator("main"), "打开静态 HTML", "此页面仅用于私有审稿与发物审核");
    assert.equal(page.url(), staticReviewUrl);
    recordCheck("detail_static_review_link", { ok: true });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await waitForText(page, "稿件详情");
  } else {
    recordCheck("detail_static_review_link", { ok: true, skipped: true });
  }

  await clickButtonIn(page, page.locator("main"), "隔离稿件", "标记为 quarantined");
  workflow = await workflowState();
  assert.equal(workflow.status, "quarantined");
  await waitForText(page, "发布申请状态: 已隔离");
  recordCheck("detail_quarantine", { ok: true, workflowStatus: workflow.status });

  await clickButtonIn(page, page.locator("main"), "退回待审", "退回 needs_review");
  workflow = await workflowState();
  assert.equal(workflow.status, "review_pending");
  await waitForText(page, "发布申请状态: 待自动审稿");
  recordCheck("detail_reset", { ok: true, workflowStatus: workflow.status });

  await clickButtonIn(page, page.locator("main"), "重新触发自动审稿", "稿件详情");
  workflow = await workflowState();
  assert.ok(["autopilot_queued", "autopilot_reviewing", "autopilot_rewriting", "autopilot_publishing", "autopilot_failed", "published"].includes(workflow.status));
  workflow = await waitForWorkflowStatus(["autopilot_failed", "published", "quarantined"], 120_000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await waitForText(page, `发布申请状态: ${workflow.status === "autopilot_failed" ? "自动流程失败" : workflow.status === "published" ? "已发布" : "已隔离"}`);
  recordCheck("detail_autopilot", { ok: true, workflowStatus: workflow.status, decision: workflow.autopilot?.lastEditorDecision || null });

  await openLinkIn(page, page.locator("main"), "返回审稿队列", "审稿队列");
  assert.equal(page.url(), dashboardUrl);
  recordCheck("back_to_dashboard", { ok: true });

  summary.workflowStatus = (await workflowState()).status;
  summary.reviewHtmlCreated = await pathExists(reviewHtmlPath);
  summary.agentReportCreated = await pathExists(reportPath);
  summary.result = "PASS";

  await browser.close();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await cleanup();
}
