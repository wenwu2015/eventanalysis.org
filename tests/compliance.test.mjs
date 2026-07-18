import test from "node:test";
import assert from "node:assert/strict";
import {
  auditContentItem,
  isEditionLocallyPreviewable,
  isEditionPublishable,
  legalPackHash,
  policyHash,
  prepareChineseMaster,
  prepareDerivedEdition,
  riskClassForItem,
  scanProhibitedLanguage,
  sourceEditionHash,
  validateAgentPreAudit,
  validateLegalPack,
  validateTranslation,
} from "../pipeline/lib/compliance.mjs";
import policy from "../pipeline/config/compliance-policy.json" with { type: "json" };

function edition(locale, text = "球队在第 72 分钟进球，最终以 2–1 获胜。") {
  return {
    locale,
    slug: locale === "zh" ? "比赛分析" : "match-analysis",
    title: locale === "zh" ? "比赛分析 2–1" : "Match analysis 2–1",
    deck: text,
    sections: [{ id: "result", title: "Result", paragraphs: [{ text, claimRefs: ["claim-1"] }] }],
    status: "needs_review",
  };
}

function item() {
  return {
    id: "content-test",
    revision: 1,
    type: "match_analysis",
    sport: "football",
    claims: [{ id: "claim-1", kind: "fact", factRefs: ["fact-1"] }],
    editions: { zh: edition("zh") },
  };
}

test("Chinese edition is the sole master and translations bind to its hash and claims", () => {
  const content = prepareChineseMaster(item());
  content.editions.en = edition("en", "The team scored in minute 72 and won 2–1.");
  prepareDerivedEdition(content, "en", { current: true, agentVersion: "test-translator" });
  assert.equal(content.sourceLocale, "zh");
  assert.equal(content.sourceEditionHash, sourceEditionHash(content.editions.zh));
  assert.deepEqual(validateTranslation(content, "en"), []);
  content.editions.en.sections[0].paragraphs[0].claimRefs.push("new-claim");
  assert.ok(validateTranslation(content, "en").some(({ code }) => code === "claim_mapping_drift"));
});

test("numeric or source revision drift blocks a derived edition", () => {
  const content = prepareChineseMaster(item());
  content.editions.en = edition("en", "The team scored in minute 73 and won 3–1.");
  prepareDerivedEdition(content, "en", { current: true });
  const codes = validateTranslation(content, "en").map(({ code }) => code);
  assert.ok(codes.includes("numeric_drift"));
  content.sourceRevision = 2;
  assert.ok(validateTranslation(content, "en").some(({ code }) => code === "stale_source_revision"));
});

test("changing the Chinese master immediately quarantines every derived edition", () => {
  const content = prepareChineseMaster(item());
  content.editions.en = edition("en", "The team scored in minute 72 and won 2–1.");
  prepareDerivedEdition(content, "en", { current: true });
  Object.assign(content.editions.en, { status: "published", complianceStatus: "passed", complianceValidUntil: "2099-01-01T00:00:00Z", allowedJurisdictions: ["US"] });
  content.revision = 2;
  content.editions.zh.deck = "球队在第 72 分钟进球，最终以 2–1 获胜；这是修订后的母版。";
  prepareChineseMaster(content);
  assert.equal(content.editions.en.translationStatus, "stale");
  assert.equal(content.editions.en.status, "quarantined");
  assert.equal(content.editions.en.complianceStatus, "quarantined");
  assert.equal(content.editions.en.allowedJurisdictions, undefined);
});

test("insults, mind reading, allegations and injury speculation are class C", () => {
  for (const text of ["他是一个白痴。", "他显然不想比赛。", "他们踢了假球。", "他可能受伤。", "All people from that nation are cowards."]) {
    const content = item();
    content.editions.zh = edition("zh", text);
    assert.ok(scanProhibitedLanguage(content.editions.zh).some(({ severity }) => severity === "C"), text);
    assert.equal(riskClassForItem(content), "C", text);
  }
});

test("person profiles are never class A", () => {
  const content = item();
  content.type = "person_profile";
  assert.equal(riskClassForItem(content), "B");
});

