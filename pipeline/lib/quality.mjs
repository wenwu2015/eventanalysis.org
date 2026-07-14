import { createHash } from "node:crypto";

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(value, locale = "en") {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  try {
    return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(normalized)]
      .filter(({ isWordLike }) => isWordLike)
      .map(({ segment }) => segment);
  } catch {
    return normalized.split(" ").filter(Boolean);
  }
}

export function hashText(value) {
  return createHash("sha256").update(normalizeText(value)).digest("hex");
}

export function shingleSet(value, size = 5, locale = "en") {
  const words = tokens(value, locale);
  if (words.length < size) return new Set(words.length ? [words.join(" ")] : []);
  return new Set(Array.from({ length: words.length - size + 1 }, (_, index) => words.slice(index, index + size).join(" ")));
}

export function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

export function lexicalSimilarity(left, right, locale = "en") {
  return jaccard(shingleSet(left, 5, locale), shingleSet(right, 5, locale));
}

function hashIndex(value, dimensions) {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) % dimensions;
}

export function semanticVector(value, locale = "en", dimensions = 512) {
  const normalized = normalizeText(value);
  const vector = new Float64Array(dimensions);
  const features = [...tokens(normalized, locale)];
  const compact = normalized.replace(/\s+/g, "");
  for (let index = 0; index <= compact.length - 3; index += 1) features.push(`#${compact.slice(index, index + 3)}`);
  for (const feature of features) vector[hashIndex(feature, dimensions)] += 1;
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / magnitude);
}

export function cosineSimilarity(left, right) {
  let value = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) value += left[index] * right[index];
  return value;
}

export function longestConsecutiveTokenOverlap(left, right, locale = "en") {
  const a = tokens(left, locale);
  const b = tokens(right, locale);
  const row = new Uint32Array(b.length + 1);
  let longest = 0;
  for (let i = 1; i <= a.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = a[i - 1] === b[j - 1] ? previous + 1 : 0;
      if (row[j] > longest) longest = row[j];
      previous = saved;
    }
  }
  return longest;
}

export function editionText(edition) {
  return [edition.title, edition.deck, ...(edition.sections || []).flatMap((section) => [section.title, ...(section.paragraphs || []).map(({ text }) => text)])].join("\n");
}

function claimKeys(item) {
  return new Set((item.claims || []).map((claim) => `${claim.kind}:${[...(claim.factRefs || [])].sort().join(",")}`));
}

export function claimOverlap(left, right) {
  return jaccard(claimKeys(left), claimKeys(right));
}

function scriptRatio(text, pattern) {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (!letters.length) return 0;
  return letters.filter((char) => pattern.test(char)).length / letters.length;
}

export function languageLooksValid(locale, text) {
  const patterns = {
    zh: /\p{Script=Han}/u, "zh-hant": /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    ko: /\p{Script=Hangul}/u, ru: /\p{Script=Cyrillic}/u, sr: /\p{Script=Cyrillic}/u, uk: /\p{Script=Cyrillic}/u,
    ar: /\p{Script=Arabic}/u, fa: /\p{Script=Arabic}/u,
  };
  const pattern = patterns[locale] || /\p{Script=Latin}/u;
  return scriptRatio(text, pattern) >= (patterns[locale] ? 0.35 : 0.55);
}

function independentSecondReview(item) {
  return Boolean(item.qualityReview?.reviewer && item.qualityReview.reviewer !== item.author && item.qualityReview.decision === "approved");
}

