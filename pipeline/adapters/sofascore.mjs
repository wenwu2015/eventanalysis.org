import { AccessControlError, collectBrowserPage } from "../lib/browser-collector.mjs";

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) for (const item of value) walk(item, visit, seen);
  else for (const item of Object.values(value)) walk(item, visit, seen);
}

function eventStatus(event) {
  const value = event.status?.type || event.status?.description || event.status;
  return String(value || "").toLowerCase();
}

export function normalizeSofaEvent(event) {
  if (!event?.id || !event?.homeTeam?.name || !event?.awayTeam?.name) return null;
  if (!Number.isFinite(event.startTimestamp)) return null;
  const status = eventStatus(event);
  const homeScore = event.homeScore?.current ?? event.homeScore?.normaltime;
  const awayScore = event.awayScore?.current ?? event.awayScore?.normaltime;
  return {
    id: String(event.id),
    source: "sofascore",
    sport: event.tournament?.category?.sport?.name || event.sport?.name || "Football",
    competition: event.tournament?.name || event.uniqueTournament?.name || "Unknown competition",
    uniqueTournamentId: event.tournament?.uniqueTournament?.id ?? event.uniqueTournament?.id ?? null,
    seasonId: event.season?.id ?? null,
    startTimestamp: event.startTimestamp,
    status,
    homeTeamId: String(event.homeTeam.id),
    awayTeamId: String(event.awayTeam.id),
    homeTeam: event.homeTeam.name,
    awayTeam: event.awayTeam.name,
    homeJurisdiction: event.homeTeam.country?.alpha2?.toUpperCase?.() || null,
    awayJurisdiction: event.awayTeam.country?.alpha2?.toUpperCase?.() || null,
    homeTeamSlug: event.homeTeam.slug,
    awayTeamSlug: event.awayTeam.slug,
    homeScore: Number.isFinite(homeScore) ? Number(homeScore) : null,
    awayScore: Number.isFinite(awayScore) ? Number(awayScore) : null,
    customId: event.customId || null,
    slug: event.slug || `${event.homeTeam.slug}-${event.awayTeam.slug}`,
  };
}

export function extractSofaEvents(responseBodies) {
  const events = new Map();
  for (const body of responseBodies) {
    let parsed;
    try { parsed = typeof body === "string" ? JSON.parse(body) : body; } catch { continue; }
    walk(parsed, (candidate) => {
      const event = normalizeSofaEvent(candidate);
      if (event && event.sport.toLowerCase() === "football") events.set(event.id, event);
    });
  }
  return [...events.values()];
}

function datePath(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function assertNoAccessChallenge(responses = []) {
  const blocked = responses.find((response) => {
    const status = Number(response?.status);
    if ([401, 403, 429].includes(status)) return true;
    return /"reason"\s*:\s*"challenge"/i.test(String(response?.body || ""));
  });
  if (!blocked) return;
  const status = Number(blocked.status);
  const detail = [401, 403, 429].includes(status) ? `Provider returned ${status}` : "An access-control challenge was detected";
  throw new AccessControlError(`${detail}; no bypass was attempted.`);
}

export async function discoverFinishedMatches({
  source,
  job,
  now = new Date(),
  lookbackHours = 48,
  stabilityMinutes = 20,
  timeoutMs,
  collectPage = collectBrowserPage,
  onCollectionError = null,
}) {
  const dates = new Set();
  for (let hours = 0; hours <= lookbackHours; hours += 24) {
    dates.add(datePath(new Date(now.getTime() - hours * 3_600_000)));
  }
  const all = new Map();
  for (const date of dates) {
    let result;
    try {
      result = await collectPage({
        source,
        url: `${source.baseUrl}/football/${date}`,
        job,
        timeoutMs,
      });
      assertNoAccessChallenge(result.responses);
    } catch (error) {
      onCollectionError?.({
        sourceId: source.id,
        date,
        code: error?.code || "collection_failed",
        message: String(error?.message || error).slice(0, 500),
      });
      continue;
    }
    for (const event of extractSofaEvents(result.responses.map((response) => response.body))) {
      all.set(event.id, event);
    }
  }
  const cutoff = Math.floor((now.getTime() - lookbackHours * 3_600_000) / 1000);
  // We do not trust an instantaneous "finished" flag. With no authoritative
  // end timestamp, start + 3 hours is a conservative upper bound, followed by
  // the required stability window.
  const stableBefore = Math.floor((now.getTime() - (180 + stabilityMinutes) * 60_000) / 1000);
  return [...all.values()].filter((event) =>
    ["finished", "afterpenalties", "afterextra"].some((status) => event.status.includes(status))
    && event.startTimestamp >= cutoff
    && event.startTimestamp <= stableBefore
    && event.homeScore !== null
    && event.awayScore !== null
  );
}

export function sofaEventUrl(source, event) {
  if (!event.customId) return `${source.baseUrl}/event/${event.id}`;
  return `${source.baseUrl}/${event.slug}/${event.customId}#id:${event.id}`;
}

export async function collectMatchEvidence({ source, event, job, timeoutMs }) {
  const result = await collectBrowserPage({
    source,
    url: sofaEventUrl(source, event),
    job,
    timeoutMs,
    interact: async (page) => {
      for (const label of [/head to head/i, /^h2h$/i, /lineups?/i]) {
        const controls = [page.getByRole("tab", { name: label }).first(), page.getByRole("button", { name: label }).first()];
        for (const control of controls) {
          if (await control.isVisible().catch(() => false)) {
            await control.click({ timeout: 3_000 }).catch(() => {});
            await page.waitForTimeout(1_000);
            break;
          }
        }
      }
    },
  });
  assertNoAccessChallenge(result.responses);
  const bodies = result.responses.map((response) => {
    try { return JSON.parse(response.body); } catch { return null; }
  }).filter(Boolean);
  const h2hEvents = extractSofaEvents(bodies).map((item) => ({
    ...item,
    status: ["finished", "afterpenalties", "afterextra"].some((status) => item.status.includes(status)) ? "finished" : item.status,
  }));
  const evidenceId = `evidence_${source.id}_${event.id}_${result.pageHash.slice(0, 12)}`;
  job.retainEvidence({
    id: evidenceId,
    sourceId: source.id,
    url: sofaEventUrl(source, event),
    rightsSnapshotId: source.license?.snapshotId || `${source.id}-current-contract`,
    capturedAt: new Date().toISOString(),
    parserVersion: "sofascore-browser-v2",
    rawHash: result.pageHash,
    fieldLocations: ["browser DOM", `${bodies.length} same-origin JSON responses`, "event", "head-to-head", "lineups"],
    excerpt: result.visibleText.slice(0, 500),
  });
  return {
    sourceId: source.id,
    evidenceId,
    originalUrl: sofaEventUrl(source, event),
    event,
    h2hEvents,
    capturedResponseCount: bodies.length,
    visibleText: result.visibleText,
    personnelChanges: [],
    keyEvents: [],
  };
}
