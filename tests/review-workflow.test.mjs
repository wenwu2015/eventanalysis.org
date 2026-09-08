import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotRequestedLocales, mergeRewrittenPacket } from "../pipeline/lib/autopilot.mjs";
import { prepareChineseMaster } from "../pipeline/lib/compliance.mjs";
import { defaultReviewWorkflow, deriveReviewLifecycle, loadReviewWorkflow, mutateReviewWorkflow, reviewHtmlRoute, setReviewWorkflowStatus } from "../pipeline/lib/review-workflow.mjs";
import { renderReviewPreviewHtml } from "../pipeline/lib/review-preview.mjs";

test("review workflow derives default state from edition status", () => {
  const workflow = defaultReviewWorkflow({ id: "match-1", editions: { zh: { status: "approved" } } });
  assert.equal(workflow.status, "editorial_approved");
  assert.equal(workflow.preview.dynamicRoute, "/review-preview/match-1");
});

test("review workflow timestamps follow EA_NOW_ISO when pinned", () => {
  const previous = process.env.EA_NOW_ISO;
  process.env.EA_NOW_ISO = "2026-08-25T21:00:00+08:00";
  try {
    const workflow = defaultReviewWorkflow({ id: "match-now", editions: { zh: { status: "needs_review" } } });
    assert.equal(workflow.updatedAt, "2026-08-25T13:00:00.000Z");
    assert.equal(workflow.lifecycle.statusUpdatedAt, "2026-08-25T13:00:00.000Z");
  } finally {
    if (previous === undefined) delete process.env.EA_NOW_ISO;
    else process.env.EA_NOW_ISO = previous;
  }
});

test("autopilot locale selection falls back to the configured first-wave locales", () => {
  const locales = autopilotRequestedLocales(
    [{ code: "zh" }, { code: "zh-hant" }, { code: "en" }, { code: "ja" }, { code: "es" }, { code: "ar" }, { code: "ko" }],
    "all",
    ["zh", "zh-hant", "en", "ja", "es", "ar"],
  );
  assert.deepEqual(locales, ["zh", "zh-hant", "en", "ja", "es", "ar"]);
});

test("autopilot rewrite merge keeps the rewritten source edition hash", () => {
  const packet = {
    id: "moment-1",
    schemaVersion: 3,
    revision: 1,
    riskClass: "A",
    nexusJurisdictions: ["CN"],
    sourceLocale: "zh",
    sourceRevision: 1,
    sourceEditionHash: "a".repeat(64),
  };
  const rewritten = {
    ...packet,
    editions: {
      zh: {
        slug: "rewritten-moment",
        title: "改稿标题",
        deck: "改稿导语",
        competition: "测试赛事",
        venue: "",
        homeName: "主队",
        awayName: "客队",
        resultLabel: "1比0",
        sections: [{ id: "summary", title: "概览", paragraphs: [{ text: "改稿后的正文。", claimRefs: ["claim_1"] }] }],
        timeline: [{ minute: "FT", label: "终场", claimRefs: ["claim_1"] }],
      },
    },
    claims: [{ id: "claim_1", kind: "fact", factRefs: ["fact_1"], summary: "终场赛果已确认。" }],
  };
  prepareChineseMaster(rewritten);
  const merged = mergeRewrittenPacket(packet, rewritten);
  assert.equal(merged.sourceEditionHash, rewritten.sourceEditionHash);
  assert.notEqual(merged.sourceEditionHash, packet.sourceEditionHash);
});

