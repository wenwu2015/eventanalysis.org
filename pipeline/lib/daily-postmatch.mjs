import { createCandidate } from "./content-candidates.mjs";
import { authorisedSourceEntityId, authorisedSourceEventId, focusPersonEntityId } from "./fact-materializer.mjs";
import { sourceCanCorroborateEvent, sourceSupportsEvent } from "./source-capabilities.mjs";

function isAuthorisedOfficialSource(source = null) {
  return Boolean(source?.official && source?.license?.authorised);
}

function isAuthorisedSource(source = null) {
  return Boolean(source?.license?.authorised);
}

function officialEvidenceSources(sources, event) {
  const candidates = Array.isArray(sources) ? sources : [];
  return candidates.filter((source) => isAuthorisedOfficialSource(source) && sourceSupportsEvent(source, event));
}

function corroboratingSources(sources, event) {
  const candidates = Array.isArray(sources) ? sources : [];
  return candidates.filter((source) => sourceCanCorroborateEvent(source, event));
}

export function evidencePlan(sources, event, {
  allowSingleOfficialCoreSource = false,
  allowSingleAuthorisedCoreSource = false,
  discoverySource = null,
} = {}) {
  const official = officialEvidenceSources(sources, event);
  if (allowSingleOfficialCoreSource && official.length) {
    return {
      eligible: true,
      useDiscoverySource: false,
      sources: official,
      mode: "official_single_source",
    };
  }
  if (allowSingleAuthorisedCoreSource && isAuthorisedSource(discoverySource) && sourceSupportsEvent(discoverySource, event)) {
    return {
      eligible: true,
      useDiscoverySource: true,
      sources: [],
      mode: "authorised_single_source",
    };
  }
  const corroborators = corroboratingSources(sources, event);
  return {
    eligible: corroborators.length > 0,
    useDiscoverySource: corroborators.length > 0,
    sources: corroborators,
    mode: corroborators.length > 0 ? "multi_source" : "ineligible",
  };
}

export function selectEvidenceSources(sources, event, options = {}) {
  return evidencePlan(sources, event, options).sources;
}

export function createFactBundleCandidate(
  facts,
  {
    type = "match_analysis",
    angle = type === "moment_analysis" ? "post-match-key-moment" : "post-match-result-mechanism",
    id = type === "moment_analysis" ? `moment-${facts.match.id}` : (facts.id || `match-${facts.match.id}`),
  } = {},
) {
  return createCandidate({
    id,
    type,
    sport: String(facts.sport || "football").toLowerCase(),
    angle,
    entityRefs: [
      authorisedSourceEntityId(facts.match.homeTeamId),
      authorisedSourceEntityId(facts.match.awayTeamId),
      ...[...new Set((facts.focusPeople || []).filter((person) => person?.name).map((person) => focusPersonEntityId(person)))],
    ],
    eventRefs: [authorisedSourceEventId(facts.match.id)],
  });
}

export function countsTowardDailyDraftLimit(result) {
  return ["draft", "dry-run"].includes(result?.kind);
}

export function stopsDailyRunForAccessControl(result) {
  return result?.kind === "no_evidence"
    && Array.isArray(result?.collectionErrors)
    && result.collectionErrors.some((error) => error?.code === "ACCESS_CONTROL_REQUIRED");
}
