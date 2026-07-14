import { collectBrowserPage } from "../lib/browser-collector.mjs";

function readPath(value, path) {
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item, visit, seen);
}

function normalizeText(value) {
  return String(value || "").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

function applyMapping(candidate, mapping) {
  const event = {};
  for (const [field, path] of Object.entries(mapping)) event[field] = readPath(candidate, path);
  if (!event.homeTeam || !event.awayTeam) return null;
  event.id = String(event.id || `${event.homeTeam}-${event.awayTeam}-${event.startedAt || ""}`);
  event.homeScore = Number(event.homeScore);
  event.awayScore = Number(event.awayScore);
  event.homeTeamId = String(event.homeTeamId || event.homeTeam);
  event.awayTeamId = String(event.awayTeamId || event.awayTeam);
  event.status = String(event.status || "finished").toLowerCase();
  if (!Number.isFinite(event.homeScore) || !Number.isFinite(event.awayScore)) return null;
  return event;
}

export function extractMappedEvents(responseBodies, mapping) {
  const result = new Map();
  for (const body of responseBodies) {
    let parsed;
    try { parsed = typeof body === "string" ? JSON.parse(body) : body; } catch { continue; }
    walk(parsed, (candidate) => {
      const event = applyMapping(candidate, mapping);
      if (event) result.set(event.id, event);
    });
  }
  return [...result.values()];
}

function templateUrl(template, event) {
  const values = {
    eventId: event.id,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    date: new Date(event.startTimestamp * 1000).toISOString().slice(0, 10),
  };
  return template.replace(/\{(eventId|homeTeam|awayTeam|date)\}/g, (_, key) => encodeURIComponent(values[key]));
}

export async function collectGenericMatchEvidence({ source, event, job, timeoutMs }) {
  if (!source.matchUrlTemplate || !source.eventMapping) return null;
  const url = templateUrl(source.matchUrlTemplate, event);
  const result = await collectBrowserPage({ source, url, job, timeoutMs });
  const mapped = extractMappedEvents(result.responses.map((response) => response.body), source.eventMapping);
  const expectedHome = normalizeText(event.homeTeam);
  const expectedAway = normalizeText(event.awayTeam);
  const confirmed = mapped.find((item) =>
    normalizeText(item.homeTeam) === expectedHome
    && normalizeText(item.awayTeam) === expectedAway
    && item.homeScore === event.homeScore
    && item.awayScore === event.awayScore
  );
  if (!confirmed) return null;
  return {
    sourceId: source.id,
    originalUrl: url,
    event: { ...event, ...confirmed },
    h2hEvents: mapped,
    capturedResponseCount: result.responses.length,
  };
}
