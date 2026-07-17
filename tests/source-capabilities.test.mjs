import test from "node:test";
import assert from "node:assert/strict";
import { isWorldCupEvent, sourceCanCorroborateEvent, sourceSupportsEvent } from "../pipeline/lib/source-capabilities.mjs";

test("world cup coverage is limited to world cup events", () => {
  const fifa = { id: "fifa", coverage: ["world-cup"] };
  const worldCup = { competition: "FIFA World Cup™", uniqueTournamentId: 16 };
  const qualifiers = { competition: "UEFA Champions League, Qualification", uniqueTournamentId: 7 };
  assert.equal(isWorldCupEvent(worldCup), true);
  assert.equal(sourceSupportsEvent(fifa, worldCup), true);
  assert.equal(sourceSupportsEvent(fifa, qualifiers), false);
});

test("generic corroborators require both coverage and a usable mapping", () => {
  const generic = { id: "generic", coverage: ["global-football"], matchUrlTemplate: "https://example.test/{eventId}", eventMapping: { id: "id" } };
  const broken = { id: "generic", coverage: ["global-football"] };
  const event = { competition: "UEFA Champions League, Qualification" };
  assert.equal(sourceCanCorroborateEvent(generic, event), true);
  assert.equal(sourceCanCorroborateEvent(broken, event), false);
});
