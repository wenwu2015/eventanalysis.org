import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("ads default to disabled and enabled links carry the required attributes", async () => {
  const config = JSON.parse(await readFile(resolve(root, "site/ad-config.json"), "utf8"));
  const component = await readFile(resolve(root, "site/ad-slot.js"), "utf8");
  assert.equal(config.enabled, false);
  assert.match(component, /target = "_blank"/);
  assert.match(component, /rel = "nofollow noopener noreferrer"/);
  assert.match(component, /sessionStorage/);
  assert.match(component, /Advertisement/);
});

test("local evidence and credentials are excluded from source control", async () => {
  const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
  for (const path of ["/private-sources/", "/private-evidence/", "/private-auth/", "/pipeline/jobs/", "/pipeline/config/sources.local.json"]) {
    assert.ok(ignore.includes(path), `${path} must be ignored`);
  }
});

test("public editorial data contains no provider disclosure, remote media or embedded media markup", async () => {
  const content = await readFile(resolve(root, "content/data/items/euro-2024-final-analysis.json"), "utf8");
  assert.doesNotMatch(content, /sofascore|sportradar|genius sports|wyscout|statsbomb|transfermarkt|skillcorner/i);
  assert.doesNotMatch(content, /https?:\/\//i);
  assert.doesNotMatch(content, /<(?:img|picture|video|iframe|canvas)\b/i);
});

test("the football language matrix is complete and never requires English fallback", async () => {
  const locales = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
  const codes = locales.map(({ code }) => code);
  for (const required of ["zh", "en", "ja", "ko", "ru", "es", "pt", "fr", "de", "it", "ar", "sv", "nl", "tr", "pl", "hr", "sr", "uk", "fa", "id"]) {
    assert.ok(codes.includes(required), `${required} must be supported`);
  }
  assert.equal(new Set(codes).size, codes.length);
  const writer = await readFile(resolve(root, "pipeline/lib/article-writer.mjs"), "utf8");
  assert.match(writer, /Never use an English placeholder/);
  assert.match(writer, /needs_review/);
});

test("version one exposes football only while future ball sports remain isolated", async () => {
  const sports = JSON.parse(await readFile(resolve(root, "content/sports.json"), "utf8"));
  assert.deepEqual(sports.filter(({ status }) => status === "active").map(({ code }) => code), ["football"]);
  for (const planned of ["basketball", "volleyball", "badminton"]) {
    const sport = sports.find(({ code }) => code === planned);
    assert.equal(sport?.status, "planned");
    assert.equal(sport?.routeSegment, planned);
  }
  const policy = JSON.parse(await readFile(resolve(root, "pipeline/config/policy.json"), "utf8"));
  assert.deepEqual(policy.activeSports, ["football"]);
});
