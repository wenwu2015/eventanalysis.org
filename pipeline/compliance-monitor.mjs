#!/usr/bin/env node
import { resolve } from "node:path";
import { loadContentData } from "./lib/data-store.mjs";
import { runCommand } from "./lib/command-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const data = await loadContentData(root);
const published = data.items.filter((item) => Object.values(item.editions || {}).some(({ status }) => status === "published"));
if (!published.length) {
  console.log(JSON.stringify({ status: "no_published_content", action: "remain_frozen" }, null, 2));
} else {
  try {
    for (const item of published) {
      await runCommand(["npm", "run", "publish:automatic", "--", `--content=${item.id}`], { cwd: root, timeoutMs: 1_200_000 });
    }
    console.log(JSON.stringify({ status: "published_content_revalidated_locally", checked: published.length, awsReleased: false }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "revalidation_failed", checked: published.length, errorCode: error.code || "unknown", action: "emergency_freeze" }));
    await runCommand(["npm", "run", "emergency:freeze", "--", "--reason=scheduled_revalidation_failure"], { cwd: root, timeoutMs: 1_800_000 });
    process.exitCode = 1;
  }
}
