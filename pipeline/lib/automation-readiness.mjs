import { validateSourceForCollection } from "./config.mjs";
import { legalValidationDisabled, targetJurisdictions, validateLegalPack } from "./compliance.mjs";

export function summarizeAutomationReadiness({ config, policy, registry, requirePublication = false, now = new Date() }) {
  const reviewFailures = [];
  const publicationFailures = [];
  const bypassLegalValidation = legalValidationDisabled(policy);

  for (const role of ["writer", "editor", "rewriter", "translator", "complianceReviewer"]) {
    if (!config.ai[role]?.command?.length) reviewFailures.push(`agent_command_missing:${role}`);
  }

  const discoverySource = (config.sources || []).find((source) => source.id === "sofascore");
  const discoveryPolicy = discoverySource ? validateSourceForCollection(discoverySource, now) : { ok: false, reason: "missing" };
  if (!discoveryPolicy.ok) reviewFailures.push(`collection_source_unavailable:sofascore:${discoveryPolicy.reason}`);

  if (!bypassLegalValidation) {
    const packs = new Map((registry.packs || []).map((pack) => [pack.jurisdiction, pack]));
    for (const jurisdiction of [...new Set([...targetJurisdictions(policy), ...(registry.operatorJurisdictions || [])])]) {
      const result = validateLegalPack(packs.get(jurisdiction), policy, now);
      if (!result.ok) publicationFailures.push(`legal_pack_invalid:${jurisdiction}:${result.findings.join(",")}`);
    }
    if (registry.operatorJurisdictions?.includes("ZZ") || !registry.operatorJurisdictions?.length) {
      publicationFailures.push("publishing_entity_jurisdiction_unconfirmed");
    }
  }

  const reviewStatus = reviewFailures.length ? "BLOCK" : "PASS";
  const publicationStatus = publicationFailures.length ? "BLOCK" : "PASS";
  const status = reviewFailures.length || (requirePublication && publicationFailures.length) ? "BLOCK" : "PASS";

  return {
    status,
    mode: requirePublication ? "publication" : "review",
    reviewStatus,
    publicationStatus,
    failures: requirePublication ? [...reviewFailures, ...publicationFailures] : [...reviewFailures],
    reviewFailures,
    publicationFailures,
  };
}
