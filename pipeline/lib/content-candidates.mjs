import { createHash } from "node:crypto";

function key(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

export function claimSignature(claims = []) {
  const canonical = claims.map((claim) => ({
    kind: claim.kind,
    subject: key(claim.subjectId),
    predicate: key(claim.predicate),
    factRefs: [...(claim.factRefs || [])].sort(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function createCandidate({ type, sport = "football", angle, entityRefs = [], eventRefs = [], claims = [], ...rest }) {
  if (!type || !angle) throw new Error("Candidate type and angle are required");
  const sortedEvents = [...new Set(eventRefs.map(String))].sort();
  const sortedEntities = [...new Set(entityRefs.map(String))].sort();
  return {
    ...rest,
    type,
    sport,
    primaryIntentKey: key([sport, type, ...sortedEvents, ...sortedEntities].join("-")),
    angleKey: key(angle),
    entityRefs: sortedEntities,
    eventRefs: sortedEvents,
    claimSignature: claimSignature(claims),
  };
}

export function partitionCandidates(candidates, existingItems = []) {
  const identities = new Set(existingItems.map((item) => `${item.primaryIntentKey}:${item.angleKey}`));
  const seen = new Set();
  const create = [];
  const update = [];
  for (const candidate of candidates) {
    const identity = `${candidate.primaryIntentKey}:${candidate.angleKey}`;
    if (identities.has(identity) || seen.has(identity)) update.push(candidate);
    else {
      seen.add(identity);
      create.push(candidate);
    }
  }
  return { create, update };
}
