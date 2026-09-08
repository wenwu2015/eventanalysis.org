import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundupReviewPacket, eligibleWeeklyContentItems, isManuallyReviewedPublishedItem } from "../pipeline/lib/weekly-roundup.mjs";

const now = Date.parse("2026-08-10T12:00:00Z");

function makeItem(overrides = {}) {
  return {
    id: "match-1",
    type: "match_analysis",
    publishedAt: "2026-08-08T12:00:00Z",
    reviewedAt: "2026-08-08T10:00:00Z",
    editions: {
      zh: {
        status: "published",
        reviewer: "Event Analysis Verification Desk",
        reviewedAt: "2026-08-08T10:00:00Z",
      },
      en: {
        status: "published",
      },
    },
    ...overrides,
  };
}

test("manual published article is eligible for weekly roundup", () => {
  assert.equal(isManuallyReviewedPublishedItem(makeItem()), true);
  assert.deepEqual(eligibleWeeklyContentItems([makeItem()], now).map(({ id }) => id), ["match-1"]);
});

test("autopilot-reviewed, stale, and roundup items are excluded", () => {
  const autopilot = makeItem({
    id: "moment-1",
    type: "moment_analysis",
    editions: {
      zh: {
        status: "published",
        reviewer: "Event Analysis Autopilot Desk",
        reviewedAt: "2026-08-08T10:00:00Z",
      },
    },
  });
  const stale = makeItem({
    id: "match-2",
    publishedAt: "2026-07-30T12:00:00Z",
  });
  const roundup = makeItem({
    id: "weekly-2026-08-03",
    type: "roundup",
  });

  assert.deepEqual(eligibleWeeklyContentItems([autopilot, stale, roundup], now), []);
});

test("roundup packet is built as a Chinese master review packet", () => {
  const items = [
    makeItem({
      id: "match-1",
      eventRefs: ["event-1"],
      entityRefs: ["team-1", "team-2"],
      claims: [{ id: "c1", kind: "fact", factRefs: ["fact-1"], summary: "主队在终场前锁定比分。" }],
      editions: {
        zh: {
          status: "published",
          reviewer: "Event Analysis Verification Desk",
          reviewedAt: "2026-08-08T10:00:00Z",
          title: "比赛一标题",
          deck: "比赛一导语",
          competition: "国际足球邀请赛",
          venue: "球场一",
          homeName: "主队一",
          awayName: "客队一",
          resultLabel: "3比2",
          sections: [{ id: "s1", title: "概览", paragraphs: [{ id: "p1", text: "比赛一概览。", claimRefs: ["c1"] }] }],
          timeline: [],
        },
        en: { status: "published" },
      },
    }),
    makeItem({ id: "match-2", eventRefs: ["event-2"], entityRefs: ["team-3", "team-4"], claims: [{ id: "c2", kind: "fact", factRefs: ["fact-2"], summary: "客队在下半场完成反超。" }], editions: { zh: { status: "published", reviewer: "Event Analysis Verification Desk", reviewedAt: "2026-08-08T10:00:00Z", title: "比赛二标题", deck: "比赛二导语", competition: "国际足球邀请赛", venue: "球场二", homeName: "主队二", awayName: "客队二", resultLabel: "2比1", sections: [{ id: "s1", title: "概览", paragraphs: [{ id: "p1", text: "比赛二概览。", claimRefs: ["c2"] }] }], timeline: [] }, en: { status: "published" } } }),
    makeItem({ id: "match-3", eventRefs: ["event-3"], entityRefs: ["team-5", "team-6"], claims: [{ id: "c3", kind: "fact", factRefs: ["fact-3"], summary: "比赛三关键节点已确认。" }], editions: { zh: { status: "published", reviewer: "Event Analysis Verification Desk", reviewedAt: "2026-08-08T10:00:00Z", title: "比赛三标题", deck: "比赛三导语", competition: "国际足球邀请赛", venue: "球场三", homeName: "主队三", awayName: "客队三", resultLabel: "1比0", sections: [{ id: "s1", title: "概览", paragraphs: [{ id: "p1", text: "比赛三概览。", claimRefs: ["c3"] }] }], timeline: [] }, en: { status: "published" } } }),
  ];
  const packet = buildRoundupReviewPacket(items, { now: "2026-08-24T21:00:00+08:00", idPrefix: "daily-football-roundup" });
  assert.equal(packet.type, "roundup");
  assert.equal(packet.editions.zh.status, "needs_review");
  assert.equal(packet.claims.length, 3);
  assert.equal(packet.sourceLocale, "zh");
  assert.equal(packet.sourceContentRefs.length, 3);
  assert.match(packet.editions.zh.slug, /^daily-football-roundup-2026-08-24-/);
});
