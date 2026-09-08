#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const role = process.argv[2];
if (!new Set(["writer", "translator", "compliance-reviewer", "editor", "rewriter"]).has(role)) throw new Error("Usage: codex-json-runner.mjs <writer|translator|compliance-reviewer|editor|rewriter>");
const promptPath = process.env.EA_PROMPT_PATH;
const outputPath = process.env.EA_OUTPUT_PATH;
if (!promptPath || !outputPath) throw new Error("EA_PROMPT_PATH and EA_OUTPUT_PATH are required");
const promptJson = await readFile(promptPath, "utf8");
const schemaPath = resolve(import.meta.dirname, "schemas", `${role}.schema.json`);
const codex = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const instruction = [
  `Act only as the EventAnalysis ${role}.`,
  "The complete input JSON is included below this instruction.",
  "Follow its objective and requirements literally.",
  "Return exactly one JSON object matching the supplied output schema, with no markdown or commentary.",
  "Do not inspect parent directories, invoke tools, edit content, change publication state, or access a network.",
].join(" ");

await new Promise((resolveRun, reject) => {
  const child = spawn(codex, [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--color", "never",
    "-c", "model_reasoning_effort=\"low\"",
    "-c", "features.memories=false",
    "-c", "features.apps=false",
    "-c", "features.plugins=false",
    "-c", "features.multi_agent=false",
    "-c", "features.tool_search=false",
    "-c", "web_search=\"disabled\"",
    "--cd", dirname(promptPath), "--output-schema", schemaPath,
    "--output-last-message", outputPath, "-",
  ], { cwd: dirname(promptPath), stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`Codex ${role} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`)));
  child.stdin.end(`${instruction}\n\nINPUT_JSON:\n${promptJson}`);
});
const output = JSON.parse(await readFile(outputPath, "utf8"));
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
