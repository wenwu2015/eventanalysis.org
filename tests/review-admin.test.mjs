import test from "node:test";
import assert from "node:assert/strict";
import {
  autoActivateLegalPack,
  autoActivateRegistryLegalPack,
  applyEditionStatus,
  blockedAutomationLimits,
  blockedItemResolutionStage,
  buildItemWorkflowGuidance,
  collectOperatorJurisdictionWeakSignals,
  collectLegalDraftCandidateJurisdictions,
  buildLegalSupportTemplate,
  detectOperatorJurisdictionFromSupportRecords,
  detectOperatorJurisdictionFromTexts,
  ensureLegalPackDrafts,
  findRelatedEvidence,
  importLegalSupportRecord,
  normalizeLegalSupportRecord,
  nextBlockedLegalPack,
  parseOfficialSourcesInput,
  previewRouteForItem,
  retargetLegalReturnTo,
  serializeOfficialSourcesInput,
  upsertLegalPack,
} from "../pipeline/lib/review-admin.mjs";

const routes = {
  locales: {
    zh: {
      "match-analysis": "match-analysis",
    },
  },
};

test("preview route uses localized route segments", () => {
  const item = {
    type: "match_analysis",
    sport: "football",
    editions: {
      zh: { slug: "england-argentina-1-2-late-comeback-analysis" },
    },
  };
  assert.equal(previewRouteForItem(item, routes), "/zh/football/match-analysis/england-argentina-1-2-late-comeback-analysis/");
});

test("related evidence prefers the packet with matching teams and kickoff", () => {
  const item = {
    eventRefs: ["event_1"],
    editions: {
      zh: {
        homeName: "英格兰",
        awayName: "阿根廷",
      },
    },
  };
  const events = new Map([["event_1", { id: "event_1", startedAt: "2026-07-15T19:00:00.000Z", homeTeamId: "team_england_men", awayTeamId: "team_argentina_men", homeScore: 1, awayScore: 2 }]]);
  const entities = new Map([
    ["team_england_men", { aliases: ["England"], names: { zh: "英格兰", en: "England" } }],
    ["team_argentina_men", { aliases: ["Argentina"], names: { zh: "阿根廷", en: "Argentina" } }],
  ]);
  const packets = [
    {
      name: "other.json",
      value: {
        match: {
          id: "9",
          startedAt: "2026-07-15T18:00:00.000Z",
          homeTeam: "France",
          awayTeam: "Spain",
        },
      },
    },
    {
      name: "match-12812996.json",
      value: {
        match: {
          id: "12812996",
          startedAt: "2026-07-15T19:00:00.000Z",
          homeTeam: "英格兰",
          awayTeam: "阿根廷",
        },
      },
    },
  ];
  assert.equal(findRelatedEvidence(item, packets, events, entities)?.name, "match-12812996.json");
});

test("sending an item back to review clears preview compliance fields", () => {
  const item = {
    reviewedAt: "2026-07-16T00:00:00.000Z",
    editions: {
      zh: {
        status: "approved",
        complianceStatus: "passed",
        complianceValidUntil: "2026-08-16T00:00:00.000Z",
        allowedJurisdictions: ["CN"],
      },
    },
  };
  const next = applyEditionStatus(item, "zh", "needs_review");
  assert.equal(next.editions.zh.status, "needs_review");
  assert.equal(next.editions.zh.complianceStatus, "unreviewed");
  assert.equal("allowedJurisdictions" in next.editions.zh, false);
  assert.equal("complianceValidUntil" in next.editions.zh, false);
});

test("review pending guidance routes into autopilot", () => {
  const item = {
    id: "match-review-pending",
    file: "match-review-pending.json",
    item: { nexusJurisdictions: [] },
    entityJurisdictions: [],
    workflow: { status: "review_pending", summary: "pending" },
    readiness: { reviewHtmlBuilt: false, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["AR"], packs: [] });
  assert.equal(guidance.stateLabel, "待自动审稿");
  assert.equal(guidance.primaryAction?.action, "rerun_autopilot");
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.match(guidance.nextStep, /自动判断、改稿并推进正式发布/);
});