export function auditEdition({ item, locale, edition, corpus = [], sources = [], policy }) {
  const body = editionText(edition);
  const bodyHash = hashText(body);
  const titleHash = hashText(edition.title);
  const deckHash = hashText(edition.deck);
  const paragraphHashes = new Set((edition.sections || []).flatMap((section) => (section.paragraphs || []).map(({ text }) => hashText(text))));
  const bodyShingles = shingleSet(body, 5, locale);
  const bodyVector = semanticVector(body, locale);
  const bodyClaimKeys = claimKeys(item);
  const findings = [];
  if (!languageLooksValid(locale, body)) findings.push({ severity: "BLOCK", code: "language_mismatch", detail: locale });
  if (!edition.sections?.length || !(item.claims || []).length) findings.push({ severity: "BLOCK", code: "missing_editorial_structure" });
  for (const source of sources) {
    const overlap = longestConsecutiveTokenOverlap(body, source.text || "", locale);
    if (overlap >= policy.sourceConsecutiveTokensBlock) findings.push({ severity: "BLOCK", code: "source_contiguous_overlap", overlap, sourceId: source.sourceId });
  }

  const similarities = [];
  for (const candidate of corpus.filter((entry) => entry.contentId !== item.id && entry.locale === locale)) {
    const exactParagraph = (candidate.paragraphHashes || []).some((hash) => paragraphHashes.has(hash));
    const exact = bodyHash === candidate.bodyHash || titleHash === candidate.titleHash || deckHash === candidate.deckHash || exactParagraph;
    const lexical = jaccard(bodyShingles, candidate.shingles || shingleSet(candidate.body, 5, candidate.locale));
    const claims = jaccard(bodyClaimKeys, candidate.claimKeys || claimKeys(candidate.item));
    const semantic = lexical >= policy.lexicalReview || claims >= policy.claimOverlapReview
      ? cosineSimilarity(bodyVector, candidate.vector || semanticVector(candidate.body, candidate.locale))
      : 0;
    const intent = item.primaryIntentKey === candidate.item.primaryIntentKey;
    const sameEvents = (item.eventRefs || []).some((id) => (candidate.item.eventRefs || []).includes(id));
    const result = { contentId: candidate.contentId, locale: candidate.locale, exact, lexical, semantic, claims, intent, sameEvents };
    similarities.push(result);
    if (exact) findings.push({ severity: "BLOCK", code: "exact_duplicate", ...result });
    if (intent) findings.push({ severity: "BLOCK", code: "duplicate_primary_intent", ...result });
    if (lexical >= policy.lexicalBlock) findings.push({ severity: "BLOCK", code: "lexical_duplicate", ...result });
    if (semantic >= policy.semanticBlock && claims >= policy.claimOverlapBlock) findings.push({ severity: "BLOCK", code: "semantic_claim_duplicate", ...result });
    if (sameEvents && ["match_analysis", "moment_analysis"].includes(item.type) && ["match_analysis", "moment_analysis"].includes(candidate.item.type)) {
      const priorAnalysis = new Set((candidate.item.claims || []).filter(({ kind }) => kind === "analysis").map(({ summary }) => normalizeText(summary)));
      const newClaims = (item.claims || []).filter(({ kind, summary }) => kind === "analysis" && !priorAnalysis.has(normalizeText(summary))).length;
      if (newClaims < policy.minimumNewAnalysisClaimsForSameEvent) findings.push({ severity: "BLOCK", code: "insufficient_new_analysis_claims", newClaims, ...result });
    }
    if (lexical >= policy.lexicalReview || (semantic >= policy.semanticReview && claims >= policy.claimOverlapReview)) findings.push({ severity: "REVIEW", code: "medium_similarity", ...result });
  }
  const hasBlock = findings.some(({ severity }) => severity === "BLOCK");
  const hasReview = findings.some(({ severity }) => severity === "REVIEW");
  const reviewSatisfied = independentSecondReview(item);
  const status = hasBlock ? "BLOCK" : hasReview && !reviewSatisfied ? "REVIEW" : "PASS";
  return {
    policyVersion: policy.version,
    contentId: item.id,
    locale,
    status,
    reviewedBy: item.qualityReview?.reviewer || null,
    originalContribution: item.originalContribution,
    findings,
    mostSimilar: similarities.sort((a, b) => Math.max(b.lexical, b.semantic) - Math.max(a.lexical, a.semantic)).slice(0, 5),
  };
}

export function buildCorpus(data) {
  const corpus = [];
  for (const item of data.items) for (const [locale, edition] of Object.entries(item.editions || {})) {
    if (!["approved", "published"].includes(edition.status)) continue;
    const body = editionText(edition);
    corpus.push({ contentId: item.id, locale, item, edition, body, bodyHash: hashText(body), titleHash: hashText(edition.title), deckHash: hashText(edition.deck), paragraphHashes: (edition.sections || []).flatMap((section) => (section.paragraphs || []).map(({ text }) => hashText(text))), shingles: shingleSet(body, 5, locale), claimKeys: claimKeys(item), vector: semanticVector(body, locale) });
  }
  return corpus;
}
