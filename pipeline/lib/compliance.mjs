import { createHash } from "node:crypto";

export const COMPLIANCE_STATUSES = new Set(["unreviewed", "reviewing", "passed", "quarantined", "withdrawn"]);
export const RISK_CLASSES = new Set(["A", "B", "C"]);
export const DECISIONS = new Set(["PASS", "REVIEW", "BLOCK"]);

const PUBLIC_EDITION_FIELDS = [
  "slug", "title", "deck", "kicker", "competition", "venue", "homeName", "awayName",
  "resultLabel", "sections", "timeline",
];

const CORE_FACT_PREDICATES = new Set([
  "final_result", "starting_lineup", "starting_lineup_continuity", "key_events",
  "tournament_roster_profile", "head_to_head_before_match", "personnel_changes",
]);

const PROHIBITED_PATTERNS = [
  { category: "insult", severity: "C", pattern: /(?:垃圾|废物|白痴|蠢货|懦夫|耻辱|叛徒|该死|人渣|idiot|stupid|coward|disgrace|traitor|garbage|scum|moron|imb[eé]cile|idiota|cobarde|vergüenza|vergonha|covarde|dummkopf|feigling|vergogna|codardo|дурак|трус|позор|겁쟁이|바보|くず|馬鹿|卑怯者|غبي|جبان|عار|احمق|بزدل)/iu },
  { category: "nationality_attack", severity: "C", pattern: /(?:这个国家的人都|这个民族都|[一-龥]+人天生|all\s+(?:people|players|men|women)\s+from|the\s+\w+\s+are\s+(?:all|always)|tous\s+les\s+\w+\s+sont|todos\s+los\s+\w+\s+son|كل\s+\S+\s+(?:هم|دائم))/iu },
  { category: "mental_state", severity: "C", pattern: /(?:心态崩|心理崩|故意输|故意放弃|显然不想|缺乏勇气|懒散|胆怯|must have wanted|did not care|seemed afraid|lacked courage|deliberately lost|intentionally gave up|no le importaba|parecía tener miedo|manque de courage|absichtlich verloren|sembrava spaventato|намеренно проиграл|ему было всё равно)/iu },
  { category: "unverified_allegation", severity: "C", pattern: /(?:假球|赌球|操纵比赛|服用兴奋剂|收受贿赂|腐败|犯罪嫌疑|match[- ]fix|fixed the match|betting conspiracy|doping|took a bribe|corrupt|dopaje|partido amañado|corruption|trucage de match|Bestechung|договорн(?:ой|ый) матч|допинг|승부조작|ドーピング|八百長|تلاعب بالمباراة|منشطات|فساد)/iu },
  { category: "health_speculation", severity: "C", pattern: /(?:疑似受伤|可能受伤|带伤出战|心理疾病|看起来有伤|probably injured|likely injured|played through injury|mental illness|parece lesionado|probablement blessé|vermutlich verletzt|вероятно травмирован|부상인 것|けがをしているよう|يبدو مصابا)/iu },
  { category: "future_prediction", severity: "C", pattern: /(?:一定会|肯定会|注定会|未来必然|will definitely|is certain to|is destined to|seguramente ganará|va certainement|wird definitiv|sicuramente vincerà|обязательно выиграет|반드시 이길|必ず勝つ|سيفوز بالتأكيد)/iu },
];

const HIGH_RISK_HINTS = [
  { category: "health", pattern: /(?:伤病|受伤|康复|医疗|injury|injured|medical|health|blessure|lesión|Verletzung|infortunio|травм|부상|けが|إصاب|آسیب)/iu },
  { category: "discipline", pattern: /(?:纪律处分|停赛|禁赛|disciplin|suspension|ban|sanción|suspensi|Sperre|squalifica|дисквалиф|징계|出場停止|إيقاف)/iu },
  { category: "transfer", pattern: /(?:转会|合同|transfer|contract|traspaso|contrat|Wechsel|Vertrag|trasferimento|contratto|трансфер|контракт|이적|계약|移籍|契約|انتقال|عقد)/iu },
  { category: "private_life", pattern: /(?:私生活|家庭纠纷|恋情|private life|family dispute|relationship|vie privée|vida privada|Privatleben|vita privata|личн(?:ая|ой) жизн|사생활|私生活|الحياة الخاصة)/iu },
  { category: "politics", pattern: /(?:政治立场|政党|选举|politic|election|gouvernement|política|Regierung|politica|политик|정치|政治|سياس)/iu },
];

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function publicEditionPayload(edition) {
  return Object.fromEntries(PUBLIC_EDITION_FIELDS.filter((key) => edition?.[key] !== undefined).map((key) => [key, edition[key]]));
}