test("review workflow persists preview metadata and status", async () => {
  const root = await mkdtemp(join(tmpdir(), "ea-review-workflow-"));
  const item = { id: "match-2", editions: { zh: { status: "needs_review" } } };
  await setReviewWorkflowStatus(root, item, "release_blocked", "blocked", {
    preview: { reviewHtmlRoute: reviewHtmlRoute(item.id) },
    release: { requestedLocales: ["zh"], findings: [{ code: "nexus_legal_pack_invalid" }] },
  });
  const workflow = await mutateReviewWorkflow(root, item, (current) => ({
    ...current,
    preview: { ...current.preview, reviewHtmlPath: "private-review/html/match-2/index.html" },
  }));
  assert.equal(workflow.status, "release_blocked");
  assert.equal(workflow.preview.reviewHtmlRoute, "/private-review/match-2/");
  const stored = JSON.parse(await readFile(join(root, "private-review/workflows/match-2.json"), "utf8"));
  assert.equal(stored.preview.reviewHtmlPath, "private-review/html/match-2/index.html");
});

test("review workflow lifecycle derives edited pending publish from an existing staged item", () => {
  const lifecycle = deriveReviewLifecycle({
    id: "match-4",
    editions: { zh: { title: "标题", competition: "赛事", homeName: "主队", awayName: "客队", status: "needs_review" } },
  }, {
    current: null,
    sourceItem: {
      revision: 3,
      publishedAt: "2026-07-18T01:00:00Z",
      editions: { zh: { status: "published" } },
    },
    sourceItemPath: "content/data/items/match-4.json",
    now: "2026-07-18T02:00:00Z",
  });
  assert.equal(lifecycle.status, "edited_pending_publish");
  assert.equal(lifecycle.sourceRevision, 3);
  assert.equal(lifecycle.sourceItemPath, "content/data/items/match-4.json");
  assert.equal(lifecycle.pendingSince, "2026-07-18T02:00:00Z");
  assert.equal(lifecycle.publishedAt, "2026-07-18T01:00:00Z");
});

test("review workflow lifecycle derives deleted terminal state", () => {
  const lifecycle = deriveReviewLifecycle({
    id: "match-5",
    editions: { zh: { title: "标题", competition: "赛事", homeName: "主队", awayName: "客队", status: "quarantined" } },
  }, {
    current: null,
    forceStatus: "deleted",
    now: "2026-07-18T03:00:00Z",
  });
  assert.equal(lifecycle.status, "deleted");
  assert.equal(lifecycle.deletedAt, "2026-07-18T03:00:00Z");
});

test("review preview html contains workflow and findings summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ea-review-preview-"));
  const workflow = await loadReviewWorkflow(root, { id: "match-3", editions: { zh: { status: "needs_review" } } });
  const html = renderReviewPreviewHtml({
    id: "match-3",
    item: {
      id: "match-3",
      claims: [{ id: "claim_1", kind: "result", factRefs: ["fact_1"], summary: "阿根廷在补时阶段完成逆转。" }],
    },
    edition: {
      title: "阿根廷2比1逆转英格兰",
      deck: "测试 deck",
      competition: "国际足球邀请赛",
      homeName: "英格兰",
      awayName: "阿根廷",
      status: "needs_review",
      complianceStatus: "unreviewed",
      sections: [{ title: "比赛概览", paragraphs: [{ text: "阿根廷在末段连入两球。", claimRefs: ["claim_1"] }] }],
      timeline: [{ minute: "90+1", label: "扳平比分", claimRefs: ["claim_1"] }],
    },
    event: null,
    evidence: null,
    metrics: { coreSourceConfirmations: 2, h2hMatches: 5, missing: ["lineups"], continuity: [] },
    workflow: {
      ...workflow,
      status: "release_blocked",
      summary: "后台流程中断。",
      release: {
        ...workflow.release,
        decision: "BLOCK",
        findings: [{ code: "nexus_legal_pack_invalid", jurisdiction: "GB", reasons: ["pack_not_active"] }],
      },
    },
  });
  assert.match(html, /旧流程中断/);
  assert.match(html, /发布申请已经真实执行过，但没有公开发布成功/);
  assert.match(html, /nexus_legal_pack_invalid/);
  assert.match(html, /阿根廷2比1逆转英格兰/);
});
