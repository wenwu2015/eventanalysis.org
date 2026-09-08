import test from "node:test";
import assert from "node:assert/strict";
import { countsTowardDailyDraftLimit, createFactBundleCandidate, evidencePlan, selectEvidenceSources, stopsDailyRunForAccessControl } from "../pipeline/lib/daily-postmatch.mjs";
import { authorisedSourceEntityId, authorisedSourceEventId, focusPersonEntityId } from "../pipeline/lib/fact-materializer.mjs";
import { resolveAutomationNow } from "../pipeline/lib/automation-clock.mjs";

test("world cup daily selection prefers one authorised official FIFA source", () => {
  const event = { uniqueTournamentId: 16, competition: "FIFA World Cup" };
  const sources = [
    { id: "fifa", official: true, license: { authorised: true }, coverage: ["world-cup"] },
    { id: "generic", matchUrlTemplate: "https://example.com/{id}", eventMapping: { id: "match.id" }, coverage: ["global-football"] },
  ];
  assert.deepEqual(
    selectEvidenceSources(sources, event, { allowSingleOfficialCoreSource: true }).map(({ id }) => id),
    ["fifa"],
  );
});

test("non-FIFA daily selection keeps multi-source mode when corroborators exist", () => {
  const event = { uniqueTournamentId: 7, competition: "UEFA Champions League, Qualification" };
  const sources = [
    { id: "fifa", official: true, license: { authorised: true }, coverage: ["world-cup"] },
    { id: "generic", matchUrlTemplate: "https://example.com/{id}", eventMapping: { id: "match.id" }, coverage: ["global-football"] },
  ];
  assert.deepEqual(
    evidencePlan(sources, event, { allowSingleOfficialCoreSource: true }),
    {
      eligible: true,
      useDiscoverySource: true,
      sources: [sources[1]],
      mode: "multi_source",
    },
  );
});

test("authorised discovery source can keep non-FIFA matches eligible in single-source mode", () => {
  const event = { uniqueTournamentId: 7, competition: "UEFA Champions League, Qualification" };
  const discoverySource = { id: "sofascore", license: { authorised: true }, coverage: ["global-football"] };
  assert.deepEqual(
    evidencePlan([], event, { allowSingleAuthorisedCoreSource: true, discoverySource }),
    {
      eligible: true,
      useDiscoverySource: true,
      sources: [],
      mode: "authorised_single_source",
    },
  );
});

test("fact bundle candidate uses authorised-source ids for stable dedupe", () => {
  const facts = {
    sport: "football",
    match: {
      id: "400021540",
      homeTeamId: "43922",
      awayTeamId: "43948",
    },
    focusPeople: [
      { sourcePlayerId: "448202", teamId: "43942", name: "Jude BELLINGHAM" },
    ],
  };
  const candidate = createFactBundleCandidate(facts);
  assert.deepEqual(candidate.eventRefs, [authorisedSourceEventId("400021540")]);
  assert.deepEqual(candidate.entityRefs, [
    focusPersonEntityId({ sourcePlayerId: "448202", teamId: "43942", name: "Jude BELLINGHAM" }),
    authorisedSourceEntityId("43922"),
    authorisedSourceEntityId("43948"),
  ]);
});

test("authorised single-source fallback can generate a distinct moment analysis candidate", () => {
  const facts = {
    id: "match-400021540",
    sport: "football",
    match: {
      id: "400021540",
      homeTeamId: "43922",
      awayTeamId: "43948",
    },
  };
  const candidate = createFactBundleCandidate(facts, { type: "moment_analysis" });
  assert.equal(candidate.id, "moment-400021540");
  assert.equal(candidate.type, "moment_analysis");
  assert.equal(candidate.angleKey, "post-match-key-moment");
});

test("EA_NOW_ISO can pin the automation clock", () => {
  assert.equal(
    resolveAutomationNow("2026-08-11T08:00:00+08:00").toISOString(),
    "2026-08-11T00:00:00.000Z",
  );
  assert.throws(() => resolveAutomationNow("not-a-date"), /Invalid EA_NOW_ISO value/);
});

test("dry-run outputs still count toward the daily draft cap", () => {
  assert.equal(countsTowardDailyDraftLimit({ kind: "dry-run" }), true);
  assert.equal(countsTowardDailyDraftLimit({ kind: "draft" }), true);
  assert.equal(countsTowardDailyDraftLimit({ kind: "blocked" }), false);
});

test("daily run stops immediately on access-controlled detail collection", () => {
  assert.equal(stopsDailyRunForAccessControl({
    kind: "no_evidence",
    collectionErrors: [{ sourceId: "sofascore", code: "ACCESS_CONTROL_REQUIRED" }],
  }), true);
  assert.equal(stopsDailyRunForAccessControl({
    kind: "no_evidence",
    collectionErrors: [{ sourceId: "sofascore", code: "collection_failed" }],
  }), false);
});
