import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCandidate } from "./content-candidates.mjs";
import { focusPersonEntityId, authorisedSourceEntityId, authorisedSourceEventId } from "./fact-materializer.mjs";

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
  return normalizeName(value).toLowerCase();
}

function slugToken(value) {
  return normalizeToken(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "person";
}

function focusReasonWeight(reason) {
  return ({
    goal: 5,
    penalty_goal: 5,
    assist: 4,
    substitution: 3,
    lineup_change: 2,
  })[reason] || 1;
}

function personEntry({ name, teamId = null, sourcePlayerId = null, reason = "mention", score = 1 }) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return { name: normalized, teamId, sourcePlayerId, reason, score };
}

function addPerson(map, person) {
  if (!person) return;
  const key = `${person.teamId || "unknown-team"}:${normalizeToken(person.name)}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, person);
    return;
  }
  map.set(key, {
    ...existing,
    ...person,
    sourcePlayerId: existing.sourcePlayerId || person.sourcePlayerId || null,
    score: Math.max(existing.score || 0, person.score || 0),
  });
}

function extractDescriptionPeople(entry) {
  const description = String(entry?.description || "");
  const eventType = String(entry?.eventType || "").toLowerCase();
  const teamId = entry?.teamId ? String(entry.teamId) : null;
  const people = [];
  const primary = description.match(/^([^()]+?)\s+\(/);
  if (/goal/.test(eventType) && primary) people.push(personEntry({ name: primary[1], teamId, reason: eventType.includes("penalty") ? "penalty_goal" : "goal", score: focusReasonWeight(eventType.includes("penalty") ? "penalty_goal" : "goal") }));
  if (eventType === "assist") {
    const assist = description.match(/^Assisted by\s+(.+?)\.$/i);
    if (assist) people.push(personEntry({ name: assist[1], teamId, reason: "assist", score: focusReasonWeight("assist") }));
  }
  if (eventType === "substitution") {
    const incoming = description.match(/^(.+?)\s+\(in\)/);
    const outgoing = description.match(/replace\s+(.+?)\s+\(out\)/i);
    if (incoming) people.push(personEntry({ name: incoming[1], teamId, reason: "substitution", score: focusReasonWeight("substitution") }));
    if (outgoing) people.push(personEntry({ name: outgoing[1], teamId, reason: "substitution", score: focusReasonWeight("substitution") }));
  }
  return people.filter(Boolean);
}

export function extractFocusPeople(personnelChanges = [], keyEvents = [], limit = 4) {
  const people = new Map();
  for (const team of personnelChanges || []) {
    for (const player of team.incomingPlayers || []) addPerson(people, personEntry({
      name: player.name,
      teamId: String(team.teamId || ""),
      sourcePlayerId: player.id ? String(player.id) : null,
      reason: "lineup_change",
      score: focusReasonWeight("lineup_change"),
    }));
    for (const player of team.outgoingPlayers || []) addPerson(people, personEntry({
      name: player.name,
      teamId: String(team.teamId || ""),
      sourcePlayerId: player.id ? String(player.id) : null,
      reason: "lineup_change",
      score: focusReasonWeight("lineup_change"),
    }));
  }
  for (const event of keyEvents || []) for (const person of extractDescriptionPeople(event)) addPerson(people, person);
  return [...people.values()]
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function existingEventPersonPairs(items = []) {
  const pairs = new Set();
  for (const item of items) {
    if (item.type !== "match_analysis" || !Array.isArray(item.eventRefs) || item.eventRefs.length !== 1) continue;
    for (const entityId of item.entityRefs || []) {
      if (!String(entityId).startsWith("person_")) continue;
      pairs.add(`${item.eventRefs[0]}:${entityId}`);
    }
  }
  return pairs;
}

function eventFacts(facts = [], eventId) {
  const byPredicate = new Map();
  for (const fact of facts) if (fact.subjectId === eventId) byPredicate.set(fact.predicate, fact);
  return byPredicate;
}

function matchBundle({ event, entitiesById, factsByPredicate, now }) {
  const finalResult = factsByPredicate.get("final_result");
  const headToHead = factsByPredicate.get("head_to_head_before_match");
  const personnelChanges = factsByPredicate.get("personnel_changes");
  if (!finalResult || !headToHead || !personnelChanges) return null;
  const home = entitiesById.get(event.homeTeamId);
  const away = entitiesById.get(event.awayTeamId);
  if (!home || !away) return null;
  const keyEvents = factsByPredicate.get("key_events");
  return {
    schemaVersion: 1,
    id: `historical-${event.id}`,
    sport: "football",
    collectedAt: now.toISOString(),
    status: "needs_review",
    match: {
      id: event.id,
      competition: event.competitionName || "Historical match",
      startedAt: event.startedAt,
      homeTeamId: event.homeTeamId,
      awayTeamId: event.awayTeamId,
      homeTeam: home.names?.zh || home.aliases?.[0] || home.id,
      awayTeam: away.names?.zh || away.aliases?.[0] || away.id,
      homeJurisdiction: home.attributes?.jurisdiction || null,
      awayJurisdiction: away.attributes?.jurisdiction || null,
      homeScore: finalResult.value?.homeScore ?? event.homeScore,
      awayScore: finalResult.value?.awayScore ?? event.awayScore,
      result: finalResult.value?.result || null,
    },
    headToHeadBeforeMatch: headToHead.value,
    personnelChanges: personnelChanges.value || [],
    keyEvents: keyEvents?.value || [],
    videoObservations: [],
    coreSourceConfirmations: null,
    evidenceRefs: [...new Set([
      ...(finalResult.evidenceRefs || []),
      ...(headToHead.evidenceRefs || []),
      ...(personnelChanges.evidenceRefs || []),
      ...(keyEvents?.evidenceRefs || []),
    ])],
    missing: [],
  };
}

export function buildHistoricalFallbackPlan(data, {
  now = new Date(),
  lookbackDays = 365,
  maxCandidates = 20,
} = {}) {
  const cutoff = now.getTime() - lookbackDays * 24 * 3_600_000;
  const entitiesById = new Map(data.entities.map((entity) => [entity.id, entity]));
  const existingPairs = existingEventPersonPairs(data.items);
  const plan = [];
  for (const event of data.events) {
    if (!event.startedAt || Date.parse(event.startedAt) < cutoff || Date.parse(event.startedAt) > now.getTime()) continue;
    const factsByPredicate = eventFacts(data.facts, event.id);
    const bundle = matchBundle({ event, entitiesById, factsByPredicate, now });
    if (!bundle) continue;
    const focusPeople = extractFocusPeople(bundle.personnelChanges, bundle.keyEvents);
    for (const person of focusPeople) {
      const personEntityId = focusPersonEntityId(person);
      const pairKey = `${event.id}:${personEntityId}`;
      if (existingPairs.has(pairKey)) continue;
      const facts = {
        ...bundle,
        id: `historical-${event.id}-${slugToken(person.name)}`,
        focusPeople: [person],
      };
      const candidate = createCandidate({
        id: event.id,
        type: "match_analysis",
        sport: "football",
        angle: `historical-person-focus-${slugToken(person.name)}`,
        entityRefs: [
          authorisedSourceEntityId(bundle.match.homeTeamId),
          authorisedSourceEntityId(bundle.match.awayTeamId),
          personEntityId,
        ],
        eventRefs: [authorisedSourceEventId(bundle.match.id)],
      });
      plan.push({
        eventId: event.id,
        startedAt: event.startedAt,
        competition: bundle.match.competition,
        focusPerson: person,
        pairKey,
        candidate,
        facts,
      });
      existingPairs.add(pairKey);
    }
  }
  return plan
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.focusPerson.score - left.focusPerson.score || left.focusPerson.name.localeCompare(right.focusPerson.name))
    .slice(0, maxCandidates);
}

export async function writeHistoricalFallbackPlan(root, plan, now = new Date()) {
  const output = resolve(root, "pipeline/runtime/historical-fallback-plan.json");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    generatedAt: now.toISOString(),
    candidates: plan.map(({ eventId, startedAt, competition, focusPerson, pairKey, candidate }) => ({
      eventId,
      startedAt,
      competition,
      focusPerson,
      pairKey,
      primaryIntentKey: candidate.primaryIntentKey,
      angleKey: candidate.angleKey,
    })),
  }, null, 2)}\n`);
  return output;
}
