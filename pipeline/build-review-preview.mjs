#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { loadReviewAdminItem, loadReviewAdminItemByFile } from "./lib/review-admin.mjs";
import { renderReviewPreviewHtml } from "./lib/review-preview.mjs";
import { dynamicReviewRoute, mutateReviewWorkflow, reviewHtmlOutputPath, reviewHtmlRoute } from "./lib/review-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const inputArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const contentFlag = process.argv.find((value) => value.startsWith("--content="));

if (!inputArg && !contentFlag) {
  throw new Error("Usage: npm run review:html -- <content/review-packets/file.json> OR --content=<id>");
}

const state = contentFlag
  ? await loadReviewAdminItem(root, contentFlag.slice("--content=".length))
  : await loadReviewAdminItemByFile(root, basename(inputArg));

if (!state) throw new Error("Review item not found");

const html = renderReviewPreviewHtml(state.current);
const outputPath = reviewHtmlOutputPath(root, state.current.id);
await mkdir(resolve(outputPath, ".."), { recursive: true, mode: 0o700 });
await writeFile(outputPath, html, { mode: 0o600 });

const workflow = await mutateReviewWorkflow(root, state.current, (current) => ({
  ...current,
  preview: {
    ...current.preview,
    dynamicRoute: dynamicReviewRoute(state.current.id),
    reviewHtmlRoute: reviewHtmlRoute(state.current.id),
    reviewHtmlPath: relative(root, outputPath),
    reviewBuiltAt: new Date().toISOString(),
  },
}));

console.log(JSON.stringify({
  contentId: state.current.id,
  workflowStatus: workflow.status,
  reviewHtmlPath: workflow.preview.reviewHtmlPath,
  reviewHtmlRoute: workflow.preview.reviewHtmlRoute,
  dynamicRoute: workflow.preview.dynamicRoute,
}, null, 0));
