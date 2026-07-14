import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cleanupOrphanJobs, withEphemeralJob } from "../pipeline/lib/job-lifecycle.mjs";

async function fixtureRoot() {
  return mkdtemp(resolve(tmpdir(), "ea-lifecycle-"));
}

async function assertJobsEmpty(root) {
  const jobs = await readdir(resolve(root, "pipeline/jobs")).catch(() => []);
  assert.deepEqual(jobs, []);
}

test("success deletes every job artifact but retains a sanitised URL", async () => {
  const root = await fixtureRoot();
  await withEphemeralJob({ root, articleId: "article-one", diskLimitBytes: 10_000 }, async (job) => {
    await writeFile(resolve(job.jobDir, "video.mp4"), "temporary-media");
    job.retainUrl("https://user:secret@example.com/match/video?id=1");
  });
  await assertJobsEmpty(root);
  assert.equal(await readFile(resolve(root, "private-sources/article-one.txt"), "utf8"), "https://example.com/match/video?id=1\n");
});

test("failure and cancellation still delete the complete job directory", async () => {
  for (const failure of [new Error("boom"), Object.assign(new Error("cancelled"), { name: "AbortError" })]) {
    const root = await fixtureRoot();
    await assert.rejects(withEphemeralJob({ root, articleId: "failed", diskLimitBytes: 10_000 }, async (job) => {
      await writeFile(resolve(job.jobDir, "frame.jpg"), "temporary-frame");
      throw failure;
    }));
    await assertJobsEmpty(root);
  }
});

test("disk cap aborts and cleans the task", async () => {
  const root = await fixtureRoot();
  await assert.rejects(withEphemeralJob({ root, articleId: "too-large", diskLimitBytes: 8 }, async (job) => {
    await writeFile(resolve(job.jobDir, "part.bin"), "0123456789");
    await job.checkDisk();
  }), (error) => error.code === "JOB_DISK_LIMIT");
  await assertJobsEmpty(root);
});

test("startup janitor removes only orphan directories older than the threshold", async () => {
  const root = await fixtureRoot();
  const jobsRoot = resolve(root, "pipeline/jobs");
  const old = resolve(jobsRoot, "old");
  const fresh = resolve(jobsRoot, "fresh");
  await mkdir(old, { recursive: true });
  await mkdir(fresh, { recursive: true });
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(old, oldTime, oldTime);
  const removed = await cleanupOrphanJobs(jobsRoot, 60);
  assert.deepEqual(removed, [old]);
  assert.deepEqual(await readdir(jobsRoot), ["fresh"]);
});
