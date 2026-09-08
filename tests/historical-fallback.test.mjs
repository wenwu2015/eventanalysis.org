import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoricalFallbackPlan, extractFocusPeople } from "../pipeline/lib/historical-fallback.mjs";
import { focusPersonEntityId } from "../pipeline/lib/fact-materializer.mjs";

test("extractFocusPeople prioritizes scored and substitution-linked players", () => {
  const focusPeople = extractFocusPeople(
    [{
      teamId: "43942",
      incomingPlayers: [{ id: "448202", name: "Jude BELLINGHAM" }],
      outgoingPlayers: [{ id: "448198", name: "Ivan TONEY" }],
    }],
    [
      { teamId: "43942", eventType: "Goal!", description: "Jude BELLINGHAM (England) scores!!" },
      { teamId: "43942", eventType: "Assist", description: "Assisted by Declan RICE." },
    ],
    3,
  );
  assert.equal(focusPeople[0].name, "Jude BELLINGHAM");
  assert.equal(focusPeople[1].name, "Declan RICE");
});

test("historical fallback plan skips an existing event-person commentary pair", () => {
  const person = { sourcePlayerId: "448202", teamId: "43942", name: "Jude BELLINGHAM" };
  const personId = focusPersonEntityId(person);
  const data = {
    entities: [
      { id: "team_home", kind: "Team", sport: "football", names: { zh: "England" }, aliases: ["England"], attributes: { jurisdiction: "GB" } },
      { id: "team_away", kind: "Team", sport: "football", names: { zh: "Argentina" }, aliases: ["Argentina"], attributes: { jurisdiction: "AR" } },
      { id: personId, kind: "Person", sport: "football", names: { zh: "Jude BELLINGHAM" }, aliases: ["Jude BELLINGHAM"], attributes: {} },
    ],
    events: [
      { id: "event_1", kind: "match", startedAt: "2026-07-19T19:00:00.000Z", competitionName: "FIFA World Cup, Knockout", homeTeamId: "team_home", awayTeamId: "team_away" },
    ],
    facts: [
      { id: "f1", subjectId: "event_1", predicate: "final_result", value: { homeScore: 2, awayScore: 1, result: "home_win" }, evidenceRefs: ["e1"] },
      { id: "f2", subjectId: "event_1", predicate: "head_to_head_before_match", value: { matches: 2, homeWins: 1, awayWins: 1, draws: 0 }, evidenceRefs: ["e2"] },
      { id: "f3", subjectId: "event_1", predicate: "personnel_changes", value: [{ teamId: "43942", incomingPlayers: [{ id: "448202", name: "Jude BELLINGHAM" }], outgoingPlayers: [] }], evidenceRefs: ["e3"] },
      { id: "f4", subjectId: "event_1", predicate: "key_events", value: [{ teamId: "43942", eventType: "Goal!", description: "Jude BELLINGHAM (England) scores!!" }], evidenceRefs: ["e4"] },
    ],
    items: [
      { type: "match_analysis", eventRefs: ["event_1"], entityRefs: [personId] },
    ],
  };
  const plan = buildHistoricalFallbackPlan(data, { now: new Date("2026-07-22T00:00:00.000Z"), lookbackDays: 365, maxCandidates: 10 });
  assert.equal(plan.some(({ pairKey }) => pairKey === `event_1:${personId}`), false);
});

test("historical fallback plan gives each event-person draft a unique facts id", () => {
  const data = {
    entities: [
      { id: "team_home", kind: "Team", sport: "football", names: { zh: "England" }, aliases: ["England"], attributes: { jurisdiction: "GB" } },
      { id: "team_away", kind: "Team", sport: "football", names: { zh: "Argentina" }, aliases: ["Argentina"], attributes: { jurisdiction: "AR" } },
    ],
    events: [
      { id: "event_1", kind: "match", startedAt: "2026-07-19T19:00:00.000Z", competitionName: "FIFA World Cup, Knockout", homeTeamId: "team_home", awayTeamId: "team_away" },
    ],
    facts: [
      { id: "f1", subjectId: "event_1", predicate: "final_result", value: { homeScore: 2, awayScore: 1, result: "home_win" }, evidenceRefs: ["e1"] },
      { id: "f2", subjectId: "event_1", predicate: "head_to_head_before_match", value: { matches: 2, homeWins: 1, awayWins: 1, draws: 0 }, evidenceRefs: ["e2"] },
      { id: "f3", subjectId: "event_1", predicate: "personnel_changes", value: [{ teamId: "43942", incomingPlayers: [{ id: "448202", name: "Jude BELLINGHAM" }], outgoingPlayers: [] }], evidenceRefs: ["e3"] },
      { id: "f4", subjectId: "event_1", predicate: "key_events", value: [
        { teamId: "43942", eventType: "Goal!", description: "Jude BELLINGHAM (England) scores!!" },
        { teamId: "43922", eventType: "Goal!", description: "Lionel MESSI (Argentina) scores!!" },
      ], evidenceRefs: ["e4"] },
    ],
    items: [],
  };
  const plan = buildHistoricalFallbackPlan(data, { now: new Date("2026-07-22T00:00:00.000Z"), lookbackDays: 365, maxCandidates: 10 });
  assert.equal(plan.length >= 2, true);
  assert.equal(new Set(plan.map(({ facts }) => facts.id)).size, plan.length);
});
