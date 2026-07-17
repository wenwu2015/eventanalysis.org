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
