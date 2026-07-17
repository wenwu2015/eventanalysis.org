#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const skill = resolve(root, "ops/skills/eventanalysis-publish-compliance");
const workspace = resolve(root, "ops/skills/eventanalysis-publish-compliance-workspace");
const definitions = JSON.parse(await readFile(resolve(skill, "evals/evals.json"), "utf8")).evals;
const cases = [
  { id: 1, source: "eval-class-a" },
  { id: 2, source: "eval-hidden-insult" },
  { id: 3, source: "eval-expired-pack" },
  { id: 4, source: "eval-production-complaint" },
];
const runs = [];
for (const entry of cases) {
  const definition = definitions.find(({ id }) => id === entry.id);
  const grade = JSON.parse(await readFile(resolve(workspace, entry.source, "grade.json"), "utf8"));
  for (const [sourceName, configuration] of [["with_skill", "with_skill"], ["baseline", "without_skill"]]) {
    const sourceResponse = resolve(workspace, entry.source, sourceName, "response.md");
    const run = resolve(workspace, "review-runs", `eval-${entry.id}`, configuration);
    await mkdir(resolve(run, "outputs"), { recursive: true });
    await cp(sourceResponse, resolve(run, "outputs/response.md"));
    await writeFile(resolve(run, "eval_metadata.json"), `${JSON.stringify({ eval_id: entry.id, prompt: definition.prompt }, null, 2)}\n`);
    const responseGrade = grade.responses[sourceName];
    const scoreEntries = Object.entries(responseGrade.scores);
    const expectations = scoreEntries.map(([text, score]) => ({ text, passed: score >= 4, evidence: responseGrade.reasons[text] || `Score ${score}/5` }));
    const passed = expectations.filter(({ passed: value }) => value).length;
    const grading = { expectations, summary: { passed, failed: expectations.length - passed, total: expectations.length, pass_rate: expectations.length ? passed / expectations.length : 0 } };
    await writeFile(resolve(run, "grading.json"), `${JSON.stringify(grading, null, 2)}\n`);
    runs.push({ eval_id: entry.id, eval_name: entry.source, configuration, run_number: 1, result: { pass_rate: grading.summary.pass_rate, passed, failed: grading.summary.failed, total: grading.summary.total, time_seconds: 0, tokens: 0, tool_calls: 0, errors: 0 }, expectations });
  }
}
function stats(configuration) {
  const values = runs.filter((run) => run.configuration === configuration).map((run) => run.result.pass_rate);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { pass_rate: { mean, stddev: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) }, time_seconds: { mean: 0, stddev: 0 }, tokens: { mean: 0, stddev: 0 } };
}
const withSkill = stats("with_skill");
const withoutSkill = stats("without_skill");
const benchmark = {
  metadata: { skill_name: "eventanalysis-publish-compliance", skill_path: skill, executor_model: "Codex subagent", analyzer_model: "Codex subagent", timestamp: new Date().toISOString(), evals_run: cases.map(({ id }) => id), runs_per_configuration: 1 },
  runs,
  run_summary: { with_skill: withSkill, without_skill: withoutSkill, delta: { pass_rate: `${(withSkill.pass_rate.mean - withoutSkill.pass_rate.mean).toFixed(2)}`, time_seconds: "0", tokens: "0" } },
  notes: ["Responses were non-mutating policy simulations; AWS and repository actions were forbidden.", "Timing and token metrics were not persisted by the collaboration runtime and are reported as zero."],
};
await writeFile(resolve(workspace, "benchmark.json"), `${JSON.stringify(benchmark, null, 2)}\n`);
console.log(JSON.stringify({ status: "eval_workspace_built", runs: runs.length, withSkillPassRate: withSkill.pass_rate.mean, withoutSkillPassRate: withoutSkill.pass_rate.mean, workspace }, null, 2));
