#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditEdition, buildCorpus } from "./lib/quality.mjs";

const root = resolve(import.meta.dirname, "..");
const policy = JSON.parse(await readFile(resolve(root, "pipeline/config/quality-policy.json"), "utf8"));
const baseText = "Spain kept both wingers wide. The right side drew the defence infield before a pass released the runner from the opposite side. That same width returned for the late winner.";
const make = (id, intent, body, facts = ["f1", "f2", "f3"]) => ({ id, type: "match_analysis", sport: "football", primaryIntentKey: intent, angleKey: id, originalContribution: id, author: "writer-a", eventRefs: ["event-1"], claims: facts.map((fact, index) => ({ id: `${id}-${index}`, kind: "analysis", factRefs: [fact], summary: `${id} claim ${index}` })), editions: { en: { status: "published", slug: id, title: `${id} title`, deck: `${id} deck`, sections: [{ id: "result", title: "Result", paragraphs: [{ claimRefs: [`${id}-0`], text: body }] }] } } });
const baseline = make("baseline", "intent-one", baseText);
const data = { items: [baseline] };
const corpus = buildCorpus(data);
const fixtures = [
  ["exact", make("exact", "intent-two", baseText), "BLOCK"],
  ["light-rewrite", make("light-rewrite", "intent-one", "Spain kept both wingers wide and pulled defenders inward on the right before finding a runner on the far side. The late goal used that width again."), "BLOCK"],
  ["semantic-rewrite", make("semantic-rewrite", "intent-one", "Spain stretched the back line horizontally. Pressure toward one flank opened a far-side arrival, and the winning move repeated the geometry late in the match."), "BLOCK"],
  ["legitimate-sequel", make("legitimate-sequel", "intent-five", "A later selection change altered Spain's pressing coverage, with three new evidence-backed conclusions about the midfield line and rest defence.", ["f4", "f5", "f6", "f7"]), "PASS"],
  ["different-angle", { ...make("different-angle", "intent-six", "Ticketing, transport and the stadium approach shaped the supporter experience in Berlin rather than the tactical result.", ["f8", "f9", "f10"]), eventRefs: ["event-2"] }, "PASS"],
];
const output = fixtures.map(([name, item, expected]) => {
  const report = auditEdition({ item, locale: "en", edition: item.editions.en, corpus, policy });
  return { name, expected, actual: report.status, passed: expected === "PASS" ? report.status === "PASS" : report.status === "BLOCK", findings: report.findings.map(({ code }) => code) };
});
console.log(JSON.stringify({ policyVersion: policy.version, fixtures: output }, null, 2));
if (output.some(({ passed }) => !passed)) process.exitCode = 1;
