#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writePrivateJson } from "./lib/compliance-store.mjs";

const root = resolve(import.meta.dirname, "..");
const localOnly = process.argv.includes("--local");
const reasonFlag = process.argv.find((value) => value.startsWith("--reason="));
const reason = reasonFlag?.slice("--reason=".length) || "emergency_publication_freeze";
const incidentId = `freeze-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
const incident = {
  schemaVersion: 1,
  incidentId,
  type: "publication_freeze",
  reasonCode: reason,
  detectedAt: new Date().toISOString(),
  scope: "all_content_routes",
  status: localOnly ? "prepared" : "deployment_started",
  fingerprint: createHash("sha256").update(`${incidentId}:${reason}`).digest("hex"),
};
await writePrivateJson(resolve(root, "private-incidents", String(new Date().getUTCFullYear()), `${incidentId}.json`), incident);

const command = localOnly ? ["run", "compliance:release", "--", "--emergency-freeze"] : ["run", "release:aws"];
const result = spawnSync("npm", command, {
  cwd: root,
  env: { ...process.env, EA_EMERGENCY_FREEZE: "1", EA_INCIDENT_ID: incidentId },
  stdio: "inherit",
});
if (result.status !== 0) throw new Error(`Emergency freeze failed with exit code ${result.status}`);
console.log(JSON.stringify({ status: localOnly ? "freeze_manifest_ready" : "publication_frozen", incidentId }, null, 2));