export function sourceEditionHash(edition) {
  return sha256(publicEditionPayload(edition));
}

export function policyHash(policy) {
  return sha256(policy);
}

export function legalPackHash(pack) {
  return sha256(pack);
}

export function targetJurisdictions(policy, requestedLocales = null) {
  const localeSet = requestedLocales ? new Set(requestedLocales) : null;
  const jurisdictions = [];
  for (const [locale, countries] of Object.entries(policy.localeMarkets || {})) {
    if (localeSet && !localeSet.has(locale)) continue;
    jurisdictions.push(...(countries || []));
  }
  return [...new Set(jurisdictions)].sort();
}

export function paragraphId(sectionId, index) {
  return `paragraph_${String(sectionId || "section").replace(/[^\p{L}\p{N}_-]+/gu, "_")}_${index + 1}`;
}

export function ensureParagraphIds(edition) {
  for (const section of edition?.sections || []) {
    for (let index = 0; index < (section.paragraphs || []).length; index += 1) {
      section.paragraphs[index].id ||= paragraphId(section.id, index);
    }
  }
  return edition;
}

export function buildParagraphMappings(sourceEdition, targetEdition) {
  const source = new Map((sourceEdition.sections || []).map((section) => [section.id, section]));
  const mappings = [];
  for (const targetSection of targetEdition.sections || []) {
    const sourceSection = source.get(targetSection.id);
    for (let index = 0; index < (targetSection.paragraphs || []).length; index += 1) {
      const target = targetSection.paragraphs[index];
      const origin = sourceSection?.paragraphs?.[index];
      if (origin) mappings.push({ sourceParagraphId: origin.id, targetParagraphId: target.id });
    }
  }
  return mappings;
}

export function prepareChineseMaster(item, { quarantine = false } = {}) {
  if (!item?.editions?.zh) throw new Error(`${item?.id || "content item"} has no Chinese source edition`);
  ensureParagraphIds(item.editions.zh);
  const previousHash = item.sourceEditionHash;
  item.sourceLocale = "zh";
  item.sourceRevision = Number(item.revision || 1);
  item.sourceEditionHash = sourceEditionHash(item.editions.zh);
  item.riskClass ||= riskClassForItem(item);
  item.nexusJurisdictions ||= [];
  item.editions.zh.complianceStatus = quarantine ? "quarantined" : (item.editions.zh.complianceStatus || "unreviewed");
  if (quarantine) item.editions.zh.status = "quarantined";
  if (previousHash && previousHash !== item.sourceEditionHash) {
    for (const [locale, edition] of Object.entries(item.editions || {})) {
      if (locale === "zh") continue;
      edition.translationStatus = "stale";
      edition.status = "quarantined";
      edition.complianceStatus = "quarantined";
      delete edition.allowedJurisdictions;
      delete edition.complianceValidUntil;
    }
  }
  return item;
}

export function prepareDerivedEdition(item, locale, { current = false, agentVersion = "legacy-migration" } = {}) {
  if (locale === "zh") return item.editions.zh;
  const edition = item.editions?.[locale];
  if (!edition) throw new Error(`${item.id}/${locale} is missing`);
  ensureParagraphIds(item.editions.zh);
  ensureParagraphIds(edition);
  edition.derivedFromLocale = "zh";
  edition.derivedFromRevision = item.sourceRevision;
  edition.derivedFromHash = item.sourceEditionHash;
  edition.translationAgentVersion = agentVersion;
  edition.translationStatus = current ? "current" : "stale";
  edition.paragraphMappings = buildParagraphMappings(item.editions.zh, edition);
  edition.complianceStatus ||= "unreviewed";
  return edition;
}

