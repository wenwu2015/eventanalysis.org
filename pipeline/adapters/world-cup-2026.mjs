import { createHash } from "node:crypto";
import { collectBrowserPage } from "../lib/browser-collector.mjs";
import { extractSofaEvents, sofaEventUrl } from "./sofascore.mjs";

const TOURNAMENT_PATH = "/football/tournament/world/world-championship/16";
const FIFA_SCHEDULE_PATH = "/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateRange(first, last) {
  const dates = [];
  const cursor = new Date(`${first}T12:00:00Z`);
  const end = new Date(`${last}T12:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function finished(event) {
  return ["finished", "afterpenalties", "afterextra"].some((status) => String(event.status || "").includes(status));
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function responsePath(value) {
  try { return new URL(value).pathname; } catch { return ""; }
}

function exactResponse(responses, path) {
  return responses.find((response) => responsePath(response.url) === path)?.data || null;
}

function combinedHash(responses) {
  return sha256(responses.map(({ hash }) => hash).sort().join(":"));
}

async function collectOfficialSchedule({ source, job, timeoutMs }) {
  if (!source) throw new Error("An active authorised FIFA browser source is required for World Cup corroboration");
  const result = await collectBrowserPage({
    source,
    url: `${source.baseUrl}${FIFA_SCHEDULE_PATH}`,
    job,
    timeoutMs,
    interact: async (page) => {
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 8_000)));
      await page.waitForTimeout(800);
    },
  });
  const evidenceId = `evidence_fifa_world_cup_2026_schedule_${result.pageHash.slice(0, 12)}`;
  job.retainEvidence({
    id: evidenceId,
    sourceId: source.id,
    url: `${source.baseUrl}${FIFA_SCHEDULE_PATH}`,
    rightsSnapshotId: source.license?.snapshotId || `${source.id}-current-contract`,
    capturedAt: new Date().toISOString(),
    parserVersion: "fifa-browser-world-cup-v1",
    rawHash: result.pageHash,
    fieldLocations: ["official tournament schedule", "teams", "fixtures", "results"],
    excerpt: result.visibleText.slice(0, 500),
  });
  return { evidenceId, pageHash: result.pageHash, visibleText: result.visibleText };
}

async function createSofaSession({ source, job, timeoutMs }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, executablePath: source.browserExecutablePath || undefined });
  const context = await browser.newContext({
    storageState: source.storageStatePath || undefined,
    locale: source.locale || "en-GB",
    userAgent: source.userAgent || undefined,
  });
  const page = await context.newPage();
  const sourceOrigin = new URL(source.baseUrl).origin;
  const pending = new Set();
  const captured = new Map();
  let generation = 0;
  let lastNavigationAt = 0;

  page.on("response", (response) => {
    const responseGeneration = generation;
    const promise = (async () => {
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== sourceOrigin || !(response.headers()["content-type"] || "").includes("json")) return;
      const path = url.pathname;
      if (!(/\/api\/v1\/event\/\d+(?:$|\/)/.test(path)
        || /\/api\/v1\/unique-tournament\/16\//.test(path)
        || path.startsWith("/api/v1/sport/football/scheduled-events/")
        || path === "/api/v1/world-cup/meet-the-team")) return;
      let body;
      try { body = await response.text(); } catch { return; }
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) return;
      const key = `${responseGeneration}:${url.toString()}`;
      captured.set(key, {
        generation: responseGeneration,
        url: url.toString(),
        status: response.status(),
        hash: sha256(body),
        data: parseJson(body),
      });
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  });

  async function pace() {
    const delay = Math.max(0, Number(source.minimumDelayMs) || 0);
    const wait = lastNavigationAt + delay - Date.now();
    if (wait > 0) await sleep(wait);
    lastNavigationAt = Date.now();
  }

  async function navigate(url, { settleMs = 1_250, requiredPath = null } = {}) {
    const target = new URL(url);
    if (target.origin !== sourceOrigin) throw new Error(`URL origin is outside source boundary: ${target.origin}`);
    generation += 1;
    const currentGeneration = generation;
    await pace();
    job.retainUrl(target.toString());
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!/ERR_(?:CONNECTION_RESET|TIMED_OUT|NETWORK_CHANGED)|Timeout/i.test(String(error)) || attempt === 2) throw error;
        await sleep(1_500 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    if (response && [401, 403, 429].includes(response.status())) {
      const error = new Error(`Provider returned ${response.status()}; use the contracted whitelist or refresh the authorised session.`);
      error.code = "ACCESS_CONTROL_REQUIRED";
      throw error;
    }
    await page.waitForTimeout(settleMs);
    if (requiredPath) {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && ![...captured.values()].some((entry) => entry.generation === currentGeneration && responsePath(entry.url) === requiredPath)) {
        await page.waitForTimeout(250);
      }
      if (![...captured.values()].some((entry) => entry.generation === currentGeneration && responsePath(entry.url) === requiredPath)) {
        throw new Error(`Required browser response was not loaded by the public page: ${requiredPath}`);
      }
    }
    await Promise.allSettled([...pending]);
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    if (/captcha|verify you are human|access denied|unusual traffic/i.test(`${await page.title()}\n${text}`)) {
      const error = new Error("An access-control challenge was detected; no bypass was attempted.");
      error.code = "ACCESS_CONTROL_REQUIRED";
      throw error;
    }
    return {
      text,
      title: await page.title(),
      responses: [...captured.values()].filter((entry) => entry.generation === currentGeneration && entry.data),
    };
  }

  async function close() {
    await context.clearCookies().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { page, navigate, close };
}

function tournamentTeams(responses) {
  const packet = responses.find(({ url }) => responsePath(url) === "/api/v1/world-cup/meet-the-team")?.data;
  const featured = (packet?.groups || []).flatMap(({ group, teams }) => (teams || []).map(({ team }) => ({
    ...team,
    group: group?.groupName || group?.name || null,
  })));
  if (featured.length === 48) return featured;
  const teams = new Map();
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const candidates = [value.team, value.homeTeam, value.awayTeam].filter(Boolean);
    for (const team of candidates) {
      if (team?.id && team?.name && team?.national === true && (team.sport?.slug === "football" || team.sport?.name === "Football")) {
        teams.set(String(team.id), team);
      }
    }
    if (Array.isArray(value)) for (const item of value) walk(item);
    else for (const item of Object.values(value)) walk(item);
  }
  for (const { data } of responses) walk(data);
  return [...teams.values()];
}

function lineupPlayers(lineup, side) {
  const group = lineup?.[side];
  if (!group) return [];
  const available = (group.players || []).map((record) => ({ ...record, availability: "matchday" }));
  const missing = (group.missingPlayers || []).map((record) => ({ ...record, availability: "missing" }));
  return [...available, ...missing];
}

async function collectMatch({ session, source, event, job, onProgress, index, total }) {
  const url = sofaEventUrl(source, event);
  const pageResult = await session.navigate(url, { settleMs: 1_500 });
  const id = event.id;
  const detail = exactResponse(pageResult.responses, `/api/v1/event/${id}`)?.event || null;
  const lineups = exactResponse(pageResult.responses, `/api/v1/event/${id}/lineups`);
  const incidents = exactResponse(pageResult.responses, `/api/v1/event/${id}/incidents`);
  const managers = exactResponse(pageResult.responses, `/api/v1/event/${id}/managers`);
  const bestPlayers = exactResponse(pageResult.responses, `/api/v1/event/${id}/best-players/summary`);
  if (!detail || !lineups || !incidents) throw new Error(`Match ${id} is missing event, lineup or incident evidence`);
  const relevant = pageResult.responses.filter(({ url: responseUrl }) => responsePath(responseUrl).startsWith(`/api/v1/event/${id}`));
  const evidenceId = `evidence_sofascore_wc2026_match_${id}_${combinedHash(relevant).slice(0, 12)}`;
  job.retainEvidence({
    id: evidenceId,
    sourceId: source.id,
    url,
    rightsSnapshotId: source.license?.snapshotId || `${source.id}-current-contract`,
    capturedAt: new Date().toISOString(),
    parserVersion: "sofascore-world-cup-match-v1",
    rawHash: combinedHash(relevant),
    fieldLocations: ["event", "lineups", "incidents", "managers", "best players"],
    excerpt: pageResult.text.slice(0, 500),
  });
  onProgress?.({ phase: "matches", current: index + 1, total, eventId: id, label: `${event.homeTeam} ${event.homeScore}-${event.awayScore} ${event.awayTeam}` });
  return {
    event: { ...event, raw: detail },
    evidenceId,
    lineups,
    incidents,
    managers,
    bestPlayers,
    players: {
      home: lineupPlayers(lineups, "home"),
      away: lineupPlayers(lineups, "away"),
    },
  };
}

export async function collectWorldCup2026Snapshot({ sofaSource, fifaSource, job, timeoutMs = 45_000, now = new Date(), onProgress }) {
  const official = await collectOfficialSchedule({ source: fifaSource, job, timeoutMs });
  onProgress?.({ phase: "official", current: 1, total: 1, label: "Official schedule captured" });
  const session = await createSofaSession({ source: sofaSource, job, timeoutMs });
  try {
    const overview = await session.navigate(`${sofaSource.baseUrl}${TOURNAMENT_PATH}`, {
      settleMs: 1_800,
      requiredPath: "/api/v1/unique-tournament/16/season/58210/team-events/total",
    });
    const initialTeams = tournamentTeams(overview.responses);
    const events = new Map();
    for (const item of extractSofaEvents(overview.responses.map(({ data }) => data))) {
      if (item.uniqueTournamentId === 16 && item.seasonId === 58210) events.set(item.id, item);
    }
    const tournamentStart = Date.parse("2026-06-11T00:00:00Z") / 1_000;
    const tournamentEnd = Date.parse("2026-07-20T12:00:00Z") / 1_000;
    const inTournamentWindow = (event) => event.startTimestamp >= tournamentStart && event.startTimestamp <= tournamentEnd;
    if ([...events.values()].filter(inTournamentWindow).length !== 104) {
      const dates = dateRange("2026-06-11", now.toISOString().slice(0, 10));
      for (let index = 0; index < dates.length; index += 1) {
        const date = dates[index];
        const result = await session.navigate(`${sofaSource.baseUrl}/football/${date}`, { settleMs: 900 });
        for (const item of extractSofaEvents(result.responses.map(({ data }) => data))) {
          if (item.uniqueTournamentId === 16 && item.seasonId === 58210) events.set(item.id, item);
        }
        onProgress?.({ phase: "schedule", current: index + 1, total: dates.length, label: date });
      }
    }
    onProgress?.({ phase: "schedule", current: 104, total: 104, label: "Tournament schedule normalized" });
    const allEvents = [...events.values()]
      .filter((event) => event.startTimestamp >= tournamentStart && event.startTimestamp <= tournamentEnd)
      .sort((a, b) => a.startTimestamp - b.startTimestamp);
    const completed = allEvents.filter(finished);
    const teamMap = new Map();
    for (const event of allEvents) {
      if (!/^[WL]\d+$/i.test(event.homeTeam) && !teamMap.has(String(event.homeTeamId))) teamMap.set(String(event.homeTeamId), { id: Number(event.homeTeamId), name: event.homeTeam, slug: event.homeTeamSlug, national: true });
      if (!/^[WL]\d+$/i.test(event.awayTeam) && !teamMap.has(String(event.awayTeamId))) teamMap.set(String(event.awayTeamId), { id: Number(event.awayTeamId), name: event.awayTeam, slug: event.awayTeamSlug, national: true });
    }
    for (const team of initialTeams) if (teamMap.has(String(team.id))) teamMap.set(String(team.id), { ...teamMap.get(String(team.id)), ...team });
    const teams = [...teamMap.values()];
    if (teams.length !== 48) throw new Error(`Expected 48 World Cup teams, received ${teams.length}`);
    if (allEvents.length !== 104 || completed.length !== 100) {
      throw new Error(`Incomplete World Cup schedule: ${allEvents.length} events, ${completed.length} completed`);
    }
    const matches = [];
    for (let index = 0; index < completed.length; index += 1) {
      matches.push(await collectMatch({ session, source: sofaSource, event: completed[index], job, onProgress, index, total: completed.length }));
    }
    return {
      capturedAt: new Date().toISOString(),
      official,
      teams,
      events: allEvents,
      matches,
    };
  } finally {
    await session.close();
  }
}
