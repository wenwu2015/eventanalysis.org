import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function internalId(kind, value) {
  return `${kind}_${createHash("sha256").update(String(value)).digest("hex").slice(0, 20)}`;
}

export function authorisedSourceEntityId(value) {
  return internalId("team", `authorised-source:${value}`);
}

export function authorisedSourceEventId(value) {
  return internalId("event", `authorised-source:${value}`);
}

export function authorisedSourcePersonId(value) {
  return internalId("person", `authorised-source:${value}`);
}

function focusPersonIdentity(person = {}) {
  return person.sourcePlayerId || `${person.teamId || "unknown-team"}:${String(person.name || "").trim().toLowerCase()}`;
}

export function focusPersonEntityId(person = {}) {
  return authorisedSourcePersonId(focusPersonIdentity(person));
}

function mergeRecords(current, incoming) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function upsertPacket(path, incoming, schemaVersion = 3) {
  let packet = { schemaVersion, records: [] };
  try { packet = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  packet.schemaVersion = schemaVersion;
  packet.records = mergeRecords(packet.records || [], incoming);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
}

export function materializeFactBundle(bundle) {
  const match = bundle.match;
  const homeId = authorisedSourceEntityId(match.homeTeamId);
  const awayId = authorisedSourceEntityId(match.awayTeamId);
  const eventId = authorisedSourceEventId(match.id);
  const finalFactId = `${eventId}_final_result`;
  const h2hFactId = `${eventId}_head_to_head_before_match`;
  const personnelFactId = `${eventId}_personnel_changes`;
  const keyEventsFactId = `${eventId}_key_events`;
  const focusPeople = [...new Map((bundle.focusPeople || [])
    .filter((person) => person?.name)
    .map((person) => [focusPersonEntityId(person), person]))
    .entries()]
    .map(([id, person]) => ({
      id,
      kind: "Person",
      sport: bundle.sport,
      names: { zh: person.name },
      aliases: [person.name],
      attributes: {
        teamId: person.teamId || null,
        sourcePlayerId: person.sourcePlayerId || null,
        focusReason: person.reason || null,
      },
    }));
  const entities = [
    { id: homeId, kind: "Team", sport: bundle.sport, names: { zh: match.homeTeam }, aliases: [match.homeTeam], attributes: { jurisdiction: match.homeJurisdiction || null } },
    { id: awayId, kind: "Team", sport: bundle.sport, names: { zh: match.awayTeam }, aliases: [match.awayTeam], attributes: { jurisdiction: match.awayJurisdiction || null } },
    ...focusPeople,
  ];
  const events = [{
    id: eventId,
    sport: bundle.sport,
    kind: "match",
    competitionName: match.competition,
    startedAt: match.startedAt,
    status: "finished",
    entityRefs: [homeId, awayId],
    homeTeamId: homeId,
    awayTeamId: awayId,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
  }];
  const base = { status: "confirmed", validFrom: bundle.collectedAt, evidenceRefs: bundle.evidenceRefs };
  const facts = [
    { ...base, id: finalFactId, subjectId: eventId, predicate: "final_result", value: { homeScore: match.homeScore, awayScore: match.awayScore, result: match.result } },
    { ...base, id: h2hFactId, subjectId: eventId, predicate: "head_to_head_before_match", value: bundle.headToHeadBeforeMatch },
    { ...base, id: personnelFactId, subjectId: eventId, predicate: "personnel_changes", value: bundle.personnelChanges },
  ];
  if (bundle.keyEvents?.length) facts.push({ ...base, id: keyEventsFactId, subjectId: eventId, predicate: "key_events", value: bundle.keyEvents });
  return {
    entities,
    events,
    facts,
    references: {
      eventRefs: [eventId],
      entityRefs: [homeId, awayId, ...focusPeople.map(({ id }) => id)],
      requiredFactRefs: [finalFactId, h2hFactId, personnelFactId],
      optionalFactRefs: bundle.keyEvents?.length ? [keyEventsFactId] : [],
    },
  };
}

export async function persistMaterializedBundle(root, materialized) {
  await Promise.all([
    upsertPacket(resolve(root, "content/data/entities/postmatch-generated.json"), materialized.entities),
    upsertPacket(resolve(root, "content/data/events/postmatch-generated.json"), materialized.events),
    upsertPacket(resolve(root, "content/data/facts/postmatch-generated.json"), materialized.facts),
  ]);
}
