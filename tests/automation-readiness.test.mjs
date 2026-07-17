import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAutomationReadiness } from "../pipeline/lib/automation-readiness.mjs";

const config = {
  ai: {
    writer: { command: ["node", "writer"] },
    translator: { command: ["node", "translator"] },
    complianceReviewer: { command: ["node", "reviewer"] },
  },
};

const policy = {
  legalPackMaxAgeDays: 90,
  localeMarkets: { zh: ["CN"], en: ["US"] },
};

test("review readiness passes while publication blockers remain fail-closed", () => {
  const registry = { operatorJurisdictions: ["ZZ"], packs: [] };
  const result = summarizeAutomationReadiness({ config, policy, registry });
  assert.equal(result.status, "PASS");
  assert.equal(result.reviewStatus, "PASS");
  assert.equal(result.publicationStatus, "BLOCK");
  assert.ok(result.publicationFailures.includes("publishing_entity_jurisdiction_unconfirmed"));
});

test("publication mode keeps legal blockers fatal", () => {
  const registry = { operatorJurisdictions: ["ZZ"], packs: [] };
  const result = summarizeAutomationReadiness({ config, policy, registry, requirePublication: true });
  assert.equal(result.status, "BLOCK");
  assert.ok(result.failures.includes("publishing_entity_jurisdiction_unconfirmed"));
});
