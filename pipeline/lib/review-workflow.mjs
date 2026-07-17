import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_STATUS_BY_EDITION = {
  approved: "editorial_approved",
  needs_review: "review_pending",
  published: "release_ready",
  quarantined: "quarantined",
  withdrawn: "quarantined",
};

function itemIdOf(item) {
  return item?.id || item?.item?.id;
}

function editionStatusOf(item) {
  return item?.edition?.status || item?.editions?.zh?.status || item?.item?.editions?.zh?.status || "needs_review";
}

function defaultSummary(status) {
  return {
    editorial_approved: "中文主稿已批准，等待生成审稿材料或提交发布申请。",
    quarantined: "稿件已隔离，禁止进入发布申请。",
    release_ready: "中文本地预发已完成，可进入发物审核。",
    review_pending: "等待中文审稿。",
  }[status] || "等待工作流更新。";
}

export function reviewWorkflowPath(root, contentId) {
  return resolve(root, "private-review/workflows", `${contentId}.json`);
}

export function reviewHtmlOutputPath(root, contentId) {
  return resolve(root, "private-review/html", contentId, "index.html");
}

export function reviewHtmlRoute(contentId) {
  return `/private-review/${encodeURIComponent(contentId)}/`;
}

export function dynamicReviewRoute(contentId) {
  return `/review-preview/${encodeURIComponent(contentId)}`;
}

export function deriveReviewWorkflowStatus(item) {
  return DEFAULT_STATUS_BY_EDITION[editionStatusOf(item)] || "review_pending";
}

export function defaultReviewWorkflow(item) {
  const contentId = itemIdOf(item);
  const status = deriveReviewWorkflowStatus(item);
  const now = new Date().toISOString();
  return {
    contentId,
    status,
    summary: defaultSummary(status),
    updatedAt: now,
    preview: {
      dynamicRoute: dynamicReviewRoute(contentId),
      reviewHtmlRoute: null,
      reviewHtmlPath: null,
      reviewBuiltAt: null,
    },
    release: {
      requestedAt: null,
      decisionAt: null,
      requestedLocales: [],
      decision: null,
      riskClass: null,
      findings: [],
      reportPath: null,
      destination: null,
      previewPath: null,
      commandError: null,
    },
  };
}

export async function loadReviewWorkflow(root, item) {
  const path = reviewWorkflowPath(root, itemIdOf(item));
  try {
    const workflow = JSON.parse(await readFile(path, "utf8"));
    const fallback = defaultReviewWorkflow(item);
    return {
      ...fallback,
      ...workflow,
      preview: { ...fallback.preview, ...(workflow.preview || {}) },
      release: { ...fallback.release, ...(workflow.release || {}) },
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaultReviewWorkflow(item);
    throw error;
  }
}

export async function writeReviewWorkflow(root, item, workflow) {
  const contentId = itemIdOf(item);
  const path = reviewWorkflowPath(root, contentId);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const next = {
    ...defaultReviewWorkflow(item),
    ...workflow,
    contentId,
    updatedAt: workflow.updatedAt || new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export async function mutateReviewWorkflow(root, item, mutate) {
  const current = await loadReviewWorkflow(root, item);
  const update = mutate(structuredClone(current)) || current;
  return writeReviewWorkflow(root, item, {
    ...current,
    ...update,
    preview: { ...current.preview, ...(update.preview || {}) },
    release: { ...current.release, ...(update.release || {}) },
    updatedAt: new Date().toISOString(),
  });
}

export async function setReviewWorkflowStatus(root, item, status, summary, extra = {}) {
  return mutateReviewWorkflow(root, item, (current) => ({
    ...current,
    ...extra,
    status,
    summary: summary || defaultSummary(status),
    preview: { ...current.preview, ...(extra.preview || {}) },
    release: { ...current.release, ...(extra.release || {}) },
  }));
}