test("legal packs require current dates, official source hashes and counsel signature", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  const pack = {
    jurisdiction: "CN",
    status: "active",
    reviewedAt: "2026-07-01T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counsel: { name: "Counsel", barJurisdiction: "CN", signatureHash: "a".repeat(64) },
    officialSources: [{ url: "https://example.gov.cn/law", checkedAt: "2026-07-01T00:00:00Z", contentHash: "b".repeat(64) }],
  };
  assert.equal(validateLegalPack(pack, policy, now).ok, true);
  assert.ok(validateLegalPack({ ...pack, expiresAt: "2026-07-14T00:00:00Z" }, policy, now).findings.includes("pack_expired"));
  assert.ok(validateLegalPack({ ...pack, counsel: {} }, policy, now).findings.includes("missing_counsel_signature"));
});

test("public editions need a current compliance lease and approved countries", () => {
  const content = prepareChineseMaster(item());
  Object.assign(content.editions.zh, { status: "published", complianceStatus: "passed", complianceValidUntil: "2099-01-01T00:00:00Z", allowedJurisdictions: ["CN"] });
  assert.equal(isEditionPublishable(content, "zh", new Date("2026-07-15T00:00:00Z")), true);
  content.editions.zh.allowedJurisdictions = [];
  assert.equal(isEditionPublishable(content, "zh", new Date("2026-07-15T00:00:00Z")), false);
});

test("approved editions are local-previewable but not production-publishable", () => {
  const content = prepareChineseMaster(item());
  Object.assign(content.editions.zh, { status: "approved", complianceStatus: "passed", complianceValidUntil: "2099-01-01T00:00:00Z", allowedJurisdictions: ["CN"] });
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(isEditionLocallyPreviewable(content, "zh", now), true);
  assert.equal(isEditionPublishable(content, "zh", now), false);
});

function activePack(jurisdiction) {
  return {
    jurisdiction,
    status: "active",
    reviewedAt: "2026-07-01T00:00:00Z",
    expiresAt: "2026-08-01T00:00:00Z",
    counsel: { name: "Counsel", barJurisdiction: jurisdiction, signatureHash: "a".repeat(64) },
    officialSources: [{ url: `https://law.example/${jurisdiction}`, checkedAt: "2026-07-01T00:00:00Z", contentHash: "b".repeat(64) }],
  };
}

function auditableFixture() {
  const localPolicy = { version: "test", sourceLocale: "zh", legalPackMaxAgeDays: 90, publicationLeaseHours: 24, minimumIndependentCoreSources: 2, localeMarkets: { zh: ["CN"], en: ["US"] } };
  const content = prepareChineseMaster(item());
  content.entityRefs = ["team-home", "team-away"];
  content.eventRefs = ["event-1"];
  content.nexusJurisdictions = ["CN"];
  content.riskClass = "A";
  content.editions.en = edition("en", "The team scored in minute 72 and won 2–1.");
  prepareDerivedEdition(content, "en", { current: true });
  const packs = [activePack("CN"), activePack("US")];
  const report = {
    contentId: content.id,
    revision: content.revision,
    sourceEditionHash: content.sourceEditionHash,
    policyHash: policyHash(localPolicy),
    legalPackHashes: packs.map(legalPackHash),
    riskClass: "A",
    decision: "PASS",
    scope: "all_locales",
    jurisdictionDecisions: [{ jurisdiction: "CN", decision: "PASS" }, { jurisdiction: "US", decision: "PASS" }],
    factFindings: [], civilityFindings: [], translationFindings: [], prohibitedClaimFindings: [],
    expiresAt: "2026-07-16T00:00:00Z",
    reviewRunId: "test-review-run",
  };
  return {
    item: content,
    policy: localPolicy,
    legalRegistry: { operatorJurisdictions: ["CN"], packs },
    data: {
      entities: [
        { id: "team-home", kind: "Team", attributes: { jurisdiction: "CN" } },
        { id: "team-away", kind: "Team", attributes: { jurisdiction: "US" } },
      ],
      facts: [{ id: "fact-1", predicate: "final_result", status: "confirmed", value: { homeScore: 2, awayScore: 1 }, evidenceRefs: ["ev-1", "ev-2"] }],
    },
    evidenceRecords: [{ id: "ev-1", sourceId: "source-a" }, { id: "ev-2", sourceId: "source-b" }],
    sourceRegistry: [{ id: "source-a", independenceGroup: "group-a" }, { id: "source-b", independenceGroup: "group-b" }],
    agentReport: report,
    now: new Date("2026-07-15T00:00:00Z"),
  };
}

