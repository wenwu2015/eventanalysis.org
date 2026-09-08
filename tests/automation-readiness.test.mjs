import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAutomationReadiness } from "../pipeline/lib/automation-readiness.mjs";

const config = {
  sources: [{ id: "sofascore", active: true, kind: "browser", storageStatePath: "private-auth/sofascore.json", license: { authorised: true } }],
  ai: {
    writer: { command: ["node", "writer"] },
    editor: { command: ["node", "editor"] },
    rewriter: { command: ["node", "rewriter"] },
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

test("publication mode ignores legal blockers when policy disables legal validation", () => {
  const registry = { operatorJurisdictions: ["ZZ"], packs: [] };
  const result = summarizeAutomationReadiness({
    config,
    policy: { ...policy, disableLegalPackValidation: true },
    registry,
    requirePublication: true,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.publicationStatus, "PASS");
});

test("review readiness fails closed when SofaScore browser session is missing", () => {
  const registry = { operatorJurisdictions: ["ZZ"], packs: [] };
  const result = summarizeAutomationReadiness({
    config: {
      ...config,
      sources: [{ id: "sofascore", active: true, kind: "browser", license: { authorised: true } }],
    },
    policy,
    registry,
  });
  assert.equal(result.status, "BLOCK");
  assert.ok(result.reviewFailures.includes("collection_source_unavailable:sofascore:storage_state_missing"));
});
