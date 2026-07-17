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
9. Missing evidence, legal coverage, agent output, hash match, lease, translation, quality report, or installed-Skill hash means stop. Never bypass or downgrade a hard failure.
10. Public HTML must not mention agents, models, this Skill, suppliers, private evidence, internal automation, or private paths.

## Required sequence

### When writing or modifying content

1. Inspect the structured Event, Facts, Claims, entities, evidence references, and current Chinese revision.
2. Edit only the Chinese edition. Keep each paragraph's `claimRefs` explicit.
3. Run `npm run data:validate`.
4. Run the repository content-generation or revision command. Generators may produce only `needs_review`.
5. Run translations from the Chinese master with `npm run content:translate -- <content-item.json>`.
6. Run independent pre-audit with `npm run compliance:preaudit -- --content=<id>`.
7. Run deterministic audit with `npm run compliance:audit -- --content=<id>`.
8. If decision is REVIEW, create or retain a private review packet and stop. Do not publish.
9. If decision is BLOCK, quarantine immediately. Use `--delete-body` for class C or prohibited language.

### When building or publishing

1. Verify this Skill installation: `npm run compliance:skill:sync -- --check`.
2. Do not run a direct S3 sync. `npm run publish:automatic -- --content=<id> --locales=zh` prepares the Chinese class-A item for local preview only and must never invoke AWS.
3. After local validation, generate only the Chinese static preview with `npm run build:zh` or `npm run build:preview`. Do not generate or refresh derived languages during routine local editing.
4. Complete data validation, source checks, independent pre-audit, deterministic legal/fact/civility checks, duplicate and SEO checks, Chinese static preview, leakage checks, and local browser review before any production release.
5. AWS publication is a separate manual action. Only after explicit approval run `npm run release:aws -- --confirm-production`; this command runs `npm run release:prepare-locales` to derive and check non-Chinese editions before the production build. Never put this confirmation flag in a generator, monitor, scheduled job, or agent command.
6. Emergency quarantine, tombstones and global freezes may still update AWS automatically because they only remove or block public content.
7. If any step fails, leave AWS unchanged. Never turn local preview success into implied production approval.
8. Never convert REVIEW or BLOCK to PASS manually in JSON.

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

- **A / PASS:** Finished-match facts and directly supported mechanism analysis may continue to deterministic local preview gates after the 20-minute result stability window and two independent authorized sources. Production still requires an explicit manual release.
- **B / REVIEW:** Stop for a separate human signature. No unattended AWS release.
- **C / BLOCK:** Remove publishable prose, register an incident, and prevent restoration.

The stricter result always wins when the reviewer and code disagree.

## Useful commands

```bash
npm run content:generate:zh
npm run content:translate -- <content-item.json>
npm run compliance:preaudit -- --content=<id>
npm run compliance:audit -- --content=<id>
npm run compliance:quarantine -- --content=<id> --rule=<rule-id> --delete-body
npm run publish:automatic -- --content=<id> --locales=zh
npm run build:zh
npm run release:prepare-locales
npm run release:aws -- --confirm-production
npm run emergency:freeze -- --reason=<rule-id>
npm run emergency:verify
```

For the exact report fields and legal-pack boundaries, read only the directly relevant files in `references/`.