test("editorial approved guidance continues with autopilot", () => {
  const item = {
    id: "match-editorial-approved",
    file: "match-editorial-approved.json",
    item: { nexusJurisdictions: [] },
    entityJurisdictions: [],
    workflow: { status: "editorial_approved", summary: "approved" },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["AR"], packs: [] });
  assert.equal(guidance.stateLabel, "待自动流转");
  assert.equal(guidance.primaryAction?.action, "rerun_autopilot");
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.match(guidance.nextStep, /从当前稿件继续推进/);
});

test("release blocked guidance routes fact-only blockers back to the item detail", () => {
  const item = {
    id: "match-1",
    file: "match-1.json",
    item: {
      nexusJurisdictions: ["GB"],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "GB", reasons: ["pack_not_active"] },
          { jurisdiction: "ZZ", reasons: ["invalid_jurisdiction"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: ["head_to_head_history"] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["ZZ"], packs: [] });
  assert.equal(guidance.stateLabel, "旧流程中断");
  assert.equal(guidance.primaryAction?.type, "link");
  assert.equal(guidance.primaryAction?.label, "去补事实包");
  assert.deepEqual(guidance.secondaryActions, []);
  assert.match(guidance.nextStep, /补齐事实包/);
  assert.equal(guidance.resolveHref, "/items/match-1");
  assert.ok(guidance.blockers.length >= 1);
  assert.ok(guidance.blockers.some((entry) => entry.includes("事实包缺口")));
});

test("release blocked guidance sends fact-only blockers back to the item detail", () => {
  const item = {
    id: "match-3",
    item: {
      nexusJurisdictions: [],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: ["head_to_head_history"] },
  };
  const packValidation = new Map([["GB", { ok: true, findings: [] }]]);
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["GB"], packs: [] }, { packValidation });
  assert.equal(guidance.stateLabel, "旧流程中断");
  assert.equal(guidance.primaryAction?.label, "去补事实包");
  assert.equal(guidance.resolveHref, "/items/match-3");
});

test("release blocked guidance can be retried with one click when no fact gap remains", () => {
  const item = {
    id: "match-operator",
    file: "match-operator.json",
    item: {
      nexusJurisdictions: ["AR"],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "AR", reasons: ["pack_not_active"] },
          { jurisdiction: "ZZ", reasons: ["invalid_jurisdiction"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["ZZ"], packs: [] }, {
    packValidation: new Map(),
    operatorJurisdictionReport: {
      checkedAt: "2026-07-16T21:18:24.204Z",
      detectedJurisdiction: null,
      ambiguous: false,
    },
  });
  assert.equal(guidance.primaryAction?.type, "form");
  assert.equal(guidance.primaryAction?.action, "rerun_autopilot");
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
});

test("published guidance exposes a terminal published state", () => {
  const item = {
    id: "match-published",
    item: { nexusJurisdictions: [] },
    entityJurisdictions: [],
    workflow: {
      status: "published",
      summary: "published",
      lifecycle: { status: "published" },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: true },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["AR"], packs: [] });
  assert.equal(guidance.stateLabel, "已发布");
  assert.equal(guidance.primaryAction, null);
  assert.match(guidance.nextStep, /重新生成|重新/);
});

test("deleted guidance exposes a terminal deleted state", () => {
  const item = {
    id: "match-deleted",
    item: { nexusJurisdictions: [] },
    entityJurisdictions: [],
    workflow: {
      status: "deleted",
      summary: "deleted",
      lifecycle: { status: "deleted" },
    },
    readiness: { reviewHtmlBuilt: false, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["AR"], packs: [] });
  assert.equal(guidance.stateLabel, "已删除");
  assert.equal(guidance.primaryAction, null);
  assert.match(guidance.why, /已删除/);
});

test("release blocked guidance stays one-click retry even if historical legal blockers were resolved", () => {
  const item = {
    id: "match-2",
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "GB", reasons: ["pack_not_active"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const packValidation = new Map([["GB", { ok: true, findings: [] }]]);
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["GB"], packs: [] }, { packValidation });
  assert.equal(guidance.stateLabel, "旧流程中断");
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.ok(guidance.blockers.some((entry) => entry.includes("后台发布检查没有通过") || entry.includes("公开站点仍未发布")));
});

