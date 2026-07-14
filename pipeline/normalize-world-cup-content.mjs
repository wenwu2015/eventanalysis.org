#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { privatizeWorldCupIds } from "./lib/world-cup-id-privacy.mjs";

const root = resolve(import.meta.dirname, "..");
const paths = {
  entities: "content/data/entities/world-cup-2026.json",
  events: "content/data/events/world-cup-2026.json",
  facts: "content/data/facts/world-cup-2026.json",
  items: "content/data/items/world-cup-2026.json",
};
const content = {};
for (const [key, relative] of Object.entries(paths)) content[key] = JSON.parse(await readFile(resolve(root, relative), "utf8"));
const rewritten = privatizeWorldCupIds(content);
for (const [key, relative] of Object.entries(paths)) await writeFile(resolve(root, relative), `${JSON.stringify(rewritten[key], null, 2)}\n`);
console.log(JSON.stringify({ status: "world_cup_internal_ids_privatized" }));

