import test from "node:test";
import assert from "node:assert/strict";
import { buildFactBundle } from "../pipeline/lib/facts.mjs";

test("fact bundle normalizes cross-source team ids before calculating head-to-head", () => {
  const bundle = buildFactBundle([
    {
      sourceId: "sofascore",
      evidenceId: "evidence-a",
      event: {
        id: "match-1",
        sport: "football",
        competition: "World Championship, Knockout",
        startTimestamp: 1_784_632_800,
        homeTeamId: "4713",
        awayTeamId: "4819",
        homeTeam: "England",
        awayTeam: "Argentina",
        homeJurisdiction: "EN",
        awayJurisdiction: "AR",
        homeScore: 1,
        awayScore: 2,
      },
      h2hEvents: [],
      personnelChanges: [{ teamName: "England" }],
      keyEvents: [],
    },
    {
      sourceId: "fifa",
      evidenceId: "evidence-b",
      event: {
        id: "400021540",
        sport: "Football",
        competition: "FIFA World Cup™",
        startTimestamp: 1_784_632_800,
        homeTeamId: "43942",
        awayTeamId: "43922",
        homeTeam: "England",
        awayTeam: "Argentina",
        homeJurisdiction: "ENG",
        awayJurisdiction: "ARG",
        homeScore: 1,
        awayScore: 2,
      },
      h2hEvents: [{
        id: "old-1",
        status: "finished",
        homeTeamId: "43922",
        awayTeamId: "43942",
        homeTeam: "Argentina",
        awayTeam: "England",
        homeScore: 2,
        awayScore: 1,
      }],
      personnelChanges: [{ teamName: "Argentina" }],
      keyEvents: [],
    },
  ], 2);

  assert.equal(bundle.coreSourceConfirmations, 2);
  assert.equal(bundle.headToHeadBeforeMatch.matches, 1);
  assert.equal(bundle.missing.includes("head_to_head_history"), false);
});

test("fact bundle accepts one authorised official source for core confirmation", () => {
  const bundle = buildFactBundle([
    {
      sourceId: "fifa",
      evidenceId: "evidence-fifa",
      event: {
        id: "match-2",
        sport: "Football",
        competition: "FIFA World Cup™",
        startTimestamp: 1_784_632_800,
        homeTeamId: "43942",
        awayTeamId: "43922",
        homeTeam: "England",
        awayTeam: "Argentina",
        homeJurisdiction: "ENG",
        awayJurisdiction: "ARG",
        homeScore: 1,
        awayScore: 2,
      },
      h2hEvents: [{
        id: "old-2",
        status: "finished",
        homeTeamId: "43922",
        awayTeamId: "43942",
        homeTeam: "Argentina",
        awayTeam: "England",
        homeScore: 2,
        awayScore: 1,
      }],
      personnelChanges: [{ teamName: "England" }],
      keyEvents: [],
    },
  ], 2, {
    allowSingleOfficialCoreSource: true,
    sourceRegistry: [{
      id: "fifa",
      official: true,
      license: { authorised: true },
    }],
  });

  assert.equal(bundle.coreSourceConfirmations, 1);
  assert.equal(bundle.missing.includes("independent_core_source_confirmation"), false);
  assert.equal(bundle.status, "needs_review");
});

test("fact bundle accepts one authorised non-official source for core confirmation when policy allows it", () => {
  const bundle = buildFactBundle([
    {
      sourceId: "sofascore",
      evidenceId: "evidence-sofa",
      event: {
        id: "match-3",
        sport: "Football",
        competition: "UEFA Champions League",
        startTimestamp: 1_784_632_800,
        homeTeamId: "100",
        awayTeamId: "200",
        homeTeam: "Home",
        awayTeam: "Away",
        homeJurisdiction: "EN",
        awayJurisdiction: "ES",
        homeScore: 2,
        awayScore: 1,
      },
      h2hEvents: [{
        id: "old-3",
        status: "finished",
        homeTeamId: "100",
        awayTeamId: "200",
        homeTeam: "Home",
        awayTeam: "Away",
        homeScore: 1,
        awayScore: 0,
      }],
      personnelChanges: [{ teamName: "Home" }],
      keyEvents: [],
    },
  ], 2, {
    allowSingleAuthorisedCoreSource: true,
    sourceRegistry: [{
      id: "sofascore",
      official: false,
      license: { authorised: true },
    }],
  });

  assert.equal(bundle.coreSourceConfirmations, 1);
  assert.equal(bundle.missing.includes("independent_core_source_confirmation"), false);
  assert.equal(bundle.status, "needs_review");
});

test("single authorised source can stay reviewable without head-to-head or personnel changes", () => {
  const bundle = buildFactBundle([
    {
      sourceId: "sofascore",
      evidenceId: "evidence-sofa-narrow",
      event: {
        id: "match-4",
        sport: "Football",
        competition: "UEFA Champions League",
        startTimestamp: 1_784_632_800,
        homeTeamId: "300",
        awayTeamId: "400",
        homeTeam: "Alpha",
        awayTeam: "Beta",
        homeJurisdiction: "EN",
        awayJurisdiction: "DE",
        homeScore: 1,
        awayScore: 0,
      },
      h2hEvents: [],
      personnelChanges: [],
      keyEvents: [],
    },
  ], 2, {
    allowSingleAuthorisedCoreSource: true,
    sourceRegistry: [{
      id: "sofascore",
      official: false,
      license: { authorised: true },
    }],
  });

  assert.equal(bundle.coreSourceConfirmations, 1);
  assert.equal(bundle.missing.includes("head_to_head_history"), false);
  assert.equal(bundle.missing.includes("personnel_change_confirmation"), false);
  assert.equal(bundle.status, "needs_review");
});

test("fact bundle uses the pinned automation timestamp when provided", () => {
  const bundle = buildFactBundle([
    {
      sourceId: "sofascore",
      evidenceId: "evidence-sofa-now",
      event: {
        id: "match-5",
        sport: "Football",
        competition: "Serie A",
        startTimestamp: 1_784_632_800,
        homeTeamId: "500",
        awayTeamId: "600",
        homeTeam: "Gamma",
        awayTeam: "Delta",
        homeJurisdiction: "IT",
        awayJurisdiction: "IT",
        homeScore: 1,
        awayScore: 1,
      },
      h2hEvents: [],
      personnelChanges: [],
      keyEvents: [],
    },
  ], 2, {
    allowSingleAuthorisedCoreSource: true,
    now: new Date("2026-08-25T13:00:00.000Z"),
    sourceRegistry: [{
      id: "sofascore",
      official: false,
      license: { authorised: true },
    }],
  });

  assert.equal(bundle.collectedAt, "2026-08-25T13:00:00.000Z");
});
