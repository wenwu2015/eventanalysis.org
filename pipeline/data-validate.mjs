#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContentData } from "./lib/data-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requirePrivateEvidence = process.argv.includes("--require-private-evidence");
const data = await validateContentData(root, { requirePrivateEvidence });
console.log(JSON.stringify({
  valid: true,
  schemaVersion: data.schema.schemaVersion,
  counts: {
    entities: data.entities.length,
    events: data.events.length,
    facts: data.facts.length,
    contentItems: data.items.length,
    publicRoutes: data.routeCollisions.size,
  },
  privateEvidenceChecked: requirePrivateEvidence,
}, null, 2));