function allText(edition) {
  return [edition?.title, edition?.deck, ...(edition?.sections || []).flatMap((section) => [section.title, ...(section.paragraphs || []).map(({ text }) => text)])].filter(Boolean).join("\n");
}

function normalizedNumbers(text) {
  const translated = String(text || "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[０-９]/g, (digit) => String("０１２３４５６７８９".indexOf(digit)));
  return [...translated.matchAll(/\d+(?:[.,]\d+)?%?/g)].map(([value]) => value.replace(",", ".")).sort();
}

function isOfficialAuthorisedSource(source = null) {
  return Boolean(source?.official && source?.license?.authorised);
}

export function scanProhibitedLanguage(edition) {
  const text = allText(edition).normalize("NFKC");
  const findings = [];
  for (const rule of PROHIBITED_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match) findings.push({ category: rule.category, severity: rule.severity, excerptHash: sha256(match[0]), matchedLength: [...match[0]].length });
  }
  for (const rule of HIGH_RISK_HINTS) {
    const match = text.match(rule.pattern);
    if (match) findings.push({ category: rule.category, severity: "B", excerptHash: sha256(match[0]), matchedLength: [...match[0]].length });
  }
  return findings;
}

export function riskClassForItem(item) {
  if (["person_profile", "person_comparison", "team_profile", "place_story", "topic_story"].includes(item.type)) return "B";
  const findings = Object.values(item.editions || {}).flatMap(scanProhibitedLanguage);
  if (findings.some(({ severity }) => severity === "C")) return "C";
  if (findings.some(({ severity }) => severity === "B")) return "B";
  return "A";
}

function claimRefsByParagraph(edition) {
  const output = new Map();
  for (const section of edition?.sections || []) for (const paragraph of section.paragraphs || []) output.set(paragraph.id, [...(paragraph.claimRefs || [])].sort());
  return output;
}

export function validateTranslation(item, locale) {
  const findings = [];
  const source = item.editions?.zh;
  const target = item.editions?.[locale];
  if (!source || !target) return [{ code: "missing_edition", locale }];
  if (target.derivedFromLocale !== "zh") findings.push({ code: "invalid_source_locale", locale });
  if (target.derivedFromRevision !== item.sourceRevision) findings.push({ code: "stale_source_revision", locale });
  if (target.derivedFromHash !== item.sourceEditionHash) findings.push({ code: "stale_source_hash", locale });
  if (target.translationStatus !== "current") findings.push({ code: "translation_not_current", locale });
  const sourceRefs = claimRefsByParagraph(source);
  const targetRefs = claimRefsByParagraph(target);
  const mappedTargets = new Set();
  for (const mapping of target.paragraphMappings || []) {
    mappedTargets.add(mapping.targetParagraphId);
    const left = sourceRefs.get(mapping.sourceParagraphId);
    const right = targetRefs.get(mapping.targetParagraphId);
    if (!left || !right) findings.push({ code: "invalid_paragraph_mapping", locale, mapping });
    else if (stableStringify(left) !== stableStringify(right)) findings.push({ code: "claim_mapping_drift", locale, mapping });
  }
  for (const id of targetRefs.keys()) if (!mappedTargets.has(id)) findings.push({ code: "unmapped_target_paragraph", locale, paragraphId: id });
  const sourceNumbers = normalizedNumbers(allText(source));
  const targetNumbers = normalizedNumbers(allText(target));
  if (stableStringify(sourceNumbers) !== stableStringify(targetNumbers)) findings.push({ code: "numeric_drift", locale, sourceHash: sha256(sourceNumbers), targetHash: sha256(targetNumbers) });
  return findings;
}

