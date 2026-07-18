import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { routeKeyForType, routePath } from "./data-store.mjs";
import { loadCompliancePolicy, loadLegalRegistry, readJson } from "./compliance-store.mjs";
import { validateLegalPack } from "./compliance.mjs";
import { summarizeAutomationReadiness } from "./automation-readiness.mjs";
import { deriveReviewLifecycle, loadReviewWorkflow, mutateReviewWorkflow } from "./review-workflow.mjs";

function canonicalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function packetModifiedAt(packet) {
  return packet.item.reviewedAt || packet.item.publishedAt || packet.event?.startedAt || packet.evidence?.collectedAt || "1970-01-01T00:00:00Z";
}

async function readJsonDirectoryEntries(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const values = [];
  for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = resolve(path, entry.name);
    values.push({ name: entry.name, path: file, value: JSON.parse(await readFile(file, "utf8")) });
  }
  return values;
}

async function loadAiConfig(root) {
  let config;
  try {
    config = await readJson(process.env.EA_AI_CONFIG ? resolve(root, process.env.EA_AI_CONFIG) : resolve(root, "pipeline/config/ai.local.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = await readJson(resolve(root, "pipeline/config/ai.example.json"));
  }
  return config.ai ? config : { ai: config };
}

async function loadRoutes(root) {
  return readJson(resolve(root, "content/data/routes.json"));
}

async function loadEvents(root) {
  const entries = await readJsonDirectoryEntries(resolve(root, "content/data/events"));
  const map = new Map();
  for (const entry of entries) {
    for (const record of entry.value.records || [entry.value]) map.set(record.id, record);
  }
  return map;
}

async function loadEntities(root) {
  const entries = await readJsonDirectoryEntries(resolve(root, "content/data/entities"));
  const map = new Map();
  for (const entry of entries) {
    for (const record of entry.value.records || [entry.value]) map.set(record.id, record);
  }
  return map;
}

async function loadFacts(root) {
  const entries = await readJsonDirectoryEntries(resolve(root, "content/data/facts"));
  const bySubject = new Map();
  for (const entry of entries) {
    for (const record of entry.value.records || [entry.value]) {
      const facts = bySubject.get(record.subjectId) || new Map();
      facts.set(record.predicate, record);
      bySubject.set(record.subjectId, facts);
    }
  }
  return bySubject;
}

async function loadOperatorJurisdictionReport(root) {
  try {
    return await readJson(resolve(root, "private-legal/operator-jurisdiction-report.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function loadLegalSupportSummary(root) {
  const supportDir = resolve(root, "private-legal/support");
  const files = await readdir(supportDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const byJurisdiction = new Map();
  for (const entry of files.filter((value) => value.isFile() && value.name.endsWith(".json"))) {
    const fallbackJurisdiction = entry.name.replace(/\.json$/i, "");
    try {
      const value = await readJson(resolve(supportDir, entry.name));
      const normalized = normalizeLegalSupportRecord(value, fallbackJurisdiction);
      byJurisdiction.set(normalized.jurisdiction, {
        jurisdiction: normalized.jurisdiction,
        hasMaterial: supportRecordHasMaterial(normalized),
        operatorJurisdiction: normalized.operatorJurisdiction,
      });
    } catch {}
  }
  return { byJurisdiction };
}

async function previewAvailable(root, path) {
  if (!path) return false;
  try {
    await access(resolve(root, "dist/preview-zh", `.${path}`, "index.html"));
    return true;
  } catch {
    return false;
  }
}

async function reviewHtmlAvailable(root, workflow) {
  if (!workflow?.preview?.reviewHtmlPath) return false;
  try {
    await access(resolve(root, workflow.preview.reviewHtmlPath));
    return true;
  } catch {
    return false;
  }
}

function matchScore(item, evidence) {
  const edition = item.editions?.zh;
  if (!edition) return null;
  const homeNames = new Set([canonicalText(edition.homeName)]);
  const awayNames = new Set([canonicalText(edition.awayName)]);
  const event = evidence?.match;
  const homeTeam = canonicalText(event?.homeTeam);
  const awayTeam = canonicalText(event?.awayTeam);
  const score = [
    homeNames.has(homeTeam) ? 2 : 0,
    awayNames.has(awayTeam) ? 2 : 0,
  ].reduce((sum, value) => sum + value, 0);
  return score;
}

export function isReviewContentPacket(value) {
  return Boolean(value?.editions?.zh);
}

export function isEvidencePacket(value) {
  return Boolean(value?.match?.id);
}

export function previewRouteForItem(item, routes, locale = "zh") {
  return routePath({
    locale,
    sport: item.sport,
    routeKey: routeKeyForType(item.type),
    slug: item.editions?.[locale]?.slug,
    routes,
  });
}

export function applyEditionStatus(item, locale, status) {
  const next = structuredClone(item);
  const edition = next.editions?.[locale];
  if (!edition) throw new Error(`Missing locale edition: ${locale}`);
  edition.status = status;
  if (status === "needs_review") {
    edition.complianceStatus = "unreviewed";
    delete edition.allowedJurisdictions;
    delete edition.complianceValidUntil;
  }
  if (status === "quarantined") {
    edition.complianceStatus = "quarantined";
    delete edition.allowedJurisdictions;
    delete edition.complianceValidUntil;
  }
  next.reviewedAt = new Date().toISOString();
  return next;
}

function collectTeamNames(entity) {
  const names = new Set();
  if (entity?.canonicalName) names.add(canonicalText(entity.canonicalName));
  for (const name of entity?.aliases || []) names.add(canonicalText(name));
  for (const name of Object.values(entity?.names || {})) names.add(canonicalText(name));
  names.delete("");
  return names;
}

export function findRelatedEvidence(item, evidencePackets, eventMap = new Map(), entityMap = new Map()) {
  const event = eventMap.get(item.eventRefs?.[0]);
  const homeNames = new Set([canonicalText(item.editions?.zh?.homeName)]);
  const awayNames = new Set([canonicalText(item.editions?.zh?.awayName)]);
  for (const value of collectTeamNames(entityMap.get(event?.homeTeamId))) homeNames.add(value);
  for (const value of collectTeamNames(entityMap.get(event?.awayTeamId))) awayNames.add(value);
  const candidates = evidencePackets
    .map((candidate) => {
      const evidence = candidate.value;
      let score = 0;
      if (homeNames.has(canonicalText(evidence.match?.homeTeam))) score += 2;
      if (awayNames.has(canonicalText(evidence.match?.awayTeam))) score += 2;
      if (event?.startedAt && evidence.match?.startedAt && Date.parse(event.startedAt) === Date.parse(evidence.match.startedAt)) score += 1;
      if (event && Number.isFinite(event.homeScore) && Number.isFinite(event.awayScore)
        && event.homeScore === evidence.match?.homeScore && event.awayScore === evidence.match?.awayScore) score += 1;
      return { candidate, score };
    })
    .filter(({ score }) => score >= 4)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTime = Date.parse(left.candidate.value.match?.startedAt || 0);
      const rightTime = Date.parse(right.candidate.value.match?.startedAt || 0);
      if (event?.startedAt) {
        const target = Date.parse(event.startedAt);
        return Math.abs(leftTime - target) - Math.abs(rightTime - target);
      }
      return rightTime - leftTime;
    });
  return candidates[0]?.candidate || null;
}

function continuitySummary(evidence) {
  return (evidence?.personnelChanges || []).map((change) => ({
    teamName: change.teamName,
    continuityRate: change.continuityRate,
    sharedStarters: change.sharedStarters,
    currentStarters: change.currentStarters,
  }));
}

function metricsFromFacts(eventId, factMap) {
  const facts = factMap.get(eventId) || new Map();
  const h2h = facts.get("head_to_head_before_match")?.value || null;
  const personnel = facts.get("personnel_changes")?.value || [];
  const missing = [];
  if ((h2h?.matches || 0) === 0) missing.push("head_to_head_history");
  if (!personnel.length) missing.push("personnel_change_confirmation");
  return {
    h2hMatches: h2h?.matches ?? null,
    missing,
    continuity: continuitySummary({ personnelChanges: personnel }),
  };
}

function resolvedMetrics(eventId, evidence, factMap) {
  const evidenceMetrics = {
    h2hMatches: evidence?.headToHeadBeforeMatch?.matches ?? null,
    coreSourceConfirmations: evidence?.coreSourceConfirmations ?? null,
    missing: [...(evidence?.missing || [])],
    continuity: continuitySummary(evidence),
  };
  const factsMetrics = metricsFromFacts(eventId, factMap);
  const mergedMissing = new Set(evidenceMetrics.missing);
  if ((factsMetrics.h2hMatches || 0) > 0) mergedMissing.delete("head_to_head_history");
  if (factsMetrics.continuity.length) mergedMissing.delete("personnel_change_confirmation");
  return {
    h2hMatches: (factsMetrics.h2hMatches || 0) > 0 ? factsMetrics.h2hMatches : evidenceMetrics.h2hMatches,
    coreSourceConfirmations: evidenceMetrics.coreSourceConfirmations,
    missing: [...mergedMissing],
    continuity: factsMetrics.continuity.length ? factsMetrics.continuity : evidenceMetrics.continuity,
  };
}

async function summarizePacket(root, packet, routes, eventMap, entityMap, evidencePackets, factMap) {
  const relatedEvidence = findRelatedEvidence(packet.value, evidencePackets, eventMap, entityMap);
  const previewPath = previewRouteForItem(packet.value, routes, "zh");
  let workflow = await loadReviewWorkflow(root, packet.value);
  const eventId = packet.value.eventRefs?.[0];
  const stagedPath = resolve(root, "content/data/items", `${packet.value.id}.json`);
  let staged = false;
  let stagedItem = null;
  try {
    await access(stagedPath);
    staged = true;
    stagedItem = JSON.parse(await readFile(stagedPath, "utf8"));
  } catch {}
  const lifecycle = deriveReviewLifecycle(packet.value, {
    current: workflow.lifecycle,
    sourceItem: stagedItem,
    sourceItemPath: staged ? `content/data/items/${packet.value.id}.json` : null,
  });
  if (JSON.stringify(lifecycle) !== JSON.stringify(workflow.lifecycle || {})) {
    workflow = await mutateReviewWorkflow(root, packet.value, (current) => ({
      ...current,
      lifecycle,
    }));
  }
  const metrics = resolvedMetrics(eventId, relatedEvidence?.value || null, factMap);
  const entityJurisdictions = [...new Set((packet.value.entityRefs || [])
    .map((entityId) => entityMap.get(entityId))
    .map((entity) => entity?.attributes?.jurisdiction || entity?.attributes?.countryCode || entity?.attributes?.nationalityCode || "")
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
  return {
    id: packet.value.id,
    file: packet.name,
    path: packet.path,
    item: packet.value,
    edition: packet.value.editions.zh,
    event: eventMap.get(packet.value.eventRefs?.[0]) || null,
    evidence: relatedEvidence?.value || null,
    workflow,
    readiness: {
      previewPath,
      previewBuilt: await previewAvailable(root, previewPath),
      reviewHtmlBuilt: await reviewHtmlAvailable(root, workflow),
      staged,
    },
    entityJurisdictions,
    metrics,
  };
}

function comparePackets(left, right) {
  const statusOrder = ["review_pending", "editorial_approved", "release_requested", "release_review_required", "release_blocked", "release_ready", "published", "deleted", "quarantined"];
  const leftStatus = left.workflow?.status || left.edition.status;
  const rightStatus = right.workflow?.status || right.edition.status;
  const leftIndex = statusOrder.indexOf(leftStatus);
  const rightIndex = statusOrder.indexOf(rightStatus);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return Date.parse(packetModifiedAt(right)) - Date.parse(packetModifiedAt(left));
}

export function hasUnconfirmedOperatorJurisdiction(registry = {}) {
  return !registry.operatorJurisdictions?.length || registry.operatorJurisdictions.includes("ZZ");
}

export function summarizeReleaseFindings(findings = []) {
  const jurisdictions = new Set();
  const reasons = new Map();
  for (const finding of findings) {
    if (finding?.jurisdiction) jurisdictions.add(finding.jurisdiction);
    for (const reason of finding?.reasons || []) reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  return {
    jurisdictions: [...jurisdictions].sort(),
    reasonCounts: [...reasons.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([reason, count]) => ({ reason, count })),
  };
}

export function ensureLegalPackDrafts(registry = {}, jurisdictions = [], now = new Date()) {
  const existing = new Map((registry.packs || []).map((pack) => [pack.jurisdiction, pack]));
  const created = [];
  const packs = [...(registry.packs || [])];
  for (const jurisdiction of [...new Set(jurisdictions.map((value) => String(value || "").trim().toUpperCase()).filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort()) {
    if (existing.has(jurisdiction)) continue;
    packs.push({
      jurisdiction,
      status: "draft",
      reviewedAt: null,
      expiresAt: null,
      counsel: {
        name: "",
        barJurisdiction: "",
        signatureHash: "",
      },
      officialSources: [],
      notes: [`Draft scaffold generated on ${now.toISOString()}. Replace with counsel-approved materials before publication.`],
    });
    created.push(jurisdiction);
  }
  return {
    registry: {
      ...registry,
      packs,
    },
    created,
  };
}

export function parseLegalPackLines(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseOfficialSourcesInput(text = "") {
  return parseLegalPackLines(text).map((line) => {
    const [url = "", checkedAt = "", contentHash = ""] = line.split("|").map((value) => value.trim());
    return { url, checkedAt, contentHash };
  });
}

export function serializeOfficialSourcesInput(sources = []) {
  return (sources || []).map((source) => [source?.url || "", source?.checkedAt || "", source?.contentHash || ""].join(" | ")).join("\n");
}

export function normalizeLegalSupportRecord(value = {}, fallbackJurisdiction = "") {
  const jurisdiction = String(value.jurisdiction || fallbackJurisdiction || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") {
    throw new Error("support 材料里的 jurisdiction 必须是已确认的两位代码，且不能是 ZZ");
  }
  const officialSources = Array.isArray(value.officialSources)
    ? value.officialSources.map((source) => ({
      url: String(source?.url || "").trim(),
      checkedAt: String(source?.checkedAt || "").trim(),
      contentHash: String(source?.contentHash || "").trim(),
    })).filter((source) => source.url || source.checkedAt || source.contentHash)
    : parseOfficialSourcesInput(value.officialSourcesText || "");
  const notes = Array.isArray(value.notes)
    ? value.notes.map((entry) => String(entry || "").trim()).filter(Boolean)
    : parseLegalPackLines(value.notesText || "");
  return {
    jurisdiction,
    status: value.status === "active" ? "active" : "draft",
    reviewedAt: String(value.reviewedAt || "").trim(),
    expiresAt: String(value.expiresAt || "").trim(),
    counselName: String(value.counsel?.name || value.counselName || "").trim(),
    counselBarJurisdiction: String(value.counsel?.barJurisdiction || value.counselBarJurisdiction || "").trim().toUpperCase(),
    counselSignatureHash: String(value.counsel?.signatureHash || value.counselSignatureHash || "").trim(),
    officialSourcesText: serializeOfficialSourcesInput(officialSources),
    notesText: notes.join("\n"),
    operatorJurisdiction: Boolean(value.operatorJurisdiction || value.confirmOperatorJurisdiction),
  };
}

export function supportRecordHasMaterial(value = {}) {
  const normalized = value?.jurisdiction ? value : normalizeLegalSupportRecord(value, value?.jurisdiction || "");
  return Boolean(
    String(normalized.reviewedAt || "").trim()
    || String(normalized.expiresAt || "").trim()
    || String(normalized.counselName || "").trim()
    || String(normalized.counselBarJurisdiction || "").trim()
    || String(normalized.counselSignatureHash || "").trim()
    || parseOfficialSourcesInput(normalized.officialSourcesText || "").length
  );
}

export function importLegalSupportRecord(registry = {}, value = {}, fallbackJurisdiction = "") {
  const normalized = normalizeLegalSupportRecord(value, fallbackJurisdiction);
  return {
    normalized,
    registry: upsertLegalPack(registry, normalized),
  };
}

export function detectOperatorJurisdictionFromSupportRecords(records = []) {
  const jurisdictions = [...new Set((records || [])
    .filter((record) => record?.operatorJurisdiction)
    .map((record) => String(record.jurisdiction || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
  return {
    detectedJurisdiction: jurisdictions.length === 1 ? jurisdictions[0] : null,
    ambiguous: jurisdictions.length > 1,
    jurisdictions,
  };
}

export function buildLegalSupportTemplate(existingPack = null, jurisdiction = "", { operatorJurisdiction = false } = {}) {
  const code = String(jurisdiction || existingPack?.jurisdiction || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") {
    throw new Error("support 骨架需要真实的两位辖区代码，且不能是 ZZ");
  }
  const officialSources = Array.isArray(existingPack?.officialSources)
    ? existingPack.officialSources
      .map((source) => ({
        url: String(source?.url || "").trim(),
        checkedAt: String(source?.checkedAt || "").trim(),
        contentHash: String(source?.contentHash || "").trim(),
      }))
      .filter((source) => source.url || source.checkedAt || source.contentHash)
    : [];
  return {
    jurisdiction: code,
    status: existingPack?.status === "active" ? "active" : "draft",
    operatorJurisdiction,
    reviewedAt: String(existingPack?.reviewedAt || "").trim(),
    expiresAt: String(existingPack?.expiresAt || "").trim(),
    counsel: {
      name: String(existingPack?.counsel?.name || "").trim(),
      barJurisdiction: String(existingPack?.counsel?.barJurisdiction || "").trim().toUpperCase(),
      signatureHash: String(existingPack?.counsel?.signatureHash || "").trim(),
    },
    officialSources,
    notes: (existingPack?.notes?.length
      ? existingPack.notes
      : ["Replace every placeholder with real counsel-approved material before relying on this support file."])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  };
}

function plainTextFromHtml(text = "") {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function regionAliases(code) {
  const aliases = new Set();
  try {
    const region = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    if (region) aliases.add(region.toLowerCase());
  } catch {}
  for (const alias of ({
    AE: ["united arab emirates"],
    GB: ["united kingdom", "great britain", "england and wales"],
    HK: ["hong kong", "hong kong sar"],
    IR: ["iran", "islamic republic of iran"],
    KR: ["south korea", "republic of korea"],
    MO: ["macao", "macau", "macao sar china", "macau sar china"],
    TW: ["taiwan"],
    US: ["united states", "united states of america"],
  }[code] || [])) aliases.add(alias);
  return [...aliases];
}

function normalizeRegionValue(value = "") {
  return String(value || "").trim().toLowerCase();
}

function matchingJurisdictionCodes(value, uniqueCodes = []) {
  const normalized = normalizeRegionValue(value);
  if (!normalized) return [];
  return uniqueCodes.filter((code) => normalized === code.toLowerCase() || regionAliases(code).some((alias) => alias && normalized.includes(alias)));
}

function extractJsonLdPayloads(html = "") {
  const payloads = [];
  for (const match of String(html || "").matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      payloads.push(JSON.parse(raw));
    } catch {}
  }
  return payloads;
}

function collectJsonLdJurisdictionFindings(source, uniqueCodes = []) {
  const findings = [];
  let contextualCount = 0;
  const orgLikeTypes = new Set(["organization", "corporation", "localbusiness", "newsmediaorganization", "newsorganization"]);
  const visit = (node, context = { orgLike: false }) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, context);
      return;
    }
    if (!node || typeof node !== "object") return;
    const types = [node["@type"]].flat().filter(Boolean).map((value) => String(value).toLowerCase());
    const orgLike = context.orgLike || types.some((value) => orgLikeTypes.has(value));
    const candidateFields = orgLike ? [
      ["jurisdiction", node.jurisdiction],
      ["addressCountry", node.addressCountry],
      ["country", node.country],
      ["address.addressCountry", node.address?.addressCountry],
      ["location.addressCountry", node.location?.address?.addressCountry],
      ["publisher.address.addressCountry", node.publisher?.address?.addressCountry],
      ["provider.address.addressCountry", node.provider?.address?.addressCountry],
    ] : [];
    for (const [field, value] of candidateFields) {
      if (value == null) continue;
      contextualCount += 1;
      for (const code of matchingJurisdictionCodes(value, uniqueCodes)) {
        findings.push({
          jurisdiction: code,
          sourceUrl: source?.url || "",
          evidence: `JSON-LD ${field}=${String(value).slice(0, 160)}`,
        });
      }
    }
    for (const value of Object.values(node)) visit(value, { orgLike });
  };
  for (const payload of extractJsonLdPayloads(source?.text || "")) visit(payload);
  return { findings, contextualCount };
}

export function collectOperatorJurisdictionWeakSignals(sources = []) {
  const patterns = [
    /legal@eventanalysis\.org/i,
    /independent static publication/i,
    /no live scores, accounts, comments or user tracking/i,
    /©\s*20\d{2}\s*eventanalysis\.org/i,
  ];
  const signals = [];
  for (const source of sources) {
    const lines = plainTextFromHtml(source?.text || "").split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (!patterns.some((pattern) => pattern.test(line))) continue;
      signals.push({
        sourceUrl: source?.url || "",
        evidence: line.slice(0, 220),
      });
    }
  }
  const seen = new Set();
  return signals.filter((signal) => {
    const key = `${signal.sourceUrl}::${signal.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

export function detectOperatorJurisdictionFromTexts(sources = [], candidateCodes = []) {
  const contexts = /(registered|incorporated|governed by the laws|laws of|publisher jurisdiction|operator jurisdiction|based in|organized under the laws|company registered)/i;
  const findings = [];
  let contextualSourceCount = 0;
  let contextualLineCount = 0;
  const uniqueCodes = [...new Set(candidateCodes.filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
  for (const source of sources) {
    const jsonLd = collectJsonLdJurisdictionFindings(source, uniqueCodes);
    if (jsonLd.contextualCount > 0) {
      contextualSourceCount += 1;
      contextualLineCount += jsonLd.contextualCount;
      findings.push(...jsonLd.findings);
    }
    const lines = plainTextFromHtml(source?.text || "").split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter(Boolean);
    let sourceHadContext = false;
    for (const line of lines) {
      if (!contexts.test(line)) continue;
      sourceHadContext = true;
      contextualLineCount += 1;
      const normalized = line.toLowerCase();
      for (const code of uniqueCodes) {
        if (regionAliases(code).some((alias) => alias && normalized.includes(alias))) {
          findings.push({
            jurisdiction: code,
            sourceUrl: source?.url || "",
            evidence: line.slice(0, 220),
          });
        }
      }
    }
    if (sourceHadContext && jsonLd.contextualCount === 0) contextualSourceCount += 1;
  }
  const dedupedFindings = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = `${finding.jurisdiction}::${finding.sourceUrl}::${finding.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedFindings.push(finding);
  }
  const jurisdictions = [...new Set(dedupedFindings.map((entry) => entry.jurisdiction))];
  return {
    detectedJurisdiction: jurisdictions.length === 1 ? jurisdictions[0] : null,
    ambiguous: jurisdictions.length > 1,
    findings: dedupedFindings,
    jurisdictions,
    contextualSourceCount,
    contextualLineCount,
  };
}

export function upsertLegalPack(registry = {}, input = {}) {
  const jurisdiction = String(input.jurisdiction || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") throw new Error("legal pack 辖区必须是已确认的两位代码，且不能继续使用 ZZ");
  const packs = [...(registry.packs || [])];
  const index = packs.findIndex((pack) => pack.jurisdiction === jurisdiction);
  const existing = index === -1 ? null : packs[index];
  const next = {
    jurisdiction,
    status: input.status === "active" ? "active" : "draft",
    reviewedAt: String(input.reviewedAt || "").trim() || null,
    expiresAt: String(input.expiresAt || "").trim() || null,
    counsel: {
      name: String(input.counselName || "").trim(),
      barJurisdiction: String(input.counselBarJurisdiction || "").trim().toUpperCase(),
      signatureHash: String(input.counselSignatureHash || "").trim(),
    },
    officialSources: parseOfficialSourcesInput(input.officialSourcesText || ""),
    notes: parseLegalPackLines(input.notesText || ""),
  };
  if (!next.notes.length && existing?.notes?.length) next.notes = existing.notes;
  if (!next.notes.length) next.notes = ["Edited in review admin. Fill with counsel-approved materials before publication."];
  if (index === -1) packs.push(next);
  else packs[index] = next;
  return {
    ...registry,
    packs: packs.sort((left, right) => left.jurisdiction.localeCompare(right.jurisdiction)),
  };
}

export function autoActivateLegalPack(pack, policy = {}, now = new Date()) {
  if (!pack) return { pack, activated: false };
  if (pack.status === "active") return { pack, activated: false };
  const candidate = { ...pack, status: "active" };
  const validation = validateLegalPack(candidate, policy, now);
  if (!validation.ok) return { pack, activated: false };
  return { pack: candidate, activated: true };
}

export function autoActivateRegistryLegalPack(registry = {}, jurisdiction = "", policy = {}, now = new Date()) {
  const code = String(jurisdiction || "").trim().toUpperCase();
  const packs = [...(registry.packs || [])];
  const index = packs.findIndex((pack) => pack.jurisdiction === code);
  if (index === -1) return { registry, activated: false };
  const result = autoActivateLegalPack(packs[index], policy, now);
  if (!result.activated) return { registry, activated: false };
  packs[index] = result.pack;
  return {
    activated: true,
    registry: {
      ...registry,
      packs,
    },
  };
}

export function collectLegalDraftCandidateJurisdictions(registry = {}, items = []) {
  const candidates = new Set();
  for (const code of registry.coverageQueue?.targetMarkets || []) candidates.add(String(code || "").trim().toUpperCase());
  for (const code of registry.coverageQueue?.currentContentNexus || []) candidates.add(String(code || "").trim().toUpperCase());
  for (const code of registry.coverageQueue?.operator || []) candidates.add(String(code || "").trim().toUpperCase());
  for (const code of registry.operatorJurisdictions || []) candidates.add(String(code || "").trim().toUpperCase());
  for (const item of items) {
    for (const code of summarizeReleaseFindings(item.workflow?.release?.findings || []).jurisdictions) candidates.add(String(code || "").trim().toUpperCase());
  }
  return [...candidates].filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ").sort();
}

function unresolvedBlockedLegalJurisdictions(findings, packValidation = new Map()) {
  return findings.jurisdictions.filter((jurisdiction) => jurisdiction !== "ZZ" && !packValidation.get(jurisdiction)?.ok);
}

function prioritizeJurisdictions(jurisdictions = [], registry = {}) {
  const unique = [...new Set((jurisdictions || []).map((value) => String(value || "").trim().toUpperCase()).filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))].sort();
  const operator = String(registry.operatorJurisdictions?.[0] || "").trim().toUpperCase();
  if (!unique.length || !/^[A-Z]{2}$/.test(operator) || operator === "ZZ" || !unique.includes(operator)) return unique;
  return [operator, ...unique.filter((value) => value !== operator)];
}

function currentApplicableJurisdictions(item, registry = {}) {
  const codes = new Set();
  for (const code of item.item?.nexusJurisdictions || []) codes.add(String(code || "").trim().toUpperCase());
  for (const code of item.entityJurisdictions || []) codes.add(String(code || "").trim().toUpperCase());
  for (const code of registry.operatorJurisdictions || []) codes.add(String(code || "").trim().toUpperCase());
  return prioritizeJurisdictions([...codes], registry);
}

function unresolvedCurrentLegalJurisdictions(item, registry = {}, packValidation = new Map()) {
  return currentApplicableJurisdictions(item, registry).filter((jurisdiction) => !packValidation.get(jurisdiction)?.ok);
}

export function blockedAutomationLimits({
  operatorConfirmed,
  operatorReport,
  currentInvalidPackCodes,
  currentCanRetry,
}) {
  const reasons = [];
  if (!operatorConfirmed) {
    reasons.push(operatorReport?.mode === "user_supplied_urls"
      ? "发布主体辖区仍未自动确认，因为最近一次外部公开证据 URL 扫描没有找到唯一明确辖区。"
      : "发布主体辖区仍未自动确认，因为当前公开页面里没有唯一明确的主体辖区表述。");
  }
  if (currentInvalidPackCodes.length) {
    reasons.push(`${currentInvalidPackCodes.join("、")} 的 legal pack 仍缺真实日期、律师签名或官方来源，系统不能代填这些字段。`);
  }
  if (!currentCanRetry) {
    reasons.push("在上述真实材料补齐前，系统不会显示重新提交中文发布申请。");
  }
  return reasons;
}

export function blockedItemResolutionStage({
  operatorConfirmed,
  currentCanRetry,
  currentNeedsDrafts,
  currentNeedsSupport = false,
  currentPrimaryPackCode,
}) {
  if (currentCanRetry) return "retry";
  if (!operatorConfirmed) return "operator";
  if (currentNeedsDrafts) return "drafts";
  if (currentNeedsSupport) return "support";
  if (currentPrimaryPackCode) return "pack";
  return "detail";
}

export function retargetLegalReturnTo(returnTo = "/", pack = "") {
  const jurisdiction = String(pack || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction) || jurisdiction === "ZZ") return returnTo || "/";
  const url = new URL(returnTo || "/", "http://127.0.0.1");
  if (url.pathname !== "/legal") return `${url.pathname}${url.search}${url.hash}`;
  url.searchParams.set("pack", jurisdiction);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function nextBlockedLegalPack(jurisdictions = [], currentPack = "") {
  const codes = [...new Set((jurisdictions || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))];
  if (!codes.length) return "";
  const current = String(currentPack || "").trim().toUpperCase();
  if (!current || !codes.includes(current)) return codes[0];
  const index = codes.indexOf(current);
  return codes[index + 1] || "";
}

function blockedPackSequenceText(jurisdictions = []) {
  const codes = [...new Set((jurisdictions || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))];
  if (!codes.length) return "处理 legal pack";
  if (codes.length === 1) return `先补 ${codes[0]} legal pack`;
  if (codes.length === 2) return `先补 ${codes[0]} legal pack，再补 ${codes[1]} legal pack`;
  return `先补 ${codes[0]} legal pack，再依次补 ${codes.slice(1).join("、")} legal pack`;
}

function editorBlockedSummary(item, missingFacts = []) {
  if (missingFacts.length) return `事实上次检查没有通过，仍缺：${missingFacts.join("、")}。`;
  if (item.workflow?.release?.commandError) return "上一次后台执行没有完成，需要重新触发一次检查。";
  return "上一次后台发布检查没有通过，但公开站点仍未发布。";
}

export function buildItemWorkflowGuidance(item, registry = {}, { packValidation = new Map(), operatorJurisdictionReport = null, supportByJurisdiction = new Map() } = {}) {
  const status = item.workflow?.status || "review_pending";
  const missingFacts = item.metrics?.missing || [];
  const reviewHtmlBuilt = Boolean(item.readiness?.reviewHtmlBuilt);
  const previewBuilt = Boolean(item.readiness?.previewBuilt);
  const findings = summarizeReleaseFindings(item.workflow?.release?.findings || []);
  const operatorJurisdictionUnconfirmed = hasUnconfirmedOperatorJurisdiction(registry);
  const blockedLegalJurisdictions = unresolvedCurrentLegalJurisdictions(item, registry, packValidation);
  const resolvedLegalJurisdictions = findings.jurisdictions.filter((jurisdiction) => jurisdiction !== "ZZ" && packValidation.get(jurisdiction)?.ok);
  const base = {
    stateLabel: status,
    why: item.workflow?.summary || "等待工作流更新。",
    nextStep: "查看稿件详情。",
    resolveHref: `/items/${encodeURIComponent(item.id)}`,
    primaryAction: null,
    secondaryActions: [],
    blockers: [],
  };

  if (status === "review_pending") {
    return {
      ...base,
      stateLabel: "待编辑一键通过",
      why: reviewHtmlBuilt ? "审稿材料已就绪，编辑可以直接一键通过。" : "还没有私有静态审稿页；一键通过时系统会自动补生成。",
      nextStep: "点击一键审稿通过。系统会自动批准中文、生成私有审稿页，并提交后台预审与本地预发检查。",
      primaryAction: { type: "form", action: "approve_and_submit_zh", label: "一键审稿通过" },
      secondaryActions: [],
      blockers: missingFacts.length ? [`事实包缺口：${missingFacts.join("、")}`] : [],
    };
  }

  if (status === "editorial_approved") {
    return {
      ...base,
      stateLabel: "待一键流转",
      why: reviewHtmlBuilt ? "中文主稿已批准，等待进入后台检查。" : "中文主稿已批准，但还没有私有静态审稿页；一键流转时系统会自动补生成。",
      nextStep: "点击一键审稿通过，系统会继续生成缺失审稿页并提交后台预审与本地预发。",
      primaryAction: { type: "form", action: "approve_and_submit_zh", label: "一键审稿通过" },
      secondaryActions: [],
      blockers: missingFacts.length ? [`事实包缺口：${missingFacts.join("、")}`] : [],
    };
  }

  if (status === "release_requested") {
    return {
      ...base,
      stateLabel: "发布申请处理中",
      why: "后台正在执行独立预审和中文本地预发。",
      nextStep: "等待后台结果自动刷新。",
      resolveHref: `/items/${encodeURIComponent(item.id)}`,
    };
  }

  if (status === "release_blocked") {
    const factsResolveHref = `/items/${encodeURIComponent(item.id)}`;
    const blockers = [];
    blockers.push(editorBlockedSummary(item, missingFacts));
    if (missingFacts.length) blockers.push(`事实包缺口仍未补齐：${missingFacts.join("、")}。`);
    return {
      ...base,
      stateLabel: "系统中断（未发布）",
      why: `这次只是后台发布申请被系统中断，公开站点并未新增发布。${blockers[0]}`,
      nextStep: missingFacts.length
        ? "先回稿件详情补齐事实包，随后直接重新一键审核通过。"
        : "直接重新一键审核通过，系统会重跑后台预审与中文本地预发。",
      resolveHref: factsResolveHref,
      primaryAction: missingFacts.length
        ? { type: "link", href: factsResolveHref, label: "去补事实包" }
        : { type: "form", action: "approve_and_submit_zh", label: "重新一键审核通过" },
      secondaryActions: [],
      blockers,
    };
  }

  if (status === "release_review_required") {
    return {
      ...base,
      stateLabel: "待人工复核",
      why: item.workflow?.summary || "独立预审要求人工复核。",
      nextStep: "创建私有草稿 PR，转人工复核。",
      primaryAction: { type: "form", action: "review_pr", label: "创建草稿 PR" },
      secondaryActions: [],
      blockers: missingFacts.length ? [`事实包缺口：${missingFacts.join("、")}`] : [],
    };
  }

  if (status === "release_ready") {
    return {
      ...base,
      stateLabel: "已完成本地预发",
      why: previewBuilt ? "中文本地预发页已生成，可以交付发物审核。" : "合规已经通过，但本地预发页还未找到。",
      nextStep: "创建私有草稿 PR，进入发物审核。",
      primaryAction: { type: "form", action: "review_pr", label: "创建草稿 PR" },
      secondaryActions: previewBuilt ? [] : [{ type: "form", action: "build_review_html", label: "补生成审稿 HTML" }],
      blockers: missingFacts.length ? [`事实包缺口：${missingFacts.join("、")}`] : [],
    };
  }

  if (status === "published") {
    return {
      ...base,
      stateLabel: "已发布",
      why: item.workflow?.summary || "稿件已经正式发布，后续可继续跟踪改版。",
      nextStep: "如需更新内容，重新生成或编辑草稿并再次提交发布链路。",
      primaryAction: null,
      secondaryActions: [],
      blockers: [],
    };
  }

  if (status === "deleted") {
    return {
      ...base,
      stateLabel: "已删除",
      why: item.workflow?.summary ? `稿件已删除。${item.workflow.summary}` : "稿件已删除，当前保留状态记录供后续会话继续跟踪。",
      nextStep: "如需恢复发布，重新生成新草稿并走完整发布链路。",
      primaryAction: null,
      secondaryActions: [],
      blockers: [],
    };
  }

  if (status === "quarantined") {
    return {
      ...base,
      stateLabel: "已隔离",
      why: item.workflow?.summary || "稿件已被隔离，不能继续发物流转。",
      nextStep: "如需继续，先退回待审并重新完成审稿。",
      primaryAction: { type: "form", action: "reset_zh", label: "退回待审" },
      secondaryActions: [],
      blockers: [],
    };
  }

  return base;
}

export async function loadReviewAdminState(root) {
  const [routes, eventMap, entityMap, factMap, ai, policy, registry, operatorJurisdictionReport, supportSummary, packetEntries] = await Promise.all([
    loadRoutes(root),
    loadEvents(root),
    loadEntities(root),
    loadFacts(root),
    loadAiConfig(root),
    loadCompliancePolicy(root),
    loadLegalRegistry(root, { required: false }),
    loadOperatorJurisdictionReport(root),
    loadLegalSupportSummary(root),
    readJsonDirectoryEntries(resolve(root, "content/review-packets")),
  ]);
  const readiness = summarizeAutomationReadiness({ config: ai, policy, registry });
  const activePackets = packetEntries.filter((entry) => !entry.name.endsWith(".published.json"));
  const evidencePackets = activePackets.filter((entry) => isEvidencePacket(entry.value));
  const contentPackets = activePackets.filter((entry) => isReviewContentPacket(entry.value));
  const items = await Promise.all(contentPackets.map((packet) => summarizePacket(root, packet, routes, eventMap, entityMap, evidencePackets, factMap)));
  items.sort(comparePackets);
  const packValidation = new Map((registry.packs || []).map((pack) => [pack.jurisdiction, validateLegalPack(pack, policy)]));
  for (const item of items) {
    item.guidance = buildItemWorkflowGuidance(item, registry, { packValidation, operatorJurisdictionReport, supportByJurisdiction: supportSummary.byJurisdiction });
    item.legal = {
      operatorJurisdictionUnconfirmed: hasUnconfirmedOperatorJurisdiction(registry),
      blockedJurisdictions: unresolvedCurrentLegalJurisdictions(item, registry, packValidation),
    };
  }
  const counts = items.reduce((accumulator, item) => {
    accumulator.total += 1;
    accumulator[item.edition.status] = (accumulator[item.edition.status] || 0) + 1;
    return accumulator;
  }, { total: 0, needs_review: 0, approved: 0, quarantined: 0, published: 0, withdrawn: 0 });
  const workflowCounts = items.reduce((accumulator, item) => {
    accumulator.total += 1;
    const status = item.workflow?.status || "review_pending";
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {
    total: 0,
    review_pending: 0,
    editorial_approved: 0,
    release_requested: 0,
    release_review_required: 0,
    release_blocked: 0,
    release_ready: 0,
    published: 0,
    deleted: 0,
    quarantined: 0,
  });
  const lifecycleCounts = items.reduce((accumulator, item) => {
    accumulator.total += 1;
    const status = item.workflow?.lifecycle?.status || "draft";
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {
    total: 0,
    draft: 0,
    edited_pending_publish: 0,
    published: 0,
    deleted: 0,
  });
  return { readiness, counts, workflowCounts, lifecycleCounts, items, registry, policy, packValidation, operatorJurisdictionReport, supportSummary };
}

export async function loadReviewAdminItem(root, id) {
  const state = await loadReviewAdminState(root);
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return null;
  return { ...state, current: item };
}

export async function loadReviewAdminItemByFile(root, fileName) {
  const state = await loadReviewAdminState(root);
  const item = state.items.find((candidate) => candidate.file === fileName);
  if (!item) return null;
  return { ...state, current: item };
}

export async function writeReviewPacket(root, fileName, item) {
  const path = resolve(root, "content/review-packets", fileName);
  await writeFile(path, `${JSON.stringify(item, null, 2)}\n`);
  return path;
}

export async function updateReviewPacketStatus(root, fileName, locale, status) {
  const path = resolve(root, "content/review-packets", fileName);
  const item = JSON.parse(await readFile(path, "utf8"));
  if (!isReviewContentPacket(item)) throw new Error(`Not a review content packet: ${fileName}`);
  const next = applyEditionStatus(item, locale, status);
  await writeReviewPacket(root, fileName, next);
  return next;
}
