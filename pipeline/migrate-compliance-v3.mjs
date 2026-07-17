#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareChineseMaster, prepareDerivedEdition } from "./lib/compliance.mjs";

const root = resolve(import.meta.dirname, "..");
const teamCountries = new Map(Object.entries({
  Mexico: "MX", "South Africa": "ZA", "South Korea": "KR", Czechia: "CZ", Canada: "CA",
  "Bosnia & Herzegovina": "BA", USA: "US", Paraguay: "PY", Qatar: "QA", Switzerland: "CH",
  Brazil: "BR", Morocco: "MA", Haiti: "HT", Scotland: "GB", Australia: "AU", "Türkiye": "TR",
  Germany: "DE", "Curaçao": "CW", Netherlands: "NL", Japan: "JP", "Côte d'Ivoire": "CI",
  Ecuador: "EC", Sweden: "SE", Tunisia: "TN", Spain: "ES", "Cabo Verde": "CV", Belgium: "BE",
  Egypt: "EG", "Saudi Arabia": "SA", Uruguay: "UY", Iran: "IR", "New Zealand": "NZ", France: "FR",
  Senegal: "SN", Iraq: "IQ", Norway: "NO", Argentina: "AR", Algeria: "DZ", Austria: "AT", Jordan: "JO",
  Portugal: "PT", "DR Congo": "CD", England: "GB", Croatia: "HR", Ghana: "GH", Panama: "PA",
  Uzbekistan: "UZ", Colombia: "CO",
}));
const venueCountries = new Map(Object.entries({
  "Estadio Azteca": "MX", "Estadio Akron": "MX", "Estadio BBVA": "MX", "BMO Field": "CA", "BC Place": "CA",
  "SoFi Stadium": "US", "Levi's Stadium": "US", "MetLife Stadium": "US", "Gillette Stadium": "US",
  "NRG Stadium": "US", "AT&T Stadium": "US", "Lincoln Financial Field": "US", "Mercedes-Benz Stadium": "US",
  "Lumen Field": "US", "Hard Rock Stadium": "US", "Arrowhead Stadium": "US", "Olympiastadion Berlin": "DE",
}));

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function jsonFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().map((name) => resolve(directory, name));
}

const entityFiles = await jsonFiles(resolve(root, "content/data/entities"));
const entities = [];
for (const path of entityFiles) {
  const packet = await json(path);
  packet.schemaVersion = 3;
  for (const entity of packet.records || [packet]) {
    entity.schemaVersion ||= 3;
    entity.attributes ||= {};
    if (entity.kind === "Team") {
      const country = teamCountries.get(entity.canonicalName);
      if (country) entity.attributes.countryCode = country;
    }
    if (entity.kind === "Place") {
      const country = venueCountries.get(entity.canonicalName);
      if (country) entity.attributes.countryCode = country;
    }
    if (entity.kind === "Competition") entity.attributes.organizerJurisdiction ||= "CH";
    entities.push(entity);
  }
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
}

const corePath = resolve(root, "content/data/entities/football-core.json");
const core = await json(corePath);
for (const entity of core.records) {
  entity.attributes ||= {};
  if (entity.id === "team_spain_men") entity.attributes.countryCode = "ES";
  if (entity.id === "team_england_men") entity.attributes.countryCode = "GB";
  if (entity.id === "competition_uefa_euro_2024") entity.attributes.organizerJurisdiction = "CH";
  if (entity.id === "place_olympiastadion_berlin") entity.attributes.countryCode = "DE";
}
await writeFile(corePath, `${JSON.stringify(core, null, 2)}\n`);

const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
const eventPackets = [];
for (const path of await jsonFiles(resolve(root, "content/data/events"))) {
  const packet = await json(path);
  packet.schemaVersion = 3;
  eventPackets.push(...(packet.records || [packet]));
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
}
const eventMap = new Map(eventPackets.map((event) => [event.id, event]));
for (const path of await jsonFiles(resolve(root, "content/data/facts"))) {
  const packet = await json(path);
  packet.schemaVersion = 3;
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
}

function addEntityJurisdiction(result, entity) {
  if (!entity) return;
  if (entity.attributes?.countryCode) result.add(entity.attributes.countryCode);
  if (entity.attributes?.organizerJurisdiction) result.add(entity.attributes.organizerJurisdiction);
  for (const relation of entity.relations || []) addEntityJurisdiction(result, entityMap.get(relation.targetId));
}

function nexusForItem(item) {
  const result = new Set();
  for (const id of item.entityRefs || []) addEntityJurisdiction(result, entityMap.get(id));
  for (const id of item.eventRefs || []) {
    const event = eventMap.get(id);
    if (!event) continue;
    for (const entityId of [event.homeTeamId, event.awayTeamId, event.competitionId, event.placeId]) addEntityJurisdiction(result, entityMap.get(entityId));
  }
  return [...result].sort();
}

let migrated = 0;
for (const path of await jsonFiles(resolve(root, "content/data/items"))) {
  const packet = await json(path);
  packet.schemaVersion = 3;
  for (const item of packet.records || [packet]) {
    item.schemaVersion = 3;
    item.nexusJurisdictions = nexusForItem(item);
    prepareChineseMaster(item, { quarantine: true });
    item.editions.zh.status = "quarantined";
    item.editions.zh.complianceStatus = "quarantined";
    delete item.editions.zh.allowedJurisdictions;
    delete item.editions.zh.complianceValidUntil;
    for (const locale of Object.keys(item.editions)) if (locale !== "zh") {
      const edition = prepareDerivedEdition(item, locale, { current: false, agentVersion: "legacy-migration-2026-07-15" });
      edition.status = "quarantined";
      edition.complianceStatus = "quarantined";
      delete edition.allowedJurisdictions;
      delete edition.complianceValidUntil;
    }
    migrated += 1;
  }
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
}

console.log(JSON.stringify({ schemaVersion: 3, migrated, publicationState: "quarantined" }, null, 2));