test("blocked item resolution stage prioritizes operator confirmation before pack editing", () => {
  assert.equal(blockedItemResolutionStage({
    operatorConfirmed: false,
    currentCanRetry: false,
    currentNeedsDrafts: false,
    currentPrimaryPackCode: "AR",
  }), "operator");
  assert.equal(blockedItemResolutionStage({
    operatorConfirmed: true,
    currentCanRetry: false,
    currentNeedsDrafts: false,
    currentNeedsSupport: true,
    currentPrimaryPackCode: "AR",
  }), "support");
  assert.equal(blockedItemResolutionStage({
    operatorConfirmed: true,
    currentCanRetry: false,
    currentNeedsDrafts: false,
    currentNeedsSupport: false,
    currentPrimaryPackCode: "AR",
  }), "pack");
  assert.equal(blockedItemResolutionStage({
    operatorConfirmed: true,
    currentCanRetry: true,
    currentNeedsDrafts: false,
    currentPrimaryPackCode: "AR",
  }), "retry");
});

test("blocked automation limits explain why release cannot auto-proceed", () => {
  const reasons = blockedAutomationLimits({
    operatorConfirmed: false,
    operatorReport: { mode: "user_supplied_urls" },
    currentInvalidPackCodes: ["AR", "GB"],
    currentCanRetry: false,
  });
  assert.ok(reasons.some((entry) => entry.includes("外部公开证据 URL 扫描没有找到唯一明确辖区")));
  assert.ok(reasons.some((entry) => entry.includes("AR、GB 的 legal pack")));
  assert.ok(reasons.some((entry) => entry.includes("不会显示重新提交中文发布申请")));
});

test("retarget legal returnTo keeps current legal content and switches pack focus", () => {
  assert.equal(
    retargetLegalReturnTo("/legal?content=match-1&pack=AR", "US"),
    "/legal?content=match-1&pack=US",
  );
  assert.equal(
    retargetLegalReturnTo("/items/match-1", "US"),
    "/items/match-1",
  );
});

test("next blocked legal pack prefers the first unresolved code and advances past the current pack", () => {
  assert.equal(nextBlockedLegalPack(["AR", "ES", "FR"]), "AR");
  assert.equal(nextBlockedLegalPack(["AR", "ES", "FR"], "AR"), "ES");
  assert.equal(nextBlockedLegalPack(["AR", "ES", "FR"], "ES"), "FR");
  assert.equal(nextBlockedLegalPack(["ZZ", "AR"], "AR"), "");
});

