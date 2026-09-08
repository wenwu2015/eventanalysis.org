#!/usr/bin/env node
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { runCommand } from "./lib/command-runner.mjs";
import { findContentItemFile, loadCompliancePolicy } from "./lib/compliance-store.mjs";
import { applyAutopilotPublicationState, autopilotApprovalOf, autopilotRequestedLocales } from "./lib/autopilot.mjs";
import { deriveReviewLifecycle, reviewWorkflowPath, setReviewWorkflowStatus } from "./lib/review-workflow.mjs";
import { resolveAutomationNow, resolveAutomationNowIso } from "./lib/automation-clock.mjs";

const root = resolve(import.meta.dirname, "..");
const automationNow = resolveAutomationNow(process.env.EA_NOW_ISO);
const automationNowIso = resolveAutomationNowIso(process.env.EA_NOW_ISO);
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const fileArg = process.argv.slice(2).find((value) => !value.startsWith("--"));

if (!contentFlag && !fileArg) {
  throw new Error("Usage: npm run publish:agent -- --content=<id> OR content/review-packets/<file>.json");
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function requestedLocalesFor(policy, approval) {
  const localeCatalog = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
  return autopilotRequestedLocales(localeCatalog, approval?.publishLocales || null, policy.automaticPublicationLocales || null);
}

async function latestAwsLiveReport() {
  const directory = resolve(root, "pipeline/runtime/aws-release");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const folders = entries.filter((entry) => entry.isDirectory()).sort((left, right) => right.name.localeCompare(left.name));
  if (!folders.length) return null;
  return `pipeline/runtime/aws-release/${folders[0].name}/live-e2e-report.json`;
}

const policy = await loadCompliancePolicy(root);
const packetPath = fileArg ? resolve(root, fileArg) : resolve(root, "content/review-packets", `${contentFlag.slice("--content=".length)}.json`);
const packet = JSON.parse(await readFile(packetPath, "utf8"));
const approval = autopilotApprovalOf(packet, automationNow);
if (!approval) throw new Error(`Autopilot approval is missing or expired for ${packet.id}`);
const requestedLocales = await requestedLocalesFor(policy, approval);

let publishable = applyAutopilotPublicationState(packet, {
  policy,
  locales: ["zh"],
  approval,
  publish: false,
});

const existing = await findContentItemFile(root, publishable.id);
if (existing) {
  existing.records[existing.index] = publishable;
  await writeFile(existing.path, `${JSON.stringify(existing.wrapper ? existing.packet : publishable, null, 2)}\n`);
} else {
  await writeFile(resolve(root, "content/data/items", `${publishable.id}.json`), `${JSON.stringify(publishable, null, 2)}\n`);
}

const workflowItem = {
  ...publishable,
  file: basename(packetPath),
};

await setReviewWorkflowStatus(root, workflowItem, "autopilot_publishing", approval.summary || "自动编辑部正在执行生产发布。", {
  lifecycle: deriveReviewLifecycle(publishable, {
    sourceItem: publishable,
    sourceItemPath: `content/data/items/${publishable.id}.json`,
  }),
  autopilot: {
    status: "publishing",
    lastEditorDecision: "approve",
    overrideFindings: approval.overrideFindings || [],
    lastError: null,
  },
});

try {
  await runCommand([
    "npm",
    "run",
    "release:aws",
    "--",
    "--confirm-production",
    `--content=${publishable.id}`,
    `--locales=${requestedLocales.join(",")}`,
  ], { cwd: root, timeoutMs: 3_600_000 });
  const staged = await findContentItemFile(root, publishable.id);
  publishable = staged?.item || publishable;
  const liveReportPath = await latestAwsLiveReport();
  await setReviewWorkflowStatus(root, publishable, "published", "自动编辑部已完成正式发布与线上验收。", {
    lifecycle: deriveReviewLifecycle(publishable, {
      sourceItem: publishable,
      sourceItemPath: `content/data/items/${publishable.id}.json`,
      forceStatus: "published",
      now: publishable.publishedAt || automationNowIso,
    }),
    autopilot: {
      status: "published",
      finishedAt: automationNowIso,
      releaseReportPath: "pipeline/runtime/compliance/release-report.json",
      liveReportPath,
      lastError: null,
    },
  });
  await rename(packetPath, resolve(root, "content/review-packets", `${basename(packetPath, ".json")}.published.json`)).catch(() => {});
  console.log(JSON.stringify({
    status: "published",
    contentId: publishable.id,
    releaseReportPath: "pipeline/runtime/compliance/release-report.json",
    liveReportPath,
  }, null, 2));
} catch (error) {
  await setReviewWorkflowStatus(root, workflowItem, "autopilot_failed", "自动编辑部在生产发布阶段失败。", {
    autopilot: {
      status: "failed",
      finishedAt: automationNowIso,
      releaseReportPath: "pipeline/runtime/compliance/release-report.json",
      lastError: String(error?.message || error).slice(-2_000),
    },
  });
  await runCommand(["npm", "run", "emergency:freeze", "--", "--reason=autopilot_release_failure"], { cwd: root, timeoutMs: 1_800_000 }).catch(() => {});
  throw error;
}
