import test from "node:test";
import assert from "node:assert/strict";
import { discoverFinishedMatches, extractSofaEvents } from "../pipeline/adapters/sofascore.mjs";
import { extractMappedEvents } from "../pipeline/adapters/generic-provider.mjs";
import { waitForPendingBrowserResponses } from "../pipeline/lib/browser-collector.mjs";
import { requiresCollectionSession, validateSourceForCollection } from "../pipeline/lib/config.mjs";

test("SofaScore page response objects normalise into football events", () => {
  const events = extractSofaEvents([JSON.stringify({ data: { events: [{
    id: 9,
    startTimestamp: 1_700_000_000,
    status: { type: "finished" },
    tournament: { name: "Cup", category: { sport: { name: "Football" } } },
    homeTeam: { id: 1, name: "Home", slug: "home" },
    awayTeam: { id: 2, name: "Away", slug: "away" },
    homeScore: { current: 2 },
    awayScore: { current: 1 },
  }] } })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeScore, 2);
  assert.equal(events[0].status, "finished");
});

test("authorised portal-specific dotted mappings produce comparable events", () => {
  const events = extractMappedEvents([{ payload: { fixture: {
    fixtureId: "abc",
    home: { id: 1, label: "Home" },
    away: { id: 2, label: "Away" },
    score: { home: 3, away: 2 },
  } } }], {
    id: "fixtureId",
    homeTeamId: "home.id",
    awayTeamId: "away.id",
    homeTeam: "home.label",
    awayTeam: "away.label",
    homeScore: "score.home",
    awayScore: "score.away",
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: "abc",
    homeTeamId: "1",
    awayTeamId: "2",
    homeTeam: "Home",
    awayTeam: "Away",
    homeScore: 3,
    awayScore: 2,
    status: "finished",
  });
});

test("licence and attribution conflicts block collection before navigation", () => {
  const base = { active: true, license: { authorised: true, publicAttributionRequired: false } };
  assert.deepEqual(validateSourceForCollection(base), { ok: true });
  assert.equal(requiresCollectionSession({ id: "sofascore", kind: "browser" }), true);
  assert.equal(validateSourceForCollection({ ...base, id: "sofascore", kind: "browser" }).reason, "storage_state_missing");
  assert.deepEqual(
    validateSourceForCollection({ ...base, id: "sofascore", kind: "browser", storageStatePath: "private-auth/sofascore.json" }),
    { ok: true },
  );
  assert.equal(validateSourceForCollection({ ...base, active: false }).reason, "inactive");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: false } }).reason, "not_authorised");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, publicAttributionRequired: true } }).reason, "public_attribution_conflicts_with_site_policy");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, retentionRequired: true } }).reason, "retention_conflicts_with_ephemeral_policy");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, regions: ["EU"] } }, new Date(), "CN").reason, "region_not_licensed");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, validThrough: "2020-01-01" } }, new Date("2026-01-01")).reason, "licence_expired");
});

test("pending browser response drain waits for late-added work", async () => {
  const pending = new Set();
  const completed = [];
  const immediate = Promise.resolve().then(() => {
    const late = new Promise((resolve) => setTimeout(() => {
      completed.push("late");
      resolve();
    }, 10));
    pending.add(late);
    late.finally(() => pending.delete(late));
    completed.push("initial");
  });
  pending.add(immediate);
  immediate.finally(() => pending.delete(immediate));

  await waitForPendingBrowserResponses(pending);

  assert.deepEqual(completed, ["initial", "late"]);
  assert.equal(pending.size, 0);
});

test("pending browser response drain fails closed on stuck work", async () => {
  const pending = new Set();
  const stuck = new Promise(() => {});
  pending.add(stuck);

  await assert.rejects(
    () => waitForPendingBrowserResponses(pending, { timeoutMs: 20 }),
    /Timed out waiting for 1 browser response/,
  );
  assert.equal(pending.size, 1);
});

test("finished-match discovery skips one failed date and continues other authorised pages", async () => {
  const now = new Date("2026-08-04T12:00:00Z");
  const collected = [];
  const errors = [];
  const events = await discoverFinishedMatches({
    source: { id: "sofascore", baseUrl: "https://www.sofascore.com" },
    job: { retainUrl() {} },
    now,
    lookbackHours: 48,
    stabilityMinutes: 20,
    timeoutMs: 1_000,
    onCollectionError(error) {
      errors.push(error);
    },
    async collectPage({ url }) {
      collected.push(url);
      if (url.endsWith("/2026-08-04")) {
        const error = new Error("page.goto: net::ERR_CONNECTION_RESET");
        error.code = "ERR_CONNECTION_RESET";
        throw error;
      }
      return {
        responses: [{
          body: JSON.stringify({
            data: {
              events: [{
                id: 101,
                startTimestamp: Math.floor(new Date("2026-08-03T06:00:00Z").getTime() / 1000),
                status: { type: "finished" },
                tournament: { name: "Cup", category: { sport: { name: "Football" } } },
                homeTeam: { id: 1, name: "Home", slug: "home" },
                awayTeam: { id: 2, name: "Away", slug: "away" },
                homeScore: { current: 2 },
                awayScore: { current: 1 },
              }],
            },
          }),
        }],
      };
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].id, "101");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].sourceId, "sofascore");
  assert.ok(collected.some((url) => url.endsWith("/2026-08-03")));
});

test("finished-match discovery fails closed on access-control challenge responses", async () => {
  const errors = [];
  const events = await discoverFinishedMatches({
    source: { id: "sofascore", baseUrl: "https://www.sofascore.com" },
    job: { retainUrl() {} },
    now: new Date("2026-08-11T12:00:00Z"),
    lookbackHours: 24,
    stabilityMinutes: 20,
    timeoutMs: 1_000,
    onCollectionError(error) {
      errors.push(error);
    },
    async collectPage() {
      return {
        responses: [{
          status: 403,
          body: JSON.stringify({ error: { code: 403, reason: "challenge" } }),
        }],
      };
    },
  });

  assert.deepEqual(events, []);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.code === "ACCESS_CONTROL_REQUIRED"));
});

test("finished-match discovery uses Asia/Shanghai date paths", async () => {
  const collected = [];
  await discoverFinishedMatches({
    source: { id: "sofascore", baseUrl: "https://www.sofascore.com" },
    job: { retainUrl() {} },
    now: new Date("2026-08-11T00:30:00+08:00"),
    lookbackHours: 48,
    stabilityMinutes: 20,
    timeoutMs: 1_000,
    async collectPage({ url }) {
      collected.push(url);
      return { responses: [] };
    },
  });

  assert.deepEqual(collected, [
    "https://www.sofascore.com/football/2026-08-11",
    "https://www.sofascore.com/football/2026-08-10",
    "https://www.sofascore.com/football/2026-08-09",
  ]);
});
