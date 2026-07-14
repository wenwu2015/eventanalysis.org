import test from "node:test";
import assert from "node:assert/strict";
import { buildHeadToHead, calculateHeadToHead, calculateLineupContinuity, scoreResult } from "../pipeline/lib/calculations.mjs";
import { winnerTrailedFromScores } from "../pipeline/lib/world-cup-content.mjs";

test("head-to-head rates use the complete pre-match sample", () => {
  assert.deepEqual(calculateHeadToHead({ homeWins: 10, draws: 4, awayWins: 13 }), {
    matches: 27,
    homeWinRate: 37,
    drawRate: 14.8,
    awayWinRate: 48.1,
  });
});

test("line-up continuity counts unique shared current players", () => {
  assert.deepEqual(calculateLineupContinuity([1, 2, 3, 3], [2, 3, 4, 4]), {
    shared: 2,
    current: 3,
    rate: 66.7,
  });
});

test("result and historical winner are normalised from the score", () => {
  assert.equal(scoreResult(2, 1), "home_win");
  assert.equal(scoreResult(1, 2), "away_win");
  assert.equal(scoreResult(1, 1), "draw");
  const history = buildHeadToHead([
    { id: "old-1", status: "finished", homeTeamId: "A", awayTeamId: "B", homeScore: 1, awayScore: 0 },
    { id: "old-2", status: "finished", homeTeamId: "B", awayTeamId: "A", homeScore: 2, awayScore: 2 },
    { id: "current", status: "finished", homeTeamId: "A", awayTeamId: "B", homeScore: 3, awayScore: 0 },
  ], "current", "A", "B");
  assert.equal(history.matches, 2);
  assert.equal(history.homeWins, 1);
  assert.equal(history.draws, 1);
});

test("invalid numeric input is rejected instead of guessed", () => {
  assert.throws(() => calculateHeadToHead({ homeWins: -1, draws: 0, awayWins: 0 }), /non-negative/);
  assert.throws(() => scoreResult(Number.NaN, 0), /finite/);
});

test("a winner is marked as coming from behind only when the running score shows a deficit", () => {
  assert.equal(winnerTrailedFromScores([
    { homeScore: 1, awayScore: 0 },
    { homeScore: 1, awayScore: 1 },
    { homeScore: 2, awayScore: 1 },
  ], true), false);
  assert.equal(winnerTrailedFromScores([
    { homeScore: 0, awayScore: 1 },
    { homeScore: 1, awayScore: 1 },
    { homeScore: 2, awayScore: 1 },
  ], true), true);
  assert.equal(winnerTrailedFromScores([
    { homeScore: 1, awayScore: 0 },
    { homeScore: 1, awayScore: 2 },
  ], false), true);
});
