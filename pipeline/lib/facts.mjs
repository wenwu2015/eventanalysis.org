import { buildHeadToHead, scoreResult } from "./calculations.mjs";

function coreSignature(event) {
  return JSON.stringify({
    home: event.homeTeam,
    away: event.awayTeam,
    homeScore: event.homeScore,
    awayScore: event.awayScore,
  });
}

export function buildFactBundle(evidence, minimumIndependentCoreSources = 2) {
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("No evidence was collected");
  const signatures = new Map();
  for (const item of evidence) {
    const signature = coreSignature(item.event);
    const sources = signatures.get(signature) || new Set();
    sources.add(item.sourceId);
    signatures.set(signature, sources);
  }
  const agreed = [...signatures.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  const coreSources = agreed?.[1] || new Set();
  const primary = evidence.find((item) => coreSignature(item.event) === agreed?.[0]) || evidence[0];
  const event = primary.event;
  const headToHead = buildHeadToHead(
    primary.h2hEvents || [],
    event.id,
    event.homeTeamId,
    event.awayTeamId,
  );
  const missing = [];
  if (coreSources.size < minimumIndependentCoreSources) missing.push("independent_core_source_confirmation");
  if (headToHead.matches === 0) missing.push("head_to_head_history");
  missing.push("personnel_change_confirmation");
  return {
    schemaVersion: 1,
    id: `match-${event.id}`,
    sport: String(event.sport || "football").toLowerCase(),
    collectedAt: new Date().toISOString(),
    status: missing.length ? "data_incomplete" : "needs_review",
    match: {
      id: event.id,
      competition: event.competition,
      startedAt: new Date(event.startTimestamp * 1000).toISOString(),
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      homeScore: event.homeScore,
      awayScore: event.awayScore,
      result: scoreResult(event.homeScore, event.awayScore),
    },
    headToHeadBeforeMatch: headToHead,
    personnelChanges: [],
    keyEvents: [],
    videoObservations: [],
    coreSourceConfirmations: coreSources.size,
    missing,
  };
}
