#!/usr/bin/env node
import { basename, relative, resolve } from "node:path";
import { auditContentItem } from "./lib/compliance.mjs";
import { agentReportPath, loadAgentReport, loadCompliancePolicy, loadEvidenceRecords, loadLegalRegistry, loadSourceRegistry } from "./lib/compliance-store.mjs";
import { loadContentData } from "./lib/data-store.mjs";
import { summarizeEditorialReleaseReport } from "./lib/editorial-release.mjs";
import { loadReviewAdminItem, loadReviewAdminItemByFile } from "./lib/review-admin.mjs";
import { runCommand } from "./lib/command-runner.mjs";
import { removeReviewJob } from "./lib/review-jobs.mjs";
import { setReviewWorkflowStatus } from "./lib/review-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const inputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const contentFlag = process.argv.find((value) => value.startsWith("--content="));
const localeFlag = process.argv.find((value) => value.startsWith("--locales="));
const requestedLocales = (localeFlag ? localeFlag.slice("--locales=".length).split(",") : ["zh"]).map((value) => value.trim()).filter(Boolean);

if (!inputArg && !contentFlag) {
  throw new Error("Usage: npm run release:request -- <content/review-packets/file.json> OR --content=<id> [--locales=zh]");
}

const state = contentFlag
  ? await loadReviewAdminItem(root, contentFlag.slice("--content=".length))
  : await loadReviewAdminItemByFile(root, basename(inputArg));

if (!state) throw new Error("Review item not found");

const reviewItem = state.current;
const sourceRef = `content/review-packets/${reviewItem.file}`;
const requestAt = new Date().toISOString();
try {
  await setReviewWorkflowStatus(root, reviewItem, "release_requested", "已提交中文发布申请，正在执行独立预审与本地预发检查。", {
    release: {
      requestedAt: requestAt,
      requestedLocales,
      previewPath: reviewItem.readiness.previewPath,
      reportPath: relative(root, agentReportPath(root, reviewItem.item)),
    },
  });

  await runCommand(["npm", "run", "compliance:preaudit", "--", sourceRef, `--locales=${requestedLocales.join(",")}`], {
    cwd: root,
    timeoutMs: 900_000,
  });

  const [policy, legalRegistry, data, evidenceRecords, sourceRegistry, agentReport] = await Promise.all([
    loadCompliancePolicy(root),
    loadLegalRegistry(root),
    loadContentData(root),
    loadEvidenceRecords(root),
    loadSourceRegistry(root),
    loadAgentReport(root, reviewItem.item),
  ]);

  const report = summarizeEditorialReleaseReport(auditContentItem({
    item: reviewItem.item,
    data,
    policy,
    legalRegistry,
    evidenceRecords,
    sourceRegistry,
    agentReport,
    requestedLocales,
  }), requestedLocales);

  const releaseMeta = {
    requestedAt: requestAt,
    decisionAt: new Date().toISOString(),
    requestedLocales,
    decision: report.decision,
    riskClass: report.riskClass,
    findings: report.findings,
    ignoredFindings: report.ignoredFindings,
    reportPath: relative(root, agentReportPath(root, reviewItem.item)),
    previewPath: reviewItem.readiness.previewPath,
  };

  if (report.decision === "BLOCK") {
    const workflow = await setReviewWorkflowStatus(root, reviewItem, "release_blocked", "发布申请已被系统中断，需先补齐事实证据或检查本地命令。", {
      release: releaseMeta,
    });
    console.log(JSON.stringify({
      contentId: reviewItem.id,
      workflowStatus: workflow.status,
      decision: report.decision,
      riskClass: report.riskClass,
      blockingCodes: report.findings.map((finding) => finding.code),
    }, null, 0));
    process.exit(0);
  }

  if (report.decision === "REVIEW" || report.riskClass !== "A") {
    const workflow = await setReviewWorkflowStatus(root, reviewItem, "release_review_required", "发布申请需要人工复核，当前不进入自动本地预发。", {
      release: releaseMeta,
    });
    console.log(JSON.stringify({
      contentId: reviewItem.id,
      workflowStatus: workflow.status,
      decision: report.decision,
      riskClass: report.riskClass,
      reviewCodes: report.findings.map((finding) => finding.code),
    }, null, 0));
    process.exit(0);
  }

  try {
    await runCommand(["npm", "run", "publish:automatic", "--", sourceRef, `--locales=${requestedLocales.join(",")}`, "--skip-preaudit"], {
      cwd: root,
      timeoutMs: 900_000,
    });
    if (requestedLocales.length === 1 && requestedLocales[0] === "zh") {
      await runCommand(["npm", "run", "build:zh"], { cwd: root, timeoutMs: 900_000 });
    }
    const workflow = await setReviewWorkflowStatus(root, reviewItem, "release_ready", "中文本地预发已完成，可交付发物审核或等待手动生产发布。", {
      release: {
        ...releaseMeta,
        destination: "content/data/items",
      },
    });
    console.log(JSON.stringify({
      contentId: reviewItem.id,
      workflowStatus: workflow.status,
      decision: report.decision,
      riskClass: report.riskClass,
      previewPath: reviewItem.readiness.previewPath,
    }, null, 0));
  } catch (error) {
    const workflow = await setReviewWorkflowStatus(root, reviewItem, "release_blocked", "发布申请在本地预发阶段失败，需要人工检查命令或配置。", {
      release: {
        ...releaseMeta,
        commandError: String(error?.message || error).slice(-1000),
      },
    });
    console.log(JSON.stringify({
      contentId: reviewItem.id,
      workflowStatus: workflow.status,
      decision: "BLOCK",
      riskClass: report.riskClass,
      blockingCodes: [...new Set([...report.findings.map((finding) => finding.code), "publish_command_failed"])],
    }, null, 0));
  }
} catch (error) {
  const workflow = await setReviewWorkflowStatus(root, reviewItem, "release_blocked", "发布申请在独立预审阶段失败，需要人工检查 reviewer、授权或会话配置。", {
    release: {
      requestedAt: requestAt,
      decisionAt: new Date().toISOString(),
      requestedLocales,
      decision: "BLOCK",
      riskClass: reviewItem.item.riskClass || null,
      findings: [],
      reportPath: relative(root, agentReportPath(root, reviewItem.item)),
      previewPath: reviewItem.readiness.previewPath,
      commandError: String(error?.message || error).slice(-1000),
    },
  });
  console.log(JSON.stringify({
    contentId: reviewItem.id,
    workflowStatus: workflow.status,
    decision: "BLOCK",
    riskClass: reviewItem.item.riskClass || null,
    blockingCodes: ["release_request_failed"],
  }, null, 0));
} finally {
  await removeReviewJob(root, reviewItem.id, "release-request");
}
