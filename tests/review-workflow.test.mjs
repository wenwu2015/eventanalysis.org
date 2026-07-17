import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultReviewWorkflow, loadReviewWorkflow, mutateReviewWorkflow, reviewHtmlRoute, setReviewWorkflowStatus } from "../pipeline/lib/review-workflow.mjs";
import { renderReviewPreviewHtml } from "../pipeline/lib/review-preview.mjs";

test("review workflow derives default state from edition status", () => {
  const workflow = defaultReviewWorkflow({ id: "match-1", editions: { zh: { status: "approved" } } });
  assert.equal(workflow.status, "editorial_approved");
  assert.equal(workflow.preview.dynamicRoute, "/review-preview/match-1");
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
      summary: "需要 legal pack。",
      release: {
        ...workflow.release,
        decision: "BLOCK",
        findings: [{ code: "nexus_legal_pack_invalid", jurisdiction: "GB", reasons: ["pack_not_active"] }],
      },
    },
  });
  assert.match(html, /申请被阻断（未发布）/);
  assert.match(html, /发布申请已经真实执行过，但没有公开发布成功/);
  assert.match(html, /nexus_legal_pack_invalid/);
  assert.match(html, /阿根廷2比1逆转英格兰/);
});
