import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readJsonDirectory(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const values = [];
  for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    values.push(await readJson(resolve(path, entry.name)));
  }
  return values;
}

export async function loadCompliancePolicy(root) {
  return readJson(resolve(root, "pipeline/config/compliance-policy.json"));
}

export function legalRegistryPath(root) {
  return process.env.EA_LEGAL_REGISTRY ? resolve(root, process.env.EA_LEGAL_REGISTRY) : resolve(root, "private-legal/packs.json");
}

export async function loadLegalRegistry(root, { required = true } = {}) {
  const path = legalRegistryPath(root);
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code !== "ENOENT" || required) throw new Error(`Production legal registry is missing: ${path}`);
    return readJson(resolve(root, "pipeline/config/legal-packs.example.json"));
  }
}

export async function writeLegalRegistry(root, registry) {
  return writePrivateJson(legalRegistryPath(root), registry);
}

export async function loadEvidenceRecords(root) {
  return (await readJsonDirectory(resolve(root, "private-evidence"))).flatMap((packet) => packet.records || []);
}

export async function loadSourceRegistry(root) {
  const local = resolve(root, "pipeline/config/sources.local.json");
  let packet;
  try { packet = await readJson(local); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    packet = await readJson(resolve(root, "pipeline/config/sources.example.json"));
  }
  const defaults = packet.defaults || {};
  return (packet.sources || []).map((source) => ({ ...defaults, ...source, license: { ...(defaults.license || {}), ...(source.license || {}) } }));
}

export function agentReportPath(root, item) {
  return resolve(root, "private-compliance/reports", `${item.id}-r${item.revision}.json`);
}

export async function loadAgentReport(root, item) {
  try { return await readJson(agentReportPath(root, item)); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writePrivateJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function findContentItemFile(root, contentId) {
  const directory = resolve(root, "content/data/items");
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const path = resolve(directory, file);
    const packet = await readJson(path);
    const records = packet.records || [packet];
    const index = records.findIndex(({ id }) => id === contentId);
    if (index !== -1) return { path, packet, records, index, item: records[index], wrapper: Boolean(packet.records), file: basename(path) };
  }
  return null;
}

export async function loadContentInput(path) {
  const value = await readJson(path);
  if (value.records) throw new Error("A command input must identify one ContentItem, not a record collection");
  return value;
}