test("release blocked guidance still requires the current operator jurisdiction pack after operator changes", () => {
  const item = {
    id: "match-4",
    file: "match-4.json",
    item: {
      nexusJurisdictions: [],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "GB", reasons: ["pack_not_active"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const packValidation = new Map([["GB", { ok: true, findings: [] }]]);
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["US"], packs: [] }, { packValidation });
  assert.equal(guidance.stateLabel, "旧流程中断");
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.deepEqual(guidance.secondaryActions, []);
  assert.ok(guidance.blockers.some((entry) => entry.includes("后台发布检查没有通过") || entry.includes("公开站点仍未发布")));
});

test("release blocked guidance follows the current retry scope instead of stale report jurisdictions", () => {
  const item = {
    id: "match-current-scope",
    file: "match-current-scope.json",
    item: {
      nexusJurisdictions: ["EN"],
    },
    entityJurisdictions: ["EN"],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "GB", reasons: ["pack_not_active"] },
          { jurisdiction: "ZZ", reasons: ["invalid_jurisdiction"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["AR"], packs: [] }, { packValidation: new Map() });
  assert.match(guidance.nextStep, /重跑自动审稿/);
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.ok(guidance.blockers.some((entry) => entry.includes("后台发布检查没有通过") || entry.includes("公开站点仍未发布")));
});

test("release blocked guidance prioritizes operator pack before other invalid jurisdictions", () => {
  const item = {
    id: "match-5",
    file: "match-5.json",
    item: {
      nexusJurisdictions: ["AR"],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "AR", reasons: ["pack_not_active"] },
          { jurisdiction: "GB", reasons: ["pack_not_active"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, { operatorJurisdictions: ["US"], packs: [] }, { packValidation: new Map() });
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.ok(guidance.blockers.some((entry) => entry.includes("后台发布检查没有通过") || entry.includes("公开站点仍未发布")));
});

test("release blocked guidance no longer sends editor into legal-only blocker handling", () => {
  const item = {
    id: "match-6",
    file: "match-6.json",
    item: {
      nexusJurisdictions: ["AR"],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "AR", reasons: ["pack_not_active", "invalid_reviewed_at"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, {
    operatorJurisdictions: ["AR"],
    packs: [{
      jurisdiction: "AR",
      status: "draft",
      reviewedAt: null,
      expiresAt: null,
      counsel: { name: "", barJurisdiction: "", signatureHash: "" },
      officialSources: [],
      notes: [],
    }],
  }, {
    packValidation: new Map([["AR", { ok: false, findings: ["pack_not_active", "invalid_reviewed_at"] }]]),
    supportByJurisdiction: new Map([["AR", { jurisdiction: "AR", hasMaterial: false }]]),
  });
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.equal(guidance.resolveHref, "/items/match-6");
  assert.match(guidance.nextStep, /重跑自动审稿/);
});

test("release blocked guidance still stays on one-click retry with multiple historical blocked jurisdictions", () => {
  const item = {
    id: "match-7",
    file: "match-7.json",
    item: {
      nexusJurisdictions: ["ES", "FR"],
    },
    entityJurisdictions: [],
    workflow: {
      status: "release_blocked",
      summary: "blocked",
      release: {
        findings: [
          { jurisdiction: "AR", reasons: ["pack_not_active"] },
          { jurisdiction: "ES", reasons: ["pack_not_active"] },
          { jurisdiction: "FR", reasons: ["pack_not_active"] },
        ],
      },
    },
    readiness: { reviewHtmlBuilt: true, previewBuilt: false },
    metrics: { missing: [] },
  };
  const guidance = buildItemWorkflowGuidance(item, {
    operatorJurisdictions: ["AR"],
    packs: [],
  }, {
    packValidation: new Map(),
    supportByJurisdiction: new Map([["AR", { jurisdiction: "AR", hasMaterial: false }]]),
  });
  assert.match(guidance.nextStep, /重跑自动审稿/);
  assert.equal(guidance.primaryAction?.label, "重新触发自动审稿");
  assert.ok(guidance.blockers.some((entry) => entry.includes("后台发布检查没有通过") || entry.includes("公开站点仍未发布")));
});

test("legal draft scaffolds only create missing non-ZZ jurisdictions", () => {
  const registry = {
    operatorJurisdictions: ["ZZ"],
    packs: [{ jurisdiction: "GB", status: "draft" }],
  };
  const result = ensureLegalPackDrafts(registry, ["GB", "AR", "ZZ"]);
  assert.deepEqual(result.created, ["AR"]);
  assert.equal(result.registry.packs.some((pack) => pack.jurisdiction === "AR" && pack.status === "draft"), true);
  assert.equal(result.registry.packs.some((pack) => pack.jurisdiction === "ZZ"), false);
});

test("legal draft candidates merge coverage queue, operator and blocked item jurisdictions", () => {
  const registry = {
    operatorJurisdictions: ["ZZ"],
    coverageQueue: {
      targetMarkets: ["GB", "FR"],
      currentContentNexus: ["AR"],
      operator: ["ZZ"],
    },
  };
  const items = [{
    workflow: {
      release: {
        findings: [{ jurisdiction: "ES" }, { jurisdiction: "ZZ" }],
      },
    },
  }];
  assert.deepEqual(collectLegalDraftCandidateJurisdictions(registry, items), ["AR", "ES", "FR", "GB"]);
});

test("official source lines round-trip through the legal pack editor format", () => {
  const text = "https://example.gov/doc | 2026-07-16T00:00:00Z | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sources = parseOfficialSourcesInput(text);
  assert.deepEqual(sources, [{
    url: "https://example.gov/doc",
    checkedAt: "2026-07-16T00:00:00Z",
    contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }]);
  assert.equal(serializeOfficialSourcesInput(sources), text);
});

test("upsert legal pack replaces editable fields without inventing missing data", () => {
  const registry = {
    packs: [{
      jurisdiction: "GB",
      status: "draft",
      reviewedAt: null,
      expiresAt: null,
      counsel: { name: "", barJurisdiction: "", signatureHash: "" },
      officialSources: [],
      notes: ["old note"],
    }],
  };
  const next = upsertLegalPack(registry, {
    jurisdiction: "GB",
    status: "active",
    reviewedAt: "2026-07-16T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counselName: "Counsel",
    counselBarJurisdiction: "GB",
    counselSignatureHash: "b".repeat(64),
    officialSourcesText: "https://example.gov/doc | 2026-07-16T00:00:00Z | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    notesText: "",
  });
  const pack = next.packs.find((entry) => entry.jurisdiction === "GB");
  assert.equal(pack.status, "active");
  assert.equal(pack.reviewedAt, "2026-07-16T00:00:00Z");
  assert.equal(pack.counsel.signatureHash, "b".repeat(64));
  assert.equal(pack.officialSources.length, 1);
  assert.deepEqual(pack.notes, ["old note"]);
});

test("auto activate legal pack promotes a valid draft once real fields are complete", () => {
  const policy = { legalPackMaxAgeDays: 90 };
  const result = autoActivateLegalPack({
    jurisdiction: "AR",
    status: "draft",
    reviewedAt: "2026-07-16T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counsel: { name: "Counsel", barJurisdiction: "AR", signatureHash: "b".repeat(64) },
    officialSources: [{ url: "https://example.gov/doc", checkedAt: "2026-07-16T00:00:00Z", contentHash: "a".repeat(64) }],
    notes: [],
  }, policy, new Date("2026-07-16T12:00:00Z"));
  assert.equal(result.activated, true);
  assert.equal(result.pack.status, "active");
});

test("auto activate legal pack keeps draft when required fields are still missing", () => {
  const policy = { legalPackMaxAgeDays: 90 };
  const result = autoActivateRegistryLegalPack({
    packs: [{
      jurisdiction: "AR",
      status: "draft",
      reviewedAt: "2026-07-16T00:00:00Z",
      expiresAt: "2026-08-01T00:00:00Z",
      counsel: { name: "", barJurisdiction: "", signatureHash: "" },
      officialSources: [],
      notes: [],
    }],
  }, "AR", policy, new Date("2026-07-16T12:00:00Z"));
  assert.equal(result.activated, false);
  assert.equal(result.registry.packs[0].status, "draft");
});

test("normalize legal support record accepts structured official sources and operator flag", () => {
  const normalized = normalizeLegalSupportRecord({
    status: "active",
    reviewedAt: "2026-07-16T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counsel: { name: "Counsel", barJurisdiction: "gb", signatureHash: "b".repeat(64) },
    officialSources: [{ url: "https://example.gov/doc", checkedAt: "2026-07-16T00:00:00Z", contentHash: "a".repeat(64) }],
    notes: ["real legal memo"],
    operatorJurisdiction: true,
  }, "gb");
  assert.equal(normalized.jurisdiction, "GB");
  assert.equal(normalized.status, "active");
  assert.equal(normalized.counselBarJurisdiction, "GB");
  assert.equal(normalized.operatorJurisdiction, true);
  assert.equal(normalized.officialSourcesText, `https://example.gov/doc | 2026-07-16T00:00:00Z | ${"a".repeat(64)}`);
});

test("import legal support record updates registry without fabricating fields", () => {
  const result = importLegalSupportRecord({ packs: [] }, {
    jurisdiction: "GB",
    status: "active",
    reviewedAt: "2026-07-16T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counselName: "Counsel",
    counselBarJurisdiction: "GB",
    counselSignatureHash: "b".repeat(64),
    officialSourcesText: `https://example.gov/doc | 2026-07-16T00:00:00Z | ${"a".repeat(64)}`,
    notesText: "memo",
  });
  const pack = result.registry.packs.find((entry) => entry.jurisdiction === "GB");
  assert.equal(result.normalized.jurisdiction, "GB");
  assert.equal(pack.status, "active");
  assert.equal(pack.reviewedAt, "2026-07-16T00:00:00Z");
  assert.equal(pack.counsel.signatureHash, "b".repeat(64));
  assert.deepEqual(pack.notes, ["memo"]);
});

test("operator jurisdiction can be detected from one flagged support record only", () => {
  const unique = detectOperatorJurisdictionFromSupportRecords([
    { jurisdiction: "GB", operatorJurisdiction: true },
    { jurisdiction: "FR", operatorJurisdiction: false },
  ]);
  assert.equal(unique.detectedJurisdiction, "GB");
  assert.equal(unique.ambiguous, false);
  const ambiguous = detectOperatorJurisdictionFromSupportRecords([
    { jurisdiction: "GB", operatorJurisdiction: true },
    { jurisdiction: "US", operatorJurisdiction: true },
  ]);
  assert.equal(ambiguous.detectedJurisdiction, null);
  assert.equal(ambiguous.ambiguous, true);
});

test("legal support template keeps real existing values but does not invent missing ones", () => {
  const template = buildLegalSupportTemplate({
    jurisdiction: "GB",
    status: "draft",
    reviewedAt: "",
    expiresAt: null,
    counsel: { name: "", barJurisdiction: "", signatureHash: "" },
    officialSources: [{ url: "https://example.gov/doc", checkedAt: "", contentHash: "" }],
    notes: [],
  }, "GB", { operatorJurisdiction: true });
  assert.equal(template.jurisdiction, "GB");
  assert.equal(template.status, "draft");
  assert.equal(template.operatorJurisdiction, true);
  assert.equal(template.reviewedAt, "");
  assert.equal(template.expiresAt, "");
  assert.equal(template.counsel.signatureHash, "");
  assert.deepEqual(template.officialSources, [{ url: "https://example.gov/doc", checkedAt: "", contentHash: "" }]);
  assert.ok(template.notes.length >= 1);
});

test("operator jurisdiction autodetect accepts one explicit governing-law match", () => {
  const detection = detectOperatorJurisdictionFromTexts([
    {
      url: "https://eventanalysis.org/legal",
      text: "<p>This publication is governed by the laws of the United Kingdom.</p>",
    },
  ], ["GB", "US"]);
  assert.equal(detection.detectedJurisdiction, "GB");
  assert.equal(detection.ambiguous, false);
  assert.deepEqual(detection.jurisdictions, ["GB"]);
  assert.equal(detection.contextualSourceCount, 1);
  assert.equal(detection.contextualLineCount, 1);
});

test("operator jurisdiction autodetect accepts organization JSON-LD addressCountry", () => {
  const detection = detectOperatorJurisdictionFromTexts([
    {
      url: "https://registry.example/company",
      text: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example Media","address":{"@type":"PostalAddress","addressCountry":"United Kingdom"}}</script>`,
    },
  ], ["GB", "US"]);
  assert.equal(detection.detectedJurisdiction, "GB");
  assert.equal(detection.ambiguous, false);
  assert.ok(detection.findings.some((entry) => entry.evidence.includes("JSON-LD address.addressCountry=United Kingdom")));
});

test("operator jurisdiction autodetect refuses ambiguous matches", () => {
  const detection = detectOperatorJurisdictionFromTexts([
    {
      url: "https://eventanalysis.org/legal",
      text: "<p>This publication is governed by the laws of the United Kingdom.</p><p>Company registered in the United States.</p>",
    },
  ], ["GB", "US"]);
  assert.equal(detection.detectedJurisdiction, null);
  assert.equal(detection.ambiguous, true);
  assert.deepEqual(detection.jurisdictions, ["GB", "US"]);
});

test("operator jurisdiction weak signals are reported separately from usable jurisdiction evidence", () => {
  const signals = collectOperatorJurisdictionWeakSignals([
    {
      url: "https://eventanalysis.org/en/football/legal/",
      text: "<p>Email legal and corrections · legal@eventanalysis.org</p><p>Event Analysis is an independent static publication for post-match historical analysis.</p>",
    },
  ]);
  assert.ok(signals.length >= 1);
  assert.ok(signals.some((entry) => /legal@eventanalysis\.org/i.test(entry.evidence)));
});
