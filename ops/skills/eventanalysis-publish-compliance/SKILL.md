---
name: eventanalysis-publish-compliance
description: Mandatory EventAnalysis.org publication compliance workflow. Use whenever creating or editing Chinese source content, facts, claims, entities, translations, legal or civility rules, static builds, AWS releases, production verification, complaints, quarantine, takedown, or restoration. Do not use for a purely read-only query that cannot change content or publication state.
---

# EventAnalysis publication compliance

This Skill is an orchestration contract. Repository commands make the final decision. Never treat your own prose review as permission to publish.

## Non-negotiable rules

1. `Event`, `Fact`, and `Claim` are the factual source. Chinese (`zh`) is the only editable prose master.
2. Never derive a score, time, percentage, entity identity, or statistic from prose when structured facts exist.
3. Every non-Chinese edition must derive from the current Chinese revision and hash. It may localize expression and slug only; it may not add or remove claims, facts, limitations, numbers, entities, praise, criticism, or causal conclusions.
4. No guesswork. Do not infer psychology, intent, character, future performance, injury, medical status, crime, corruption, doping, betting, match fixing, or private life.
5. No insult, personal attack, national, ethnic, nationality, religious, or political generalization.
6. Do not publish a standalone page about a minor. A minor may appear neutrally only in an official lineup or an already occurred event.
7. Person profiles, person comparisons, criticism, injury, discipline, transfer, contract, private life, minors, national image, ethnicity, religion, politics, betting, match fixing, doping, corruption, and crime are risk B or C and cannot auto-publish.
8. A legal pack is usable only when the deterministic validator accepts its official-source hashes, dates, scope, and local-counsel signature. Never create, infer, backdate, or approve a counsel signature.
9. Missing evidence, legal coverage, agent output, hash match, translation, quality report, or installed-Skill hash means stop. Never bypass or downgrade a hard failure.
10. Public HTML must not mention agents, models, this Skill, suppliers, private evidence, internal automation, or private paths.

## Required sequence

### When writing or modifying content

1. Inspect the structured Event, Facts, Claims, entities, evidence references, and current Chinese revision.
2. Edit only the Chinese edition. Keep each paragraph's `claimRefs` explicit.
3. Run `npm run data:validate`.
4. Run the repository content-generation or revision command. Generators may produce only `needs_review`.
5. Run translations from the Chinese master with `npm run content:translate -- <content-item.json>` when you are explicitly preparing derived locales outside the autopilot wrapper.
6. Run independent pre-audit with `npm run compliance:preaudit -- --content=<id>`.
7. Run deterministic audit with `npm run compliance:audit -- --content=<id>`.
8. For unattended publication, trigger `npm run editorial:autopilot -- --content=<id>`. The editor agent receives the review packet, facts, claims, deterministic findings and preaudit output, and makes the final content decision.
9. If the editor decides `quarantine`, quarantine immediately. Use `--delete-body` for class C or prohibited language.

### When building or publishing

1. Verify this Skill installation: `npm run compliance:skill:sync -- --check`.
2. Do not run a direct S3 sync. `npm run publish:automatic -- --content=<id> --locales=zh` remains a legacy local-preview helper and does not perform production publication.
3. The official unattended path is `npm run editorial:autopilot -- --content=<id>`, which may call `npm run publish:agent -- --content=<id>` after the editor approves the content.
4. `npm run publish:agent -- --content=<id>` stages the Chinese master, derives all non-`zh` locales with `npm run release:prepare-locales`, then runs `npm run release:aws -- --confirm-production`.
5. Deterministic preaudit, audit, editorial and prepublish findings still run and are recorded, but content-class findings are advisory to the editor agent rather than the final veto.
6. Hard stops are execution failures only: invalid schema, missing config or commands, agent timeout, translation failure, AWS credential or upload failure, or failed live verification.
7. Emergency quarantine, tombstones and global freezes may still update AWS automatically because they only remove or block public content.
8. If any execution step fails after AWS mutation begins, trigger `npm run emergency:freeze -- --reason=autopilot_release_failure`.
9. Never convert REVIEW or BLOCK to PASS manually in JSON; only a valid editor-agent approval record may override content findings.

### When reviewing a complaint or suspicious live content

1. Prioritize containment over diagnosis.
2. Run `npm run emergency:freeze -- --reason=<short-rule-id>` if scope is uncertain or multiple routes may be affected.
3. For one known item, run `npm run compliance:quarantine -- --content=<id> --rule=<rule-id> --delete-body` when it is class C; omit `--delete-body` only for a temporary legal/evidence hold.
4. Run `npm run emergency:verify` after a global freeze. Verify three times.
5. Keep only hashes, minimal necessary excerpts, rule IDs, jurisdictions, timestamps, and action outcomes in `private-incidents/`. Never copy the removed body back into publishable content.
6. Rebuild from structured facts as a new revision. Never restore the withdrawn prose.

## Independent pre-audit boundary

The reviewer receives only:

- the structured facts and claims used by the item;
- the Chinese master and requested translations;
- applicable legal packs and the compliance policy;
- expected content, revision, policy, source, and legal-pack hashes.

Do not provide the writer's hidden reasoning or ask the reviewer to edit, publish, or upload. The reviewer returns strict `AgentPreAudit` JSON as defined in `references/agent-preaudit-schema.md`. Invalid JSON, timeout, missing jurisdiction, expired report, hash mismatch, or unavailable reviewer is BLOCK.

Target markets are decided independently: a blocked target country is omitted from its route mask and does not automatically block a different country. A blocked content-nexus or publisher jurisdiction blocks the entire item.

## Risk handling

- **A / PASS:** Finished-match facts and directly supported mechanism analysis may continue to the editor agent and, if approved, to unattended production release.
- **B / REVIEW:** Preserve the finding for audit and feed it into the editor prompt. The editor may still approve, rewrite, or quarantine.
- **C / BLOCK:** Remove publishable prose, register an incident, and prevent restoration unless a subsequent compliant revision is approved.

The stricter result always wins when the reviewer and code disagree.

## Useful commands

```bash
npm run content:generate:zh
npm run content:translate -- <content-item.json>
npm run compliance:preaudit -- --content=<id>
npm run compliance:audit -- --content=<id>
npm run editorial:autopilot -- --content=<id>
npm run editorial:autopilot -- --resume-pending
npm run publish:agent -- --content=<id>
npm run compliance:quarantine -- --content=<id> --rule=<rule-id> --delete-body
npm run publish:automatic -- --content=<id> --locales=zh
npm run build:zh
npm run release:prepare-locales
npm run release:aws -- --confirm-production
npm run emergency:freeze -- --reason=<rule-id>
npm run emergency:verify
```

For the exact report fields and legal-pack boundaries, read only the directly relevant files in `references/`.
