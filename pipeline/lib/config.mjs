import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadPipelineConfig() {
  const policy = await readJson(resolve(root, "pipeline/config/policy.json"));
  let sourcePath = resolve(root, "pipeline/config/sources.local.json");
  let aiPath = resolve(root, "pipeline/config/ai.local.json");
  let sources;
  let ai;
  try {
    sources = await readJson(sourcePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sourcePath = resolve(root, "pipeline/config/sources.example.json");
    sources = await readJson(sourcePath);
  }
  try {
    ai = await readJson(aiPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    aiPath = resolve(root, "pipeline/config/ai.example.json");
    ai = await readJson(aiPath);
  }
  const defaults = sources.defaults || {};
  const normalizedSources = sources.sources.map((source) => ({
    ...defaults,
    ...source,
    license: { ...(defaults.license || {}), ...(source.license || {}) },
  }));
  return { root, policy, sources: normalizedSources, ai, sourcePath, aiPath };
}

export function validateSourceForCollection(source, now = new Date(), region = process.env.EA_COLLECTION_REGION || "") {
  if (!source.active) return { ok: false, reason: "inactive" };
  if (!source.license?.authorised) return { ok: false, reason: "not_authorised" };
  if (source.license.publicAttributionRequired) {
    return { ok: false, reason: "public_attribution_conflicts_with_site_policy" };
  }
  if (source.license.retentionRequired) return { ok: false, reason: "retention_conflicts_with_ephemeral_policy" };
  if (region && source.license.regions?.length && !source.license.regions.includes(region)) {
    return { ok: false, reason: "region_not_licensed" };
  }
  if (source.license.validFrom && now < new Date(source.license.validFrom)) {
    return { ok: false, reason: "licence_not_started" };
  }
  if (source.license.validThrough && now > new Date(source.license.validThrough)) {
    return { ok: false, reason: "licence_expired" };
  }
  return { ok: true };
}

export function enabledSources(config, now = new Date()) {
  return config.sources
    .map((source) => ({ source, policy: validateSourceForCollection(source, now) }))
    .filter(({ policy }) => policy.ok)
    .map(({ source }) => source)
    .sort((a, b) => b.priority - a.priority);
}
