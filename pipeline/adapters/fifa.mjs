import { createHash } from "node:crypto";
import { collectBrowserPage } from "../lib/browser-collector.mjs";
import { calculateLineupContinuity } from "../lib/calculations.mjs";
import { isWorldCupEvent } from "../lib/source-capabilities.mjs";

const WORLD_CUP_SCHEDULE_PATH = "/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return String(value || "").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

function localisedName(value) {
  if (Array.isArray(value)) return value.find(({ Locale }) => /^en/i.test(Locale || ""))?.Description || value[0]?.Description || null;
  return value || null;
}

function responsePath(value) {
  try { return new URL(value).pathname; } catch { return ""; }
}

function responseOrigin(value) {
  try { return new URL(value).origin; } catch { return ""; }
}

function parseJson(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

function richText(node) {
  if (!node) return "";
  if (node.nodeType === "text") return node.value || "";
  return (node.content || []).map(richText).join("");
}

function matchPathParts(uri) {
  const match = String(uri || "").match(/\/match-centre\/match\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return {
    competitionId: match[1],
    seasonId: match[2],
    stageId: match[3],
    matchId: match[4],
  };
}

function parseScoreLink(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(?<home>.+?)\s+(?<homeScore>\d+)\s*[-–]\s*(?<awayScore>\d+)\s+(?<away>.+?)(?:\s+\((?:AET|Pens?|PEN)\))?$/i);
  if (!match?.groups) return null;
  return {
    homeTeam: match.groups.home.trim(),
    awayTeam: match.groups.away.trim(),
    homeScore: Number(match.groups.homeScore),
    awayScore: Number(match.groups.awayScore),
  };
}

export function extractWorldCupFixturesFromArticle(responseBodies) {
  const fixtures = [];
  for (const body of responseBodies) {
    const parsed = parseJson(body);
    const content = parsed?.richtext?.content;
    if (!Array.isArray(content)) continue;
    let currentDateLabel = null;
    for (const block of content) {
      if (block.nodeType === "heading-4") {
        currentDateLabel = richText(block).replace(/\s+/g, " ").trim() || currentDateLabel;
      }
      if (block.nodeType !== "paragraph") continue;
      for (const child of block.content || []) {
        if (child.nodeType !== "hyperlink") continue;
        const ids = matchPathParts(child.data?.uri);
        const parsedScore = parseScoreLink(richText(child));
        if (!ids || !parsedScore) continue;
        fixtures.push({
          ...ids,
          ...parsedScore,
          dateLabel: currentDateLabel,
          url: child.data.uri,
        });
      }
    }
  }
  return fixtures;
}

export function normalizeFifaMatch(value) {
  const homeTeam = value?.HomeTeam || value?.Home;
  const awayTeam = value?.AwayTeam || value?.Away;
  if (!value?.IdMatch || !homeTeam || !awayTeam) return null;
  const date = value.Date || value.LocalDate;
  const startTimestamp = date ? Math.floor(Date.parse(date) / 1000) : null;
  if (!Number.isFinite(startTimestamp)) return null;
  const competition = localisedName(value.CompetitionName) || "FIFA competition";
  const homeScore = Number(value.HomeTeamScore ?? homeTeam.Score);
  const awayScore = Number(value.AwayTeamScore ?? awayTeam.Score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  return {
    id: String(value.IdMatch),
    source: "fifa",
    sport: "Football",
    competition,
    startTimestamp,
    status: "finished",
    homeTeamId: String(homeTeam.IdTeam),
    awayTeamId: String(awayTeam.IdTeam),
    homeTeam: localisedName(homeTeam.TeamName),
    awayTeam: localisedName(awayTeam.TeamName),
    homeJurisdiction: homeTeam.IdCountry || null,
    awayJurisdiction: awayTeam.IdCountry || null,
    homeScore,
    awayScore,
    competitionId: String(value.IdCompetition || ""),
    seasonId: String(value.IdSeason || ""),
    stageId: String(value.IdStage || ""),
  };
}

function starterIds(team) {
  return new Set((team?.Players || []).filter((player) => Number(player.Status) === 1).map((player) => String(player.IdPlayer)));
}

function playerNames(team) {
  return Object.fromEntries((team?.Players || []).map((player) => [String(player.IdPlayer), localisedName(player.PlayerName)]));
}

export function buildLineupContinuityRecord(team, previousTeam, metadata = {}) {
  const currentStarters = starterIds(team);
  const previousStarters = starterIds(previousTeam);
  const continuity = calculateLineupContinuity([...previousStarters], [...currentStarters]);
  const currentNames = playerNames(team);
  const previousNames = playerNames(previousTeam);
  const incomingPlayerIds = [...currentStarters].filter((id) => !previousStarters.has(id));
  const outgoingPlayerIds = [...previousStarters].filter((id) => !currentStarters.has(id));
  return {
    baseline: previousStarters.size === 0,
    previousMatchId: metadata.previousMatchId || null,
    currentMatchId: metadata.currentMatchId || null,
    teamId: metadata.teamId || null,
    teamName: metadata.teamName || null,
    sharedStarters: continuity.shared,
    currentStarters: continuity.current,
    continuityRate: continuity.rate,
    incomingPlayerIds,
    outgoingPlayerIds,
    incomingPlayers: incomingPlayerIds.map((id) => ({ id, name: currentNames[id] || null })),
    outgoingPlayers: outgoingPlayerIds.map((id) => ({ id, name: previousNames[id] || null })),
  };
}

export function previousMatchFromTeamForm(teamForm, currentMatchId) {
  return (teamForm?.MatchesList || []).find((match) => String(match.IdMatch) !== String(currentMatchId) && Number(match.MatchStatus) === 0) || null;
}

export function extractFifaHeadToHeadEvents(responseBodies) {
  const events = [];
  for (const body of responseBodies) {
    const parsed = parseJson(body);
    const matches = parsed?.MatchesList;
    if (!Array.isArray(matches)) continue;
    for (const match of matches) {
      const event = normalizeFifaMatch(match);
      if (event) events.push(event);
    }
  }
  return events;
}

export function extractFifaKeyEvents(responseBodies) {
  const events = [];
  const seen = new Set();
  for (const body of responseBodies) {
    const parsed = parseJson(body);
    if (!Array.isArray(parsed?.Event)) continue;
    for (const entry of parsed.Event) {
      if (!Number.isFinite(entry.HomeGoals) || !Number.isFinite(entry.AwayGoals)) continue;
      const total = Number(entry.HomeGoals) + Number(entry.AwayGoals);
      if (total === 0) continue;
      const key = `${entry.MatchMinute}:${entry.HomeGoals}:${entry.AwayGoals}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        minute: entry.MatchMinute || null,
        homeScore: Number(entry.HomeGoals),
        awayScore: Number(entry.AwayGoals),
        teamId: entry.IdTeam ? String(entry.IdTeam) : null,
        eventType: localisedName(entry.TypeLocalized) || null,
        description: localisedName(entry.EventDescription) || null,
      });
    }
  }
  return events.sort((left, right) => String(left.minute).localeCompare(String(right.minute), undefined, { numeric: true }));
}

function matchCentrePath(reference, locale = "en") {
  return `/${locale}/match-centre/match/${reference.competitionId}/${reference.seasonId}/${reference.stageId}/${reference.matchId}`;
}

function pageResultByPath(result, pathname) {
  return result.responses.find((response) => responsePath(response.url) === pathname);
}

async function loadPage(source, path, job, timeoutMs) {
  return collectBrowserPage({
    source,
    url: `${source.baseUrl}${path}`,
    job,
    timeoutMs,
    interact: async (page) => {
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 10_000)));
      await page.waitForTimeout(1_000);
    },
  });
}

function combineHashes(parts) {
  return sha256(parts.filter(Boolean).join(":"));
}

function pageLiveMatch(result) {
  const live = result.responses
    .filter((response) => responseOrigin(response.url) === "https://api.fifa.com" && /\/api\/v3\/live\/football\//.test(responsePath(response.url)))
    .map((response) => parseJson(response.body))
    .map(normalizeFifaMatch)
    .find(Boolean);
  return live || null;
}

function pageTeamForms(result) {
  return new Map(result.responses
    .filter((response) => responseOrigin(response.url) === "https://api.fifa.com" && /\/api\/v3\/teamform\//.test(responsePath(response.url)))
    .map((response) => parseJson(response.body))
    .filter((value) => value?.IdTeam)
    .map((value) => [String(value.IdTeam), value]));
}

function pageLivePayload(result, matchId) {
  return result.responses
    .filter((response) => responseOrigin(response.url) === "https://api.fifa.com" && /\/api\/v3\/live\/football\//.test(responsePath(response.url)))
    .map((response) => parseJson(response.body))
    .find((value) => String(value?.IdMatch) === String(matchId)) || null;
}

function currentFixtureForEvent(fixtures, event) {
  const expectedHome = normalizeText(event.homeTeam);
  const expectedAway = normalizeText(event.awayTeam);
  return fixtures.find((fixture) =>
    normalizeText(fixture.homeTeam) === expectedHome
    && normalizeText(fixture.awayTeam) === expectedAway
    && fixture.homeScore === event.homeScore
    && fixture.awayScore === event.awayScore
  ) || null;
}

export async function collectFifaMatchEvidence({ source, event, job, timeoutMs }) {
  if (!isWorldCupEvent(event)) return null;

  const schedulePage = await loadPage(source, source.schedulePath || WORLD_CUP_SCHEDULE_PATH, job, timeoutMs);
  const fixtures = extractWorldCupFixturesFromArticle(schedulePage.responses.map((response) => response.body));
  const fixture = currentFixtureForEvent(fixtures, event);
  if (!fixture) return null;

  const currentPath = matchCentrePath(fixture, source.matchCentreLocale || "en");
  const currentPage = await loadPage(source, currentPath, job, timeoutMs);
  const confirmedEvent = pageLiveMatch(currentPage);
  if (!confirmedEvent) return null;

  const expectedHome = normalizeText(event.homeTeam);
  const expectedAway = normalizeText(event.awayTeam);
  if (
    normalizeText(confirmedEvent.homeTeam) !== expectedHome
    || normalizeText(confirmedEvent.awayTeam) !== expectedAway
    || confirmedEvent.homeScore !== event.homeScore
    || confirmedEvent.awayScore !== event.awayScore
  ) return null;

  const teamForms = pageTeamForms(currentPage);
  const currentLive = pageLivePayload(currentPage, fixture.matchId);
  if (!currentLive?.HomeTeam || !currentLive?.AwayTeam) return null;

  const previousPages = [];
  for (const side of [currentLive.HomeTeam, currentLive.AwayTeam]) {
    const previous = previousMatchFromTeamForm(teamForms.get(String(side.IdTeam)), fixture.matchId);
    if (!previous) continue;
    previousPages.push({
      teamId: String(side.IdTeam),
      matchId: String(previous.IdMatch),
      result: await loadPage(source, matchCentrePath({
        competitionId: previous.IdCompetition,
        seasonId: previous.IdSeason,
        stageId: previous.IdStage,
        matchId: previous.IdMatch,
      }, source.matchCentreLocale || "en"), job, timeoutMs),
    });
  }

  const previousLiveByTeam = new Map(previousPages.map(({ teamId, matchId, result }) => [teamId, { matchId, live: pageLivePayload(result, matchId) }]));
  const personnelChanges = [
    buildLineupContinuityRecord(currentLive.HomeTeam, previousLiveByTeam.get(String(currentLive.HomeTeam.IdTeam))?.live?.HomeTeam?.IdTeam === String(currentLive.HomeTeam.IdTeam)
      ? previousLiveByTeam.get(String(currentLive.HomeTeam.IdTeam)).live.HomeTeam
      : previousLiveByTeam.get(String(currentLive.HomeTeam.IdTeam))?.live?.AwayTeam, {
      currentMatchId: fixture.matchId,
      previousMatchId: previousLiveByTeam.get(String(currentLive.HomeTeam.IdTeam))?.matchId || null,
      teamId: String(currentLive.HomeTeam.IdTeam),
      teamName: localisedName(currentLive.HomeTeam.TeamName),
    }),
    buildLineupContinuityRecord(currentLive.AwayTeam, previousLiveByTeam.get(String(currentLive.AwayTeam.IdTeam))?.live?.HomeTeam?.IdTeam === String(currentLive.AwayTeam.IdTeam)
      ? previousLiveByTeam.get(String(currentLive.AwayTeam.IdTeam)).live.HomeTeam
      : previousLiveByTeam.get(String(currentLive.AwayTeam.IdTeam))?.live?.AwayTeam, {
      currentMatchId: fixture.matchId,
      previousMatchId: previousLiveByTeam.get(String(currentLive.AwayTeam.IdTeam))?.matchId || null,
      teamId: String(currentLive.AwayTeam.IdTeam),
      teamName: localisedName(currentLive.AwayTeam.TeamName),
    }),
  ];

  const h2hEvents = extractFifaHeadToHeadEvents(currentPage.responses.map((response) => response.body));
  const keyEvents = extractFifaKeyEvents(currentPage.responses.map((response) => response.body));
  const evidenceId = `evidence_${source.id}_${fixture.matchId}_${combineHashes([
    schedulePage.pageHash,
    currentPage.pageHash,
    ...previousPages.map(({ result }) => result.pageHash),
  ]).slice(0, 12)}`;

  job.retainEvidence({
    id: evidenceId,
    sourceId: source.id,
    url: `${source.baseUrl}${currentPath}`,
    rightsSnapshotId: source.license?.snapshotId || `${source.id}-current-contract`,
    capturedAt: new Date().toISOString(),
    parserVersion: "fifa-browser-match-centre-v1",
    rawHash: combineHashes([
      schedulePage.pageHash,
      currentPage.pageHash,
      ...previousPages.map(({ result }) => result.pageHash),
    ]),
    fieldLocations: [
      "official world cup schedule article",
      "official match-centre live payload",
      "official team form payload",
      "official head-to-head payload",
      "official match timeline payload",
    ],
    excerpt: currentPage.visibleText.slice(0, 500),
  });

  return {
    sourceId: source.id,
    evidenceId,
    originalUrl: `${source.baseUrl}${currentPath}`,
    event: confirmedEvent,
    h2hEvents,
    capturedResponseCount: schedulePage.responses.length + currentPage.responses.length + previousPages.reduce((sum, { result }) => sum + result.responses.length, 0),
    personnelChanges,
    keyEvents,
  };
}
