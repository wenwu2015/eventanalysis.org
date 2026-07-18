import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_STATUS_BY_EDITION = {
  approved: "editorial_approved",
  needs_review: "review_pending",
  published: "published",
  quarantined: "quarantined",
  withdrawn: "quarantined",
};

const REVIEW_LIFECYCLE_STATUSES = new Set([
  "draft",
  "edited_pending_publish",
  "published",
  "deleted",
]);

function itemIdOf(item) {
  return item?.id || item?.item?.id;
}

function editionStatusOf(item) {
  return item?.edition?.status || item?.editions?.zh?.status || item?.item?.editions?.zh?.status || "needs_review";
}

function defaultSummary(status) {
  return {
    editorial_approved: "中文主稿已批准，等待生成审稿材料或提交发布申请。",
    published: "稿件已正式发布，可继续跟踪后续改版。",
    deleted: "稿件已删除，保留状态记录供后续会话继续跟踪。",
    quarantined: "稿件已隔离，禁止进入发布申请。",
    release_ready: "中文本地预发已完成，可进入发物审核。",
    review_pending: "等待中文审稿。",
  }[status] || "等待工作流更新。";
}

function zhEditionOf(item) {
  return item?.edition || item?.editions?.zh || item?.item?.editions?.zh || {};
}

function lifecycleMetaOf(item) {
  const zh = zhEditionOf(item);
  return {
    title: String(zh.title || "").trim(),
    competition: String(zh.competition || "").trim(),
    homeName: String(zh.homeName || "").trim(),
    awayName: String(zh.awayName || "").trim(),
  };
}

function defaultLifecycle(item) {
  const now = new Date().toISOString();
  return {
    status: "draft",
    statusUpdatedAt: now,
    sourceItemPath: null,
    sourceRevision: null,
    publishedAt: null,
    pendingSince: null,
    deletedAt: null,
    ...lifecycleMetaOf(item),
  };
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

export function deriveReviewLifecycle(item, {
  current = null,
  sourceItem = null,
  sourceItemPath = null,
  forceStatus = "",
  now = new Date().toISOString(),
} = {}) {
  const next = {
    ...defaultLifecycle(item),
    ...(current || {}),
    ...lifecycleMetaOf(item),
  };
  let status = forceStatus || next.status || "draft";
  const sourceEdition = sourceItem?.editions?.zh || null;
  const sourceStatus = sourceEdition?.status || "";

  if (forceStatus) {
    status = forceStatus;
  } else if (sourceStatus === "published" || sourceStatus === "approved") {
    status = "edited_pending_publish";
  } else if (!REVIEW_LIFECYCLE_STATUSES.has(status) || status === "published" || status === "deleted") {
    status = "draft";
  }

  const statusChanged = status !== next.status;
  next.status = status;
  next.statusUpdatedAt = statusChanged ? now : (next.statusUpdatedAt || now);
  next.sourceItemPath = sourceItemPath || next.sourceItemPath || null;
  next.sourceRevision = sourceItem?.revision ?? next.sourceRevision ?? null;
  next.publishedAt = forceStatus === "published"
    ? (sourceItem?.publishedAt || sourceItem?.reviewedAt || next.publishedAt || now)
    : (sourceStatus === "published" ? (sourceItem?.publishedAt || next.publishedAt || null) : (status === "deleted" ? next.publishedAt || null : next.publishedAt || null));
  next.pendingSince = status === "edited_pending_publish"
    ? (next.pendingSince || now)
    : null;
  next.deletedAt = status === "deleted"
    ? (next.deletedAt || now)
    : null;
  return next;
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
    lifecycle: defaultLifecycle(item),
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
      lifecycle: { ...fallback.lifecycle, ...(workflow.lifecycle || {}) },
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
    lifecycle: { ...defaultLifecycle(item), ...(workflow.lifecycle || {}) },
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
    lifecycle: { ...current.lifecycle, ...(update.lifecycle || {}) },
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
    lifecycle: { ...current.lifecycle, ...(extra.lifecycle || {}) },
    release: { ...current.release, ...(extra.release || {}) },
  }));
}