test("deterministic audit accepts a low-risk item only with independent evidence, packs and a matching report", () => {
  const fixture = auditableFixture();
  const result = auditContentItem(fixture);
  assert.equal(result.decision, "PASS");
  assert.deepEqual(result.allowedJurisdictions, ["CN", "US"]);
});

test("offline, stale or forged reviewer reports cannot authorize publication", () => {
  const missing = auditableFixture();
  missing.agentReport = null;
  assert.equal(auditContentItem(missing).decision, "BLOCK");
  const forged = auditableFixture();
  forged.agentReport = { ...forged.agentReport, sourceEditionHash: "f".repeat(64) };
  assert.equal(auditContentItem(forged).decision, "BLOCK");
});

test("one evidence organization posing as two sources is not independent", () => {
  const fixture = auditableFixture();
  fixture.sourceRegistry[1].independenceGroup = "group-a";
  const result = auditContentItem(fixture);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.findings.some(({ code }) => code === "insufficient_independent_sources"));
});

test("one authorised official source can satisfy the core fact gate when policy allows it", () => {
  const fixture = auditableFixture();
  fixture.policy = { ...fixture.policy, allowSingleOfficialCoreSource: true };
  fixture.agentReport = { ...fixture.agentReport, policyHash: policyHash(fixture.policy) };
  fixture.data.facts[0].evidenceRefs = ["ev-1"];
  fixture.evidenceRecords = [{ id: "ev-1", sourceId: "fifa" }];
  fixture.sourceRegistry = [{ id: "fifa", independenceGroup: "fifa", official: true, license: { authorised: true } }];
  const result = auditContentItem(fixture);
  assert.equal(result.decision, "PASS");
  assert.deepEqual(result.allowedJurisdictions, ["CN", "US"]);
});

test("deterministic audit can pass without legal packs when policy disables legal validation", () => {
  const fixture = auditableFixture();
  fixture.policy = { ...fixture.policy, disableLegalPackValidation: true };
  fixture.legalRegistry = { operatorJurisdictions: ["ZZ"], packs: [] };
  fixture.agentReport = {
    ...fixture.agentReport,
    policyHash: policyHash(fixture.policy),
    legalPackHashes: [],
    jurisdictionDecisions: [],
  };
  const result = auditContentItem(fixture);
  assert.equal(result.decision, "PASS");
  assert.deepEqual(result.allowedJurisdictions, ["CN", "US"]);
});

test("agent preaudit accepts operator-jurisdiction decisions when explicitly expected", () => {
  const fixture = auditableFixture();
  const report = {
    ...fixture.agentReport,
    jurisdictionDecisions: [
      ...fixture.agentReport.jurisdictionDecisions,
      { jurisdiction: "ZZ", decision: "BLOCK", ruleRefs: ["missing_legal_coverage"] },
    ],
  };
  const validation = validateAgentPreAudit(report, {
    item: fixture.item,
    policy: fixture.policy,
    legalPacks: fixture.legalRegistry.packs,
    expectedJurisdictions: ["CN", "US", "ZZ"],
    now: fixture.now,
  });
  assert.equal(validation.ok, true);
});

test("zh-only local preview audit does not require untranslated locales", () => {
  const fixture = auditableFixture();
  delete fixture.item.editions.en;
  fixture.policy = { ...fixture.policy, localeMarkets: { zh: ["CN"], en: ["US"], ja: ["JP"] } };
  fixture.legalRegistry = { operatorJurisdictions: ["ZZ"], packs: [activePack("CN")] };
  fixture.agentReport = {
    ...fixture.agentReport,
    legalPackHashes: [legalPackHash(fixture.legalRegistry.packs[0])],
    jurisdictionDecisions: [
      { jurisdiction: "CN", decision: "PASS", ruleRefs: ["local_preview"] },
      { jurisdiction: "ZZ", decision: "BLOCK", ruleRefs: ["publishing_entity_jurisdiction_unconfirmed"] },
    ],
  };
  const result = auditContentItem({ ...fixture, requestedLocales: new Set(["zh"]) });
  assert.equal(result.findings.some(({ code, locale }) => code === "missing_required_locale" && locale === "en"), false);
  assert.equal(result.findings.some(({ code, locale }) => code === "missing_required_locale" && locale === "ja"), false);
});