export function validateLegalPack(pack, policy, now = new Date()) {
  const findings = [];
  if (!pack || pack.status !== "active") findings.push("pack_not_active");
  if (!pack?.jurisdiction || !/^[A-Z]{2}$/.test(pack.jurisdiction)) findings.push("invalid_jurisdiction");
  if (!pack?.reviewedAt || Number.isNaN(Date.parse(pack.reviewedAt))) findings.push("invalid_reviewed_at");
  if (!pack?.expiresAt || Number.isNaN(Date.parse(pack.expiresAt)) || new Date(pack.expiresAt) <= now) findings.push("pack_expired");
  if (pack?.reviewedAt && pack?.expiresAt && new Date(pack.expiresAt) - new Date(pack.reviewedAt) > Number(policy.legalPackMaxAgeDays || 90) * 86_400_000) findings.push("pack_too_long");
  if (!pack?.counsel?.name || !pack?.counsel?.barJurisdiction || !/^[a-f0-9]{64}$/i.test(pack?.counsel?.signatureHash || "")) findings.push("missing_counsel_signature");
  if (!Array.isArray(pack?.officialSources) || !pack.officialSources.length || pack.officialSources.some((source) => {
    try { return new URL(source.url).protocol !== "https:" || !source.checkedAt || !source.contentHash; } catch { return true; }
  })) findings.push("invalid_official_sources");
  return { ok: findings.length === 0, findings, hash: pack ? legalPackHash(pack) : null };
}

function ageAt(timestampSeconds, date) {
  if (!timestampSeconds) return null;
  return (date.getTime() - Number(timestampSeconds) * 1_000) / 31_556_952_000;
}

function referencedMinor(item, entityMap, publishedAt) {
  if (!["person_profile", "person_comparison"].includes(item.type)) return null;
  const date = new Date(publishedAt || Date.now());
  for (const id of item.entityRefs || []) {
    const entity = entityMap.get(id);
    if (entity?.kind !== "Person") continue;
    const age = ageAt(entity.attributes?.dateOfBirthTimestamp, date);
    if (age !== null && age < 18) return { entityId: id, age };
  }
  return null;
}

function containsSubjectiveMetric(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:average)?rating$|modelScore|predicted|probability/i.test(key) && child !== null && child !== undefined) return true;
    if (containsSubjectiveMetric(child)) return true;
  }
  return false;
}

export function validateAgentPreAudit(report, { item, policy, legalPacks, expectedJurisdictions = null, now = new Date() }) {
  const findings = [];
  const leaseToleranceMs = 5 * 60 * 1_000;
  if (!report) return { ok: false, findings: ["agent_report_missing"] };
  if (report.contentId !== item.id || Number(report.revision) !== Number(item.revision)) findings.push("agent_report_wrong_revision");
  if (report.sourceEditionHash !== item.sourceEditionHash) findings.push("agent_report_wrong_source_hash");
  if (report.policyHash !== policyHash(policy)) findings.push("agent_report_wrong_policy_hash");
  if (!DECISIONS.has(report.decision)) findings.push("agent_report_invalid_decision");
  if (!["all_locales", "locale_only"].includes(report.scope)) findings.push("agent_report_invalid_scope");
  if (!RISK_CLASSES.has(report.riskClass)) findings.push("agent_report_invalid_risk_class");
  if (report.riskClass !== riskClassForItem(item)) findings.push("agent_report_wrong_risk_class");
  if (!report.expiresAt || Number.isNaN(Date.parse(report.expiresAt)) || new Date(report.expiresAt) <= now) findings.push("agent_report_expired");
  if (report.expiresAt && new Date(report.expiresAt) - now > Number(policy.publicationLeaseHours || 24) * 3_600_000 + leaseToleranceMs) findings.push("agent_report_lease_too_long");
  const expectedHashes = [...new Set(legalPacks.map(legalPackHash))].sort();
  const actualHashes = [...new Set(report.legalPackHashes || [])].sort();
  if (stableStringify(expectedHashes) !== stableStringify(actualHashes)) findings.push("agent_report_wrong_legal_pack_hashes");
  const jurisdictions = [...new Set(expectedJurisdictions || [...targetJurisdictions(policy), ...(item.nexusJurisdictions || [])])].sort();
  const decisions = new Map();
  for (const decision of report.jurisdictionDecisions || []) {
    if (!jurisdictions.includes(decision.jurisdiction) || !DECISIONS.has(decision.decision) || decisions.has(decision.jurisdiction)) findings.push("agent_report_invalid_jurisdiction_decision");
    decisions.set(decision.jurisdiction, decision.decision);
  }
  if (jurisdictions.some((jurisdiction) => !decisions.has(jurisdiction))) findings.push("agent_report_missing_jurisdiction_decisions");
  for (const key of ["factFindings", "civilityFindings", "translationFindings", "prohibitedClaimFindings"]) if (!Array.isArray(report[key])) findings.push(`agent_report_missing_${key}`);
  if (report.decision === "PASS" && ["factFindings", "civilityFindings", "translationFindings", "prohibitedClaimFindings"].some((key) => report[key]?.length)) findings.push("agent_report_pass_has_findings");
  if (!report.reviewRunId) findings.push("agent_report_missing_run_id");
  return { ok: findings.length === 0, findings };
}

