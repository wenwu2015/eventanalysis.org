#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1];
}
const contentId = argument("--content");
const revision = Number(argument("--revision"));
if (!contentId || !Number.isInteger(revision) || revision < 1) throw new Error("Usage: npm run content:revision -- --content <id> --revision <number> [--freeze|--build]");
const itemFiles = (await readdir(resolve(root, "content/data/items"))).filter((name) => name.endsWith(".json"));
let currentPath;
let current;
for (const file of itemFiles) {
  const path = resolve(root, "content/data/items", file);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.id === contentId) { currentPath = path; current = value; break; }
}
if (!current) throw new Error(`Unknown content item: ${contentId}`);
const snapshotPath = resolve(root, "content/data/revisions", contentId, `revision-${revision}.json`);
if (process.argv.includes("--freeze")) {
  if (current.revision !== revision) throw new Error(`Current item is revision ${current.revision}; requested ${revision}`);
  await access(snapshotPath).then(() => { throw new Error(`Revision snapshot already exists: ${snapshotPath}`); }).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await mkdir(resolve(snapshotPath, ".."), { recursive: true });
  const serialised = `${JSON.stringify(current, null, 2)}\n`;
  await writeFile(snapshotPath, serialised);
  await writeFile(`${snapshotPath}.sha256`, `${createHash("sha256").update(serialised).digest("hex")}  revision-${revision}.json\n`);
  console.log(`Frozen immutable content revision: ${snapshotPath}`);
} else if (process.argv.includes("--build")) {
  let revisionPath = snapshotPath;
  if (current.revision === revision) revisionPath = currentPath;
  else await access(revisionPath);
  const output = `dist/revisions/${contentId}/${revision}`;
  await runCommand(["node", "--experimental-strip-types", "pipeline/generate-static-site.mjs", `--output=${output}`], { cwd: root, timeoutMs: 120_000, env: { EA_CONTENT_REVISION_FILE: revisionPath } });
  console.log(`Rebuilt revision ${revision} at ${resolve(root, output)}`);
} else throw new Error("Choose --freeze or --build");
