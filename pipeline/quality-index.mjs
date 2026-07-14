#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { validateContentData } from "./lib/data-store.mjs";
import { buildCorpus } from "./lib/quality.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = await validateContentData(root);
const corpus = buildCorpus(data).map(({ vector, item, edition, ...entry }) => ({ ...entry, vector: [...vector], primaryIntentKey: item.primaryIntentKey, angleKey: item.angleKey, claimKeys: item.claims.map((claim) => `${claim.kind}:${(claim.factRefs || []).sort().join(",")}`) }));
const destination = resolve(root, "pipeline/runtime/quality/corpus.json");
await mkdir(resolve(destination, ".."), { recursive: true });
await writeFile(destination, `${JSON.stringify({ version: 2, builtAt: new Date().toISOString(), corpus }, null, 2)}\n`);
console.log(`Indexed ${corpus.length} publishable editions in ${destination}`);
