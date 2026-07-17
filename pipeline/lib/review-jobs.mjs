import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function reviewJobPath(root, contentId, jobType) {
  return resolve(root, "private-review/jobs", `${contentId}.${jobType}.json`);
}

export async function readReviewJob(root, contentId, jobType) {
  try {
    return JSON.parse(await readFile(reviewJobPath(root, contentId, jobType), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeReviewJob(root, contentId, jobType, payload) {
  const path = reviewJobPath(root, contentId, jobType);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function removeReviewJob(root, contentId, jobType) {
  await rm(reviewJobPath(root, contentId, jobType), { force: true });
}

export function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function activeReviewJob(root, contentId, jobType) {
  const job = await readReviewJob(root, contentId, jobType);
  if (!job?.pid || !isProcessAlive(job.pid)) {
    if (job) await removeReviewJob(root, contentId, jobType);
    return null;
  }
  return job;
}
