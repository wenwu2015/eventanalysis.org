function normalizedCoverage(source) {
  return new Set((source.coverage || []).map((value) => String(value || "").toLowerCase()));
}

function competitionName(event) {
  return String(event?.competition || "").toLowerCase();
}

export function isWorldCupEvent(event) {
  return event?.uniqueTournamentId === 16 || /world cup|world championship|世界杯/.test(competitionName(event));
}

export function sourceSupportsEvent(source, event) {
  const coverage = normalizedCoverage(source);
  if (coverage.has("global-football")) return true;
  if (coverage.has("world-cup")) return isWorldCupEvent(event);
  return false;
}

export function sourceCanCorroborateEvent(source, event) {
  if (!sourceSupportsEvent(source, event)) return false;
  if (source.id === "fifa") return true;
  return Boolean(source.matchUrlTemplate && source.eventMapping);
}
