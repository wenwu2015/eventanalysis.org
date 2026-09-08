#!/usr/bin/env node
import { runCommand } from "./lib/command-runner.mjs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await runCommand(["gh", "auth", "status"], { cwd: root, timeoutMs: 20_000 });
const status = await runCommand(["git", "status", "--porcelain", "--", "content/review-packets", "content/data"], { cwd: root });
if (!status.stdout.trim()) throw new Error("No review artifacts are waiting for a PR");
const branch = `event-analysis/review-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await runCommand(["git", "switch", "-c", branch], { cwd: root });
await runCommand(["git", "add", "content/review-packets", "content/data"], { cwd: root });
await runCommand(["git", "commit", "-m", "content: add football analysis drafts for review"], { cwd: root });
await runCommand(["git", "push", "-u", "origin", branch], { cwd: root, timeoutMs: 120_000 });
const body = [
  "## Editorial gate",
  "- [ ] Core result confirmed by two independent authorised sources, or by one authorised official source",
  "- [ ] Historical record and deterministic rates checked",
  "- [ ] Personnel changes checked",
  "- [ ] Sport code is active and uses the correct deterministic rules",
  "- [ ] Facts and analysis clearly separated",
  "- [ ] Numbers match across every edition included in this PR",
  "- [ ] Each edition is complete in its own language; pending languages are omitted",
  "- [ ] Duplicate-intent, source-overlap, lexical, semantic and Claim checks pass",
  "- [ ] REVIEW findings have a second reviewer; BLOCK findings have no override",
  "- [ ] No source names, URLs, screenshots or media in public copy",
  "- [ ] Rights registry is current and does not require public attribution",
  "",
  "Set only checked editions to `approved`, run the promotion command, and merge only after every gate passes.",
].join("\n");
const result = await runCommand(["gh", "pr", "create", "--draft", "--title", "Editorial review: new Event Analysis drafts", "--body", body], { cwd: root, timeoutMs: 120_000 });
console.log(result.stdout.trim());
