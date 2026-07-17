import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { COMPLIANCE_STATUSES, RISK_CLASSES, sourceEditionHash } from "./compliance.mjs";

const CONTENT_TYPES = new Set([
  "match_analysis", "moment_analysis", "person_profile", "person_comparison",
  "team_profile", "competition_story", "place_story", "topic_story", "roundup",
]);
const STATUSES = new Set(["draft", "needs_review", "data_incomplete", "approved", "published", "quarantined", "withdrawn"]);
const FACT_STATUSES = new Set(["observed", "confirmed", "conflicted", "superseded"]);
const CLAIM_KINDS = new Set(["fact", "calculation", "analysis"]);
const ENTITY_KINDS = new Set(["Person", "Team", "Competition", "Season", "Place", "Topic"]);
const ROUTE_KEY_BY_TYPE = {
  match_analysis: "match-analysis",
  moment_analysis: "moments",
  person_profile: "people",
  person_comparison: "comparisons",
  team_profile: "teams",
  competition_story: "competitions",
  place_story: "places",
  topic_story: "topics",
  roundup: "roundups",
};

function fail(message) {
  throw new Error(`Content data validation failed: ${message}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonDirectory(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".json")) result.push(await readJson(resolve(path, entry.name)));
  }
  return result;
}

export function normalizeSlug(value) {
  const slug = String(value || "")
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) fail("slug is empty after normalization");
  if ([...slug].length > 100) fail(`slug is longer than 100 characters: ${slug}`);
  return slug;
}

export function routeKeyForType(type) {
  const key = ROUTE_KEY_BY_TYPE[type];
  if (!key) fail(`no route key for content type ${type}`);
  return key;
}

export function routePath({ locale, sport, routeKey, slug, routes }) {
  const section = routes.locales?.[locale]?.[routeKey];
  if (!section) fail(`missing localized route ${locale}.${routeKey}`);
  const parts = [locale, sport, normalizeSlug(section)];
  if (slug) parts.push(normalizeSlug(slug));
  return `/${parts.join("/")}/`;
}

export function absoluteUrl(path, baseUrl = "https://eventanalysis.org") {
  return `${baseUrl}${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function uniqueIds(records, label, globalIds) {
  for (const record of records) {
    if (!record?.id || typeof record.id !== "string") fail(`${label} record is missing an id`);
    if (globalIds.has(record.id)) fail(`duplicate id ${record.id}`);
    globalIds.add(record.id);
  }
}

function validTimeRange(record, label) {
  if (record.validFrom && Number.isNaN(Date.parse(record.validFrom))) fail(`${label} has invalid validFrom`);
  if (record.validTo && Number.isNaN(Date.parse(record.validTo))) fail(`${label} has invalid validTo`);
  if (record.validFrom && record.validTo && new Date(record.validFrom) > new Date(record.validTo)) {
    fail(`${label} has validFrom after validTo`);
  }
}

export async function loadContentData(root) {
  const dataRoot = resolve(root, "content/data");
  const [schema, routes, entities, events, facts, items] = await Promise.all([
    readJson(resolve(dataRoot, "schema.json")),
    readJson(resolve(dataRoot, "routes.json")),
    readJsonDirectory(resolve(dataRoot, "entities")),
    readJsonDirectory(resolve(dataRoot, "events")),
    readJsonDirectory(resolve(dataRoot, "facts")),
    readJsonDirectory(resolve(dataRoot, "items")),
  ]);
  const flatItems = items.flatMap((value) => value.records || [value]);
  if (process.env.EA_CONTENT_REVISION_FILE) {
    const override = await readJson(resolve(process.env.EA_CONTENT_REVISION_FILE));
    const index = flatItems.findIndex(({ id }) => id === override.id);
    if (index === -1) flatItems.push(override);
    else flatItems[index] = override;
  }
  return {
    schema,
    routes,
    entities: entities.flatMap((value) => value.records || [value]),
    events: events.flatMap((value) => value.records || [value]),
    facts: facts.flatMap((value) => value.records || [value]),
    items: flatItems,
  };
}

export async function validateContentData(root, { requirePrivateEvidence = false } = {}) {
  const data = await loadContentData(root);
  if (data.schema.schemaVersion !== 3 || data.routes.schemaVersion !== 2) fail("content schema must be 3 and route schema must be 2");
  const localeFile = await readJson(resolve(root, "content/locales.json"));
  const sportFile = await readJson(resolve(root, "content/sports.json"));
  const locales = new Set(localeFile.map(({ code }) => code));
  const sports = new Set(sportFile.map(({ code }) => code));
  for (const locale of locales) {
    const dictionary = data.routes.locales?.[locale];
    if (!dictionary) fail(`missing route dictionary for ${locale}`);
    for (const routeKey of [...new Set([...Object.values(ROUTE_KEY_BY_TYPE), "all-content", "search"])]) {
      if (typeof dictionary[routeKey] !== "string" || !dictionary[routeKey].trim()) fail(`missing route segment ${locale}.${routeKey}`);
      normalizeSlug(dictionary[routeKey]);
    }
  }
  const globalIds = new Set();
  uniqueIds(data.entities, "entity", globalIds);
  uniqueIds(data.events, "event", globalIds);
  uniqueIds(data.facts, "fact", globalIds);
  uniqueIds(data.items, "content item", globalIds);
  const entityIds = new Set(data.entities.map(({ id }) => id));
  const eventIds = new Set(data.events.map(({ id }) => id));
  const factIds = new Set(data.facts.map(({ id }) => id));
  const evidenceIds = new Set();
  if (requirePrivateEvidence) {
    const privateRecords = await readJsonDirectory(resolve(root, "private-evidence"));
    for (const packet of privateRecords) for (const record of packet.records || []) {
      if (!record.id || evidenceIds.has(record.id)) fail(`duplicate or missing private evidence id ${record.id || "unknown"}`);
      if (!record.sourceId || !record.rightsSnapshotId || !record.capturedAt || !record.parserVersion || !record.rawHash) fail(`private evidence ${record.id} is incomplete`);
      if (Number.isNaN(Date.parse(record.capturedAt))) fail(`private evidence ${record.id} has invalid capturedAt`);
      if (!["https:", "http:"].includes(new URL(record.url).protocol)) fail(`private evidence ${record.id} has invalid URL`);
      evidenceIds.add(record.id);
    }
  }

  for (const entity of data.entities) {
    if (!ENTITY_KINDS.has(entity.kind)) fail(`entity ${entity.id} has invalid kind ${entity.kind}`);
    if (!sports.has(entity.sport)) fail(`entity ${entity.id} has unknown sport ${entity.sport}`);
    for (const relation of entity.relations || []) {
      validTimeRange(relation, `${entity.id} relation`);
      if (!entityIds.has(relation.targetId)) fail(`${entity.id} references unknown entity ${relation.targetId}`);
    }
  }
  for (const event of data.events) {
    if (!sports.has(event.sport)) fail(`event ${event.id} has unknown sport ${event.sport}`);
    if (Number.isNaN(Date.parse(event.startedAt))) fail(`event ${event.id} has invalid startedAt`);
    for (const id of event.entityRefs || []) if (!entityIds.has(id)) fail(`event ${event.id} references unknown entity ${id}`);
    for (const id of [event.competitionId, event.placeId, event.homeTeamId, event.awayTeamId].filter(Boolean)) if (!entityIds.has(id)) fail(`event ${event.id} references unknown entity ${id}`);
  }
  for (const fact of data.facts) {
    if (!FACT_STATUSES.has(fact.status)) fail(`fact ${fact.id} has invalid status`);
    if (!entityIds.has(fact.subjectId) && !eventIds.has(fact.subjectId)) fail(`fact ${fact.id} has unknown subject ${fact.subjectId}`);
    validTimeRange(fact, fact.id);
    if (!Array.isArray(fact.evidenceRefs) || fact.evidenceRefs.length === 0) fail(`fact ${fact.id} has no evidenceRefs`);
    if (requirePrivateEvidence) for (const ref of fact.evidenceRefs) if (!evidenceIds.has(ref)) fail(`fact ${fact.id} references missing private evidence ${ref}`);
  }

  const routeCollisions = new Map();
  const intentKeys = new Map();
  for (const item of data.items) {
    if (!CONTENT_TYPES.has(item.type)) fail(`item ${item.id} has invalid type ${item.type}`);
    if (!sports.has(item.sport)) fail(`item ${item.id} has unknown sport ${item.sport}`);
    if (!item.primaryIntentKey || !item.angleKey || !item.originalContribution) fail(`item ${item.id} is missing editorial identity fields`);
    if (item.sourceLocale !== "zh" || !item.editions?.zh) fail(`item ${item.id} must use a Chinese source edition`);
    if (Number(item.sourceRevision) !== Number(item.revision)) fail(`item ${item.id} source revision does not match item revision`);
    if (!/^[a-f0-9]{64}$/i.test(item.sourceEditionHash || "") || item.sourceEditionHash !== sourceEditionHash(item.editions.zh)) fail(`item ${item.id} source edition hash is invalid`);
    if (!RISK_CLASSES.has(item.riskClass)) fail(`item ${item.id} has invalid risk class`);
    if (!Array.isArray(item.nexusJurisdictions) || item.nexusJurisdictions.some((code) => !/^[A-Z]{2}$/.test(code))) fail(`item ${item.id} has invalid nexus jurisdictions`);
    for (const id of item.entityRefs || []) if (!entityIds.has(id)) fail(`item ${item.id} references unknown entity ${id}`);
    for (const id of item.eventRefs || []) if (!eventIds.has(id)) fail(`item ${item.id} references unknown event ${id}`);
    const claimIds = new Set();
    for (const claim of item.claims || []) {
      if (!claim.id || claimIds.has(claim.id)) fail(`item ${item.id} has duplicate or missing claim id`);
      claimIds.add(claim.id);
      if (!CLAIM_KINDS.has(claim.kind)) fail(`item ${item.id} claim ${claim.id} has invalid kind`);
      for (const ref of claim.factRefs || []) if (!factIds.has(ref)) fail(`claim ${claim.id} references unknown fact ${ref}`);
      if (!claim.factRefs || claim.factRefs.length === 0) fail(`claim ${claim.id} has no fact reference`);
    }
    for (const [locale, edition] of Object.entries(item.editions || {})) {
      if (!locales.has(locale)) fail(`item ${item.id} has unknown locale ${locale}`);
      if (!STATUSES.has(edition.status)) fail(`item ${item.id}/${locale} has invalid status`);
      if (!COMPLIANCE_STATUSES.has(edition.complianceStatus)) fail(`item ${item.id}/${locale} has invalid compliance status`);
      if (normalizeSlug(edition.slug) !== edition.slug) fail(`item ${item.id}/${locale} slug is not canonical`);
      if (!edition.title || !edition.deck || !Array.isArray(edition.sections)) fail(`item ${item.id}/${locale} is incomplete`);
      if (!edition.sections.length) fail(`item ${item.id}/${locale} has no sections`);
      for (const section of edition.sections) for (const paragraph of section.paragraphs || []) {
        if (!paragraph.id) fail(`item ${item.id}/${locale} contains a paragraph without an id`);
        if (!paragraph.text?.trim()) fail(`item ${item.id}/${locale} contains an empty paragraph`);
        if (!Array.isArray(paragraph.claimRefs) || paragraph.claimRefs.length === 0) fail(`item ${item.id}/${locale} paragraph has no claim references`);
        for (const ref of paragraph.claimRefs || []) if (!claimIds.has(ref)) fail(`item ${item.id}/${locale} paragraph references unknown claim ${ref}`);
      }
      for (const event of edition.timeline || []) {
        for (const ref of event.claimRefs || []) if (!claimIds.has(ref)) fail(`item ${item.id}/${locale} timeline references unknown claim ${ref}`);
      }
      if (locale !== "zh") {
        if (edition.derivedFromLocale !== "zh") fail(`item ${item.id}/${locale} does not derive from Chinese`);
        if (!new Set(["current", "stale", "blocked"]).has(edition.translationStatus)) fail(`item ${item.id}/${locale} has invalid translation status`);
        if (edition.translationStatus === "current" && (Number(edition.derivedFromRevision) !== Number(item.sourceRevision) || edition.derivedFromHash !== item.sourceEditionHash)) fail(`item ${item.id}/${locale} current translation does not derive from the current Chinese source`);
        if (edition.translationStatus !== "current" && edition.status === "published") fail(`item ${item.id}/${locale} publishes a non-current translation`);
        if (!Array.isArray(edition.paragraphMappings)) fail(`item ${item.id}/${locale} has no paragraph mappings`);
      }
      if (edition.status === "published") {
        if (edition.complianceStatus !== "passed") fail(`item ${item.id}/${locale} is published without passed compliance`);
        if (!edition.complianceValidUntil || Number.isNaN(Date.parse(edition.complianceValidUntil))) fail(`item ${item.id}/${locale} has no compliance lease`);
        if (!Array.isArray(edition.allowedJurisdictions) || edition.allowedJurisdictions.length === 0) fail(`item ${item.id}/${locale} has no allowed jurisdictions`);
        if (locale !== "zh" && edition.translationStatus !== "current") fail(`item ${item.id}/${locale} publishes a stale translation`);
        if (!edition.slugFrozenAt || Number.isNaN(Date.parse(edition.slugFrozenAt))) fail(`item ${item.id}/${locale} has no valid slug freeze timestamp`);
        const path = routePath({ locale, sport: item.sport, routeKey: routeKeyForType(item.type), slug: edition.slug, routes: data.routes });
        if (routeCollisions.has(path)) fail(`route collision ${path}`);
        routeCollisions.set(path, item.id);
        const intent = `${locale}:${item.sport}:${item.primaryIntentKey}`;
        if (intentKeys.has(intent)) fail(`published intent collision ${intent}`);
        intentKeys.set(intent, item.id);
      }
    }
  }
  return { ...data, routeCollisions };
}

export async function buildContentIndex(root, outputPath = resolve(root, "pipeline/runtime/content-index.sqlite")) {
  const { DatabaseSync } = await import("node:sqlite");
  const data = await validateContentData(root);
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  const database = new DatabaseSync(outputPath);
  database.exec(`
    PRAGMA journal_mode = DELETE;
    DROP TABLE IF EXISTS entities;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS facts;
    DROP TABLE IF EXISTS content_items;
    DROP TABLE IF EXISTS editions;
    CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sport TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, sport TEXT NOT NULL, started_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE facts (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE content_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, sport TEXT NOT NULL, intent_key TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE editions (content_id TEXT NOT NULL, locale TEXT NOT NULL, status TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY(content_id, locale));
  `);
  const insertEntity = database.prepare("INSERT INTO entities VALUES (?, ?, ?, ?)");
  const insertEvent = database.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
  const insertFact = database.prepare("INSERT INTO facts VALUES (?, ?, ?, ?, ?)");
  const insertItem = database.prepare("INSERT INTO content_items VALUES (?, ?, ?, ?, ?)");
  const insertEdition = database.prepare("INSERT INTO editions VALUES (?, ?, ?, ?, ?)");
  database.exec("BEGIN");
  try {
    for (const value of data.entities) insertEntity.run(value.id, value.kind, value.sport, JSON.stringify(value));
    for (const value of data.events) insertEvent.run(value.id, value.sport, value.startedAt, JSON.stringify(value));
    for (const value of data.facts) insertFact.run(value.id, value.subjectId, value.predicate, value.status, JSON.stringify(value));
    for (const value of data.items) {
      insertItem.run(value.id, value.type, value.sport, value.primaryIntentKey, JSON.stringify(value));
      for (const [locale, edition] of Object.entries(value.editions || {})) insertEdition.run(value.id, locale, edition.status, edition.slug, edition.title);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  await writeFile(`${outputPath}.meta.json`, `${JSON.stringify({ schemaVersion: 2, builtAt: new Date().toISOString(), counts: { entities: data.entities.length, events: data.events.length, facts: data.facts.length, items: data.items.length } }, null, 2)}\n`);
  return outputPath;
}
