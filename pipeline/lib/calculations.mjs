function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

export function calculateHeadToHead({ homeWins, draws, awayWins }) {
  assertNonNegativeInteger(homeWins, "homeWins");
  assertNonNegativeInteger(draws, "draws");
  assertNonNegativeInteger(awayWins, "awayWins");
  const matches = homeWins + draws + awayWins;
  if (matches === 0) return { matches: 0, homeWinRate: null, drawRate: null, awayWinRate: null };
  const rate = (value) => Number(((value / matches) * 100).toFixed(1));
  return { matches, homeWinRate: rate(homeWins), drawRate: rate(draws), awayWinRate: rate(awayWins) };
}

export function calculateLineupContinuity(previousPlayerIds, currentPlayerIds) {
  const previous = new Set(previousPlayerIds.filter(Boolean));
  const current = new Set(currentPlayerIds.filter(Boolean));
  if (current.size === 0) return { shared: 0, current: 0, rate: null };
  let shared = 0;
  for (const id of current) if (previous.has(id)) shared += 1;
  return { shared, current: current.size, rate: Number(((shared / current.size) * 100).toFixed(1)) };
}

export function scoreResult(homeScore, awayScore) {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) throw new TypeError("Scores must be finite numbers");
  if (homeScore > awayScore) return "home_win";
  if (awayScore > homeScore) return "away_win";
  return "draw";
}

export function buildHeadToHead(events, currentEventId, homeTeamId, awayTeamId) {
  const previous = events.filter((event) =>
    String(event.id) !== String(currentEventId)
    && event.status === "finished"
    && [String(event.homeTeamId), String(event.awayTeamId)].includes(String(homeTeamId))
    && [String(event.homeTeamId), String(event.awayTeamId)].includes(String(awayTeamId))
  );
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  for (const event of previous) {
    const result = scoreResult(event.homeScore, event.awayScore);
    if (result === "draw") draws += 1;
    else {
      const winnerId = result === "home_win" ? event.homeTeamId : event.awayTeamId;
      if (String(winnerId) === String(homeTeamId)) homeWins += 1;
      else awayWins += 1;
    }
  }
  return { homeWins, draws, awayWins, ...calculateHeadToHead({ homeWins, draws, awayWins }) };
}
