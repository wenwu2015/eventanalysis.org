import test from "node:test";
import assert from "node:assert/strict";
import { extractSofaEvents } from "../pipeline/adapters/sofascore.mjs";
import { extractMappedEvents } from "../pipeline/adapters/generic-provider.mjs";
import { validateSourceForCollection } from "../pipeline/lib/config.mjs";

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
  assert.equal(validateSourceForCollection({ ...base, active: false }).reason, "inactive");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: false } }).reason, "not_authorised");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, publicAttributionRequired: true } }).reason, "public_attribution_conflicts_with_site_policy");
  assert.equal(validateSourceForCollection({ ...base, license: { authorised: true, validThrough: "2020-01-01" } }, new Date("2026-01-01")).reason, "licence_expired");
});
