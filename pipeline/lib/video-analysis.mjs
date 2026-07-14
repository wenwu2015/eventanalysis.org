import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runCommand } from "./command-runner.mjs";

async function downloadAuthorisedVideo(url, destination, { maxBytes = 1_500_000_000, timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Video download failed with ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Video exceeds configured byte limit");
    let received = 0;
    const stream = Readable.fromWeb(response.body).map((chunk) => {
      received += chunk.length;
      if (received > maxBytes) throw new Error("Video exceeded configured byte limit while streaming");
      return chunk;
    });
    await pipeline(stream, createWriteStream(destination, { mode: 0o600 }));
    return received;
  } finally {
    clearTimeout(timer);
  }
}

export async function analyseVideo({ videoUrl, source, job, aiConfig, root }) {
  if (!source?.license?.authorised || !source.license.internalVideoAnalysis) {
    throw new Error("Source licence does not permit internal video analysis");
  }
  const videoDir = resolve(job.jobDir, "video");
  const framesDir = resolve(videoDir, "frames");
  await mkdir(framesDir, { recursive: true, mode: 0o700 });
  const videoPath = resolve(videoDir, "source-video");
  const audioPath = resolve(videoDir, "audio.wav");
  const transcriptPath = resolve(videoDir, "transcript.json");
  const visionPath = resolve(videoDir, "vision.json");

  job.retainUrl(videoUrl);
  await downloadAuthorisedVideo(videoUrl, videoPath);
  await job.checkDisk();
  await runCommand(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", audioPath], { cwd: root, timeoutMs: 300_000 });
  await runCommand(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "fps=1/15,scale=960:-2", "-q:v", "4", resolve(framesDir, "frame-%05d.jpg")], { cwd: root, timeoutMs: 600_000 });
  await job.checkDisk();

  if (aiConfig.video.transcribeCommand?.length) {
    await runCommand(aiConfig.video.transcribeCommand, {
      cwd: root,
      timeoutMs: aiConfig.video.timeoutMs,
      env: { EA_AUDIO_PATH: audioPath, EA_OUTPUT_PATH: transcriptPath },
    });
  } else {
    await writeFile(transcriptPath, JSON.stringify({ status: "not_configured", segments: [] }), { mode: 0o600 });
  }
  if (aiConfig.video.visionCommand?.length) {
    await runCommand(aiConfig.video.visionCommand, {
      cwd: root,
      timeoutMs: aiConfig.video.timeoutMs,
      env: { EA_FRAMES_PATH: framesDir, EA_OUTPUT_PATH: visionPath },
    });
  } else {
    await writeFile(visionPath, JSON.stringify({ status: "not_configured", observations: [] }), { mode: 0o600 });
  }
  return {
    transcript: JSON.parse(await readFile(transcriptPath, "utf8")),
    vision: JSON.parse(await readFile(visionPath, "utf8")),
  };
}
