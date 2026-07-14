import { collectBrowserPage } from "../lib/browser-collector.mjs";

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
    startTimestamp: event.startTimestamp,
    status,
    homeTeamId: String(event.homeTeam.id),
    awayTeamId: String(event.awayTeam.id),
    homeTeam: event.homeTeam.name,
    awayTeam: event.awayTeam.name,
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
  return date.toISOString().slice(0, 10);
}

export async function discoverFinishedMatches({ source, job, now = new Date(), lookbackHours = 48, timeoutMs }) {
  const dates = new Set();
  for (let hours = 0; hours <= lookbackHours; hours += 24) {
    dates.add(datePath(new Date(now.getTime() - hours * 3_600_000)));
  }
  const all = new Map();
  for (const date of dates) {
    const result = await collectBrowserPage({
      source,
      url: `${source.baseUrl}/football/${date}`,
      job,
      timeoutMs,
    });
    for (const event of extractSofaEvents(result.responses.map((response) => response.body))) {
      all.set(event.id, event);
    }
  }
  const cutoff = Math.floor((now.getTime() - lookbackHours * 3_600_000) / 1000);
  const end = Math.floor(now.getTime() / 1000);
  return [...all.values()].filter((event) =>
    ["finished", "afterpenalties", "afterextra"].some((status) => event.status.includes(status))
    && event.startTimestamp >= cutoff
    && event.startTimestamp <= end
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
  const bodies = result.responses.map((response) => {
    try { return JSON.parse(response.body); } catch { return null; }
  }).filter(Boolean);
  const h2hEvents = extractSofaEvents(bodies).map((item) => ({
    ...item,
    status: ["finished", "afterpenalties", "afterextra"].some((status) => item.status.includes(status)) ? "finished" : item.status,
  }));
  return {
    sourceId: source.id,
    originalUrl: sofaEventUrl(source, event),
    event,
    h2hEvents,
    capturedResponseCount: bodies.length,
    visibleText: result.visibleText,
  };
}
