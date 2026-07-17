#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = resolve(root, "ops/skills/eventanalysis-publish-compliance");
const target = resolve(homedir(), ".codex/skills/eventanalysis-publish-compliance");
const checkOnly = process.argv.includes("--check");

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else output.push(path);
  }
  return output.sort();
}

async function treeHash(directory) {
  const hash = createHash("sha256");
  for (const path of await files(directory)) {
    hash.update(relative(directory, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const sourceHash = await treeHash(source);
let targetHash = null;
try { targetHash = await treeHash(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (checkOnly) {
  if (sourceHash !== targetHash) throw new Error(`Installed compliance Skill is missing or stale. Run npm run compliance:skill:sync. project=${sourceHash} installed=${targetHash || "missing"}`);
  console.log(JSON.stringify({ status: "skill_current", hash: sourceHash, target }, null, 2));
} else {
  await mkdir(resolve(target, ".."), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  targetHash = await treeHash(target);
  if (sourceHash !== targetHash) throw new Error("Installed compliance Skill hash does not match project source");
  console.log(JSON.stringify({ status: "skill_installed", hash: sourceHash, target }, null, 2));
}
