import { mkdir, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

async function directoryBytes(path) {
  let total = 0;
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for await (const entry of directory) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

export async function assertWithinDiskBudget(jobDir, limitBytes) {
  const used = await directoryBytes(jobDir);
  if (used > limitBytes) {
    const error = new Error(`Job disk limit exceeded: ${used} > ${limitBytes}`);
    error.code = "JOB_DISK_LIMIT";
    throw error;
  }
  return used;
}

export async function cleanupOrphanJobs(jobsRoot, maxAgeMinutes, now = Date.now()) {
  await mkdir(jobsRoot, { recursive: true });
  const removed = [];
  const directory = await opendir(jobsRoot);
  for await (const entry of directory) {
    if (!entry.isDirectory()) continue;
    const path = resolve(jobsRoot, entry.name);
    const details = await stat(path);
    if (now - details.mtimeMs > maxAgeMinutes * 60_000) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

function safeArticleId(value) {
  const id = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  if (!id) throw new Error("A valid article id is required before retaining source URLs");
  return id;
}

async function mergeUrlList(destination, urls) {
  let existing = [];
  try {
    existing = (await readFile(destination, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const merged = [...new Set([...existing, ...urls])].sort();
  await writeFile(destination, `${merged.join("\n")}\n`, { mode: 0o600 });
}

async function mergeEvidencePacket(destination, records) {
  let existing = { schemaVersion: 2, records: [] };
  try {
    existing = JSON.parse(await readFile(destination, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const merged = new Map((existing.records || []).map((record) => [record.id, record]));
  for (const record of records) merged.set(record.id, record);
  await writeFile(destination, `${JSON.stringify({ schemaVersion: 2, records: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`, { mode: 0o600 });
}

function sanitiseEvidence(record) {
  if (!record?.id || !record?.sourceId || !record?.url || !record?.capturedAt || !record?.parserVersion || !record?.rawHash) {
    throw new Error("Evidence requires id, sourceId, url, capturedAt, parserVersion and rawHash");
  }
  const url = new URL(record.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Evidence URL must use HTTP(S)");
  url.username = "";
  url.password = "";
  return {
    id: String(record.id),
    sourceId: String(record.sourceId),
    url: url.toString(),
    rightsSnapshotId: String(record.rightsSnapshotId || "unrecorded"),
    capturedAt: new Date(record.capturedAt).toISOString(),
    parserVersion: String(record.parserVersion),
    rawHash: String(record.rawHash),
    fieldLocations: (record.fieldLocations || []).map(String).slice(0, 100),
    excerpt: String(record.excerpt || "").slice(0, 500),
  };
}

export async function withEphemeralJob({ root, articleId = `job-${randomUUID()}`, diskLimitBytes }, task) {
  const jobsRoot = resolve(root, "pipeline/jobs");
  const jobDir = resolve(jobsRoot, `${Date.now()}-${basename(articleId)}-${randomUUID()}`);
  const retainedUrls = new Set();
  const retainedEvidence = new Map();
  await mkdir(jobDir, { recursive: true, mode: 0o700 });

  const context = {
    jobDir,
    retainUrl(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only HTTP(S) source URLs may be retained");
      }
      url.username = "";
      url.password = "";
      retainedUrls.add(url.toString());
    },
    retainEvidence(value) {
      const record = sanitiseEvidence(value);
      retainedEvidence.set(record.id, record);
      retainedUrls.add(record.url);
    },
    async checkDisk() {
      return assertWithinDiskBudget(jobDir, diskLimitBytes);
    },
  };

  try {
    return await task(context);
  } finally {
    if (retainedUrls.size > 0) {
      const privateRoot = resolve(root, "private-sources");
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      await mergeUrlList(resolve(privateRoot, `${safeArticleId(articleId)}.txt`), retainedUrls);
    }
    if (retainedEvidence.size > 0) {
      const evidenceRoot = resolve(root, "private-evidence");
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      await mergeEvidencePacket(resolve(evidenceRoot, `${safeArticleId(articleId)}.json`), [...retainedEvidence.values()]);
    }
    await rm(jobDir, { recursive: true, force: true });
  }
}

export async function writeEphemeral(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
