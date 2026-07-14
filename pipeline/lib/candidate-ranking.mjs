const competitionWeights = [
  [/(world cup|世界杯)/i, 100],
  [/(champions league|欧冠)/i, 95],
  [/(euro|欧洲杯|copa america)/i, 90],
  [/(premier league|la liga|bundesliga|serie a|ligue 1)/i, 75],
];

function competitionWeight(name) {
  return competitionWeights.find(([pattern]) => pattern.test(name))?.[1] ?? 40;
}

export function rankCandidates(events) {
  return events
    .map((event) => {
      const goalCount = (event.homeScore || 0) + (event.awayScore || 0);
      const closeGame = Math.abs((event.homeScore || 0) - (event.awayScore || 0)) <= 1 ? 12 : 0;
      const score = competitionWeight(event.competition) + Math.min(goalCount, 6) * 3 + closeGame;
      return { ...event, editorialScore: score };
    })
    .sort((a, b) => b.editorialScore - a.editorialScore || b.startTimestamp - a.startTimestamp);
}
