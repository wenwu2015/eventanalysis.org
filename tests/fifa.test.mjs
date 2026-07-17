import test from "node:test";
import assert from "node:assert/strict";
import { buildLineupContinuityRecord, extractFifaHeadToHeadEvents, extractFifaKeyEvents, extractWorldCupFixturesFromArticle, normalizeFifaMatch, previousMatchFromTeamForm } from "../pipeline/adapters/fifa.mjs";

test("world cup article extraction keeps finished match links and scores", () => {
  const fixtures = extractWorldCupFixturesFromArticle([{
    richtext: {
      content: [
        { nodeType: "heading-4", content: [{ nodeType: "text", value: "Tuesday, 14 July 2026" }] },
        {
          nodeType: "paragraph",
          content: [
            { nodeType: "text", value: "Match 101 – " },
            { nodeType: "hyperlink", data: { uri: "https://www.fifa.com/en/match-centre/match/17/285023/289290/400021541" }, content: [{ nodeType: "text", value: "France 0-2 Spain" }] },
            { nodeType: "text", value: " - Dallas Stadium" },
          ],
        },
      ],
    },
  }]);
  assert.deepEqual(fixtures, [{
    competitionId: "17",
    seasonId: "285023",
    stageId: "289290",
    matchId: "400021541",
    homeTeam: "France",
    awayTeam: "Spain",
    homeScore: 0,
    awayScore: 2,
    dateLabel: "Tuesday, 14 July 2026",
    url: "https://www.fifa.com/en/match-centre/match/17/285023/289290/400021541",
  }]);
});

test("FIFA live payloads normalize into comparable match events", () => {
  const event = normalizeFifaMatch({
    IdMatch: "400021541",
    IdCompetition: "17",
    IdSeason: "285023",
    IdStage: "289290",
    CompetitionName: [{ Locale: "en-GB", Description: "FIFA World Cup™" }],
    Date: "2026-07-14T19:00:00Z",
    HomeTeamScore: 0,
    AwayTeamScore: 2,
    HomeTeam: { IdTeam: "43946", IdCountry: "FRA", TeamName: [{ Locale: "en-GB", Description: "France" }] },
    AwayTeam: { IdTeam: "43969", IdCountry: "ESP", TeamName: [{ Locale: "en-GB", Description: "Spain" }] },
  });
  assert.equal(event.id, "400021541");
  assert.equal(event.homeTeam, "France");
  assert.equal(event.awayScore, 2);
});

test("lineup continuity counts shared starters and incoming changes", () => {
  const current = {
    Players: [
      { IdPlayer: "1", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "One" }] },
      { IdPlayer: "2", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "Two" }] },
      { IdPlayer: "3", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "Three" }] },
      { IdPlayer: "8", Status: 2, PlayerName: [{ Locale: "en-GB", Description: "Bench" }] },
    ],
  };
  const previous = {
    Players: [
      { IdPlayer: "2", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "Two" }] },
      { IdPlayer: "3", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "Three" }] },
      { IdPlayer: "4", Status: 1, PlayerName: [{ Locale: "en-GB", Description: "Four" }] },
    ],
  };
  const record = buildLineupContinuityRecord(current, previous, { currentMatchId: "m2", previousMatchId: "m1", teamId: "t1", teamName: "Team" });
  assert.equal(record.sharedStarters, 2);
  assert.equal(record.currentStarters, 3);
  assert.equal(record.continuityRate, 66.7);
  assert.deepEqual(record.incomingPlayerIds, ["1"]);
  assert.deepEqual(record.outgoingPlayerIds, ["4"]);
});

test("team form picks the previous completed match", () => {
  const previous = previousMatchFromTeamForm({
    MatchesList: [
      { IdMatch: "current", MatchStatus: 0 },
      { IdMatch: "previous", MatchStatus: 0 },
      { IdMatch: "older", MatchStatus: 1 },
    ],
  }, "current");
  assert.equal(previous.IdMatch, "previous");
});

test("head-to-head and timeline payloads normalize into deterministic lists", () => {
  const h2h = extractFifaHeadToHeadEvents([{
    MatchesList: [{
      IdMatch: "old",
      IdCompetition: "17",
      IdSeason: "285023",
      IdStage: "289289",
      CompetitionName: [{ Locale: "en-GB", Description: "FIFA World Cup™" }],
      Date: "2026-07-10T19:00:00Z",
      HomeTeamScore: 2,
      AwayTeamScore: 1,
      Home: { IdTeam: "43969", IdCountry: "ESP", TeamName: [{ Locale: "en-GB", Description: "Spain" }] },
      Away: { IdTeam: "43946", IdCountry: "FRA", TeamName: [{ Locale: "en-GB", Description: "France" }] },
    }],
  }]);
  const events = extractFifaKeyEvents([{
    Event: [
      { MatchMinute: "22'", HomeGoals: 0, AwayGoals: 1, IdTeam: "43969", TypeLocalized: [{ Locale: "en-GB", Description: "Penalty Goal" }], EventDescription: [{ Locale: "en-GB", Description: "Spain score" }] },
      { MatchMinute: "22'", HomeGoals: 0, AwayGoals: 1, IdTeam: "43969", TypeLocalized: [{ Locale: "en-GB", Description: "Penalty Goal" }], EventDescription: [{ Locale: "en-GB", Description: "Duplicate" }] },
    ],
  }]);
  assert.equal(h2h[0].homeTeam, "Spain");
  assert.deepEqual(events, [{
    minute: "22'",
    homeScore: 0,
    awayScore: 1,
    teamId: "43969",
    eventType: "Penalty Goal",
    description: "Spain score",
  }]);
});
