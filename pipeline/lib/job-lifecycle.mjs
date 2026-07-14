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

export async function withEphemeralJob({ root, articleId = `job-${randomUUID()}`, diskLimitBytes }, task) {
  const jobsRoot = resolve(root, "pipeline/jobs");
  const jobDir = resolve(jobsRoot, `${Date.now()}-${basename(articleId)}-${randomUUID()}`);
  const retainedUrls = new Set();
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
    await rm(jobDir, { recursive: true, force: true });
  }
}

export async function writeEphemeral(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
