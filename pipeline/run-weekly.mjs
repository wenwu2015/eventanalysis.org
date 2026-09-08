#!/usr/bin/env node
import { resolve } from "node:path";
import { loadContentData } from "./lib/data-store.mjs";
import { eligibleWeeklyContentItems, writeRoundupReviewPacket } from "./lib/weekly-roundup.mjs";

const root = resolve(import.meta.dirname, "..");
const data = await loadContentData(root);
const now = Date.now();
const recent = eligibleWeeklyContentItems(data.items, now);
if (recent.length < 3) console.log(`Weekly roundup skipped: ${recent.length}/3 manually reviewed and published content items in the last seven days.`);
else {
    const packet = await writeRoundupReviewPacket(root, recent, {
      now,
      idPrefix: "weekly-football-roundup",
      title: `最近七天足球页面汇总`,
      deck: `汇总最近七天内人工复核并已发布的 ${recent.length} 篇足球页面，只保留原稿已确认的赛后事实与关键节点。`,
      readerQuestion: "最近七天内人工复核并发布的足球页面，分别确认了哪些赛后事实？",
    });
    if (!packet) {
      console.log(`Weekly roundup skipped: ${recent.length}/3 manually reviewed and published content items in the last seven days.`);
      process.exit(0);
    }
    try {
      const { runCommand } = await import("./lib/command-runner.mjs");
      await runCommand(["npm", "run", "editorial:autopilot", "--", `--content=${packet.packet.id}`], { cwd: root, timeoutMs: 3_600_000 });
    } catch (error) {
      console.error(`Autopilot failed for ${packet.packet.id}: ${String(error?.message || error)}`);
    }
    console.log(`Weekly review packet created for ${recent.length} published content items.`);
  }
