#!/usr/bin/env node
import { resolve } from "node:path";
import { loadPipelineConfig } from "./lib/config.mjs";
import { loadCompliancePolicy, loadLegalRegistry } from "./lib/compliance-store.mjs";
import { summarizeAutomationReadiness } from "./lib/automation-readiness.mjs";

const root = resolve(import.meta.dirname, "..");
const requirePublication = process.argv.includes("--require-publication");
const [config, policy, registry] = await Promise.all([loadPipelineConfig(), loadCompliancePolicy(root), loadLegalRegistry(root)]);
const report = summarizeAutomationReadiness({ config, policy, registry, requirePublication });
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
