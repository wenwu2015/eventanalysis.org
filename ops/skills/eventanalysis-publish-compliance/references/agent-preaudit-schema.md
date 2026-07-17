# AgentPreAudit contract

The reviewer must return one JSON object and no markdown wrapper.

Required fields:

```json
{
  "contentId": "content-id",
  "revision": 1,
  "sourceEditionHash": "sha256",
  "policyHash": "sha256",
  "legalPackHashes": ["sha256"],
  "riskClass": "A",
  "decision": "PASS",
  "scope": "all_locales",
  "jurisdictionDecisions": [
    { "jurisdiction": "CN", "decision": "PASS", "ruleRefs": ["pack-rule-id"] }
  ],
  "factFindings": [],
  "civilityFindings": [],
  "translationFindings": [],
  "prohibitedClaimFindings": [],
  "expiresAt": "2026-07-16T00:00:00.000Z",
  "reviewRunId": "unique-run-id"
}
```

Allowed decisions are `PASS`, `REVIEW`, and `BLOCK`. Allowed scopes are `all_locales` and `locale_only`. Overall PASS requires the content, facts, language, and translations to pass and all four finding arrays to be empty. Individual target-market jurisdictions may still be BLOCK and are then omitted from that route's country mask. Any blocked content-nexus jurisdiction makes the overall report BLOCK. The report expiry may not exceed the policy lease.

Never invent a legal-pack hash or omit a jurisdiction because its pack is missing. Missing coverage must produce BLOCK for that jurisdiction and for the report.