export function auditContentItem({ item, data, policy, legalRegistry, evidenceRecords = [], sourceRegistry = [], agentReport = null, requestedLocales = null, now = new Date() }) {
  const findings = [];
  const localeScope = requestedLocales ? new Set(requestedLocales) : null;
  const targetCountries = targetJurisdictions(policy, requestedLocales);
  const entityMap = new Map(data.entities.map((entity) => [entity.id, entity]));
  const factMap = new Map(data.facts.map((fact) => [fact.id, fact]));
  const evidenceMap = new Map(evidenceRecords.map((record) => [record.id, record]));
  const sourceMap = new Map(sourceRegistry.map((source) => [source.id, source]));
  const sourceGroups = new Map(sourceRegistry.map((source) => [source.id, source.independenceGroup || source.id]));
  const packMap = new Map((legalRegistry?.packs || []).map((pack) => [pack.jurisdiction, pack]));
  if (item.sourceLocale !== "zh" || !item.editions?.zh) findings.push({ code: "missing_chinese_master", severity: "BLOCK" });
  if (item.sourceRevision !== item.revision) findings.push({ code: "source_revision_mismatch", severity: "BLOCK" });
  if (item.editions?.zh && item.sourceEditionHash !== sourceEditionHash(item.editions.zh)) findings.push({ code: "source_hash_mismatch", severity: "BLOCK" });
  for (const locale of Object.keys(policy.localeMarkets || {})) {
    if (localeScope && !localeScope.has(locale)) continue;
    if (!item.editions?.[locale]) findings.push({ code: "missing_required_locale", locale, severity: "BLOCK" });
  }
  for (const [locale] of Object.entries(item.editions || {})) if (locale !== "zh") {
    for (const finding of validateTranslation(item, locale)) findings.push({ ...finding, severity: "BLOCK" });
  }
  for (const [locale, edition] of Object.entries(item.editions || {})) for (const finding of scanProhibitedLanguage(edition)) findings.push({ ...finding, locale, severity: finding.severity === "C" ? "BLOCK" : "REVIEW" });
  const minor = referencedMinor(item, entityMap, item.publishedAt);
  if (minor) findings.push({ code: "minor_standalone_profile", entityId: minor.entityId, severity: "BLOCK" });
  const inferredNexus = new Set();
  for (const entityId of item.entityRefs || []) {
    const entity = entityMap.get(entityId);
    if (!entity) continue;
    const jurisdiction = entity.attributes?.jurisdiction || entity.attributes?.countryCode || entity.attributes?.nationalityCode;
    if (["Team", "Person"].includes(entity.kind) && !jurisdiction) findings.push({ code: "entity_jurisdiction_missing", entityId, severity: "BLOCK" });
    if (jurisdiction) inferredNexus.add(jurisdiction);
  }
  const relevantFacts = new Set((item.claims || []).flatMap((claim) => claim.factRefs || []));
  for (const factId of relevantFacts) {
    const fact = factMap.get(factId);
    if (!fact || fact.status !== "confirmed") findings.push({ code: "fact_not_confirmed", factId, severity: "BLOCK" });
    if (containsSubjectiveMetric(fact?.value)) findings.push({ code: "subjective_metric", factId, severity: "BLOCK" });
    if (fact && CORE_FACT_PREDICATES.has(fact.predicate)) {
      const sourceIds = new Set((fact.evidenceRefs || []).map((id) => evidenceMap.get(id)?.sourceId).filter(Boolean));
      const groups = new Set([...sourceIds].map((id) => sourceGroups.get(id) || id));
      const officialSingleSourceAllowed = Boolean(policy.allowSingleOfficialCoreSource)
        && sourceIds.size === 1
        && [...sourceIds].every((sourceId) => isOfficialAuthorisedSource(sourceMap.get(sourceId)));
      if (groups.size < Number(policy.minimumIndependentCoreSources || 2) && !officialSingleSourceAllowed) {
        findings.push({ code: "insufficient_independent_sources", factId, groups: [...groups], severity: "BLOCK" });
      }
    }
  }
  const nexus = [...new Set([...(item.nexusJurisdictions || []), ...inferredNexus, ...(legalRegistry?.operatorJurisdictions || [])])];
  const nexusPacks = [];
  for (const jurisdiction of nexus) {
    const pack = packMap.get(jurisdiction);
    const validation = validateLegalPack(pack, policy, now);
    if (!validation.ok) findings.push({ code: "nexus_legal_pack_invalid", jurisdiction, reasons: validation.findings, severity: "BLOCK" });
    else nexusPacks.push(pack);
  }
  const targetPacks = targetCountries.map((country) => packMap.get(country)).filter(Boolean);
  const reportValidation = validateAgentPreAudit(agentReport, {
    item,
    policy,
    legalPacks: [...nexusPacks, ...targetPacks.filter((pack) => validateLegalPack(pack, policy, now).ok)],
    expectedJurisdictions: [...new Set([...targetCountries, ...(item.nexusJurisdictions || []), ...(legalRegistry?.operatorJurisdictions || [])])],
    now,
  });
  for (const code of reportValidation.findings) findings.push({ code, severity: "BLOCK" });
  const inferredRisk = riskClassForItem(item);
  const riskClass = [item.riskClass, inferredRisk].includes("C") ? "C" : [item.riskClass, inferredRisk].includes("B") ? "B" : "A";
  if (riskClass === "C") findings.push({ code: "risk_class_c", severity: "BLOCK" });
  const agentJurisdictions = new Map((agentReport?.jurisdictionDecisions || []).map((decision) => [decision.jurisdiction, decision.decision]));
  const allowedJurisdictions = [];
  for (const country of targetCountries) {
    const pack = packMap.get(country);
    if (!validateLegalPack(pack, policy, now).ok) continue;
    if (agentJurisdictions.get(country) === "PASS") allowedJurisdictions.push(country);
  }
  const hasBlock = findings.some(({ severity }) => severity === "BLOCK");
  const decision = hasBlock ? "BLOCK" : riskClass === "B" || agentReport?.decision === "REVIEW" ? "REVIEW" : agentReport?.decision === "PASS" && allowedJurisdictions.length ? "PASS" : "BLOCK";
  return {
    schemaVersion: 1,
    contentId: item.id,
    revision: item.revision,
    sourceEditionHash: item.sourceEditionHash,
    policyHash: policyHash(policy),
    riskClass,
    decision,
    allowedJurisdictions,
    findings,
    auditedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(policy.publicationLeaseHours || 24) * 3_600_000).toISOString(),
  };
}

export function isEditionPublishable(item, locale, now = new Date()) {
  const edition = item.editions?.[locale];
  if (!edition || edition.status !== "published" || edition.complianceStatus !== "passed") return false;
  if (locale !== "zh" && edition.translationStatus !== "current") return false;
  if (!edition.complianceValidUntil || new Date(edition.complianceValidUntil) <= now) return false;
  return Array.isArray(edition.allowedJurisdictions) && edition.allowedJurisdictions.length > 0;
}

export function isEditionLocallyPreviewable(item, locale, now = new Date()) {
  const edition = item.editions?.[locale];
  if (!edition || !["approved", "published"].includes(edition.status) || edition.complianceStatus !== "passed") return false;
  if (locale !== "zh" && edition.translationStatus !== "current") return false;
  if (!edition.complianceValidUntil || new Date(edition.complianceValidUntil) <= now) return false;
  return Array.isArray(edition.allowedJurisdictions) && edition.allowedJurisdictions.length > 0;
}
