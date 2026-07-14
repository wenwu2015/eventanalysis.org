import { createHash } from "node:crypto";

function token(value) {
  return createHash("sha256").update(`eventanalysis.org:world-cup-2026:${value}`).digest("hex").slice(0, 16);
}

function publicId(value) {
  const prefixes = [
    ["team_wc2026_", "team_world_cup_2026_"],
    ["person_wc2026_", "person_world_cup_2026_"],
    ["place_wc2026_", "place_world_cup_2026_"],
    ["event_wc2026_", "event_world_cup_2026_"],
    ["fact_wc2026_", "fact_world_cup_2026_"],
    ["content_wc2026_", "content_world_cup_2026_"],
    ["claim_player_", "claim_world_cup_2026_"],
    ["claim_", "claim_world_cup_2026_"],
  ];
  const match = prefixes.find(([prefix]) => value.startsWith(prefix));
  return match ? `${match[1]}${token(value)}` : value;
}

function rewrite(value, mapping) {
  if (typeof value === "string") return mapping.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, mapping));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, mapping)]));
}

export function privatizeWorldCupIds(content) {
  const packets = [content.entities, content.events, content.facts, content.items];
  const mapping = new Map();
  const playerMapping = new Map();
  const itemTokens = new Map();
  for (const packet of packets) for (const record of packet.records || []) {
    if (record.id) mapping.set(record.id, publicId(record.id));
    if (record.id?.startsWith("content_wc2026_")) itemTokens.set(publicId(record.id), token(record.id));
    for (const claim of record.claims || []) if (claim.id) mapping.set(claim.id, publicId(claim.id));
  }
  for (const entity of content.entities.records || []) {
    if (entity.kind === "Person" && entity.attributes?.sourcePlayerId) {
      playerMapping.set(String(entity.attributes.sourcePlayerId), mapping.get(entity.id) || publicId(entity.id));
    }
  }
  const rewritten = {
    ...content,
    entities: rewrite(content.entities, mapping),
    events: rewrite(content.events, mapping),
    facts: rewrite(content.facts, mapping),
    items: rewrite(content.items, mapping),
  };
  for (const entity of rewritten.entities.records || []) {
    if (entity.attributes) delete entity.attributes.sourcePlayerId;
  }
  for (const fact of rewritten.facts.records || []) if (fact.predicate === "starting_lineup_continuity") {
    for (const side of ["home", "away"]) for (const key of ["starters", "incoming", "outgoing"]) {
      fact.value[side][key] = (fact.value[side][key] || []).map((id) => playerMapping.get(String(id))).filter(Boolean);
    }
  }
  for (const item of rewritten.items.records || []) {
    const itemToken = itemTokens.get(item.id) || token(item.id);
    if (/^world-cup-2026-(?:match|player)-/.test(item.primaryIntentKey)) {
      item.primaryIntentKey = `world-cup-2026-${item.type.replaceAll("_", "-")}-${itemToken}`;
    }
    if (item.type === "person_profile") for (const edition of Object.values(item.editions || {})) {
      edition.slug = `${edition.slug}-${itemToken.slice(0, 8)}`;
    }
  }
  return rewritten;
}

