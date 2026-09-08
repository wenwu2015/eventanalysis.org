import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareChineseMaster, sha256 } from "./compliance.mjs";
import { normalizeSlug } from "./data-store.mjs";

const AUTOPILOT_REVIEWER = "Event Analysis Autopilot Desk";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ROUNDUP_MINIMUM_ITEMS = 3;

function validTime(value) {
  return !Number.isNaN(Date.parse(String(value || "")));
}

function humanReviewerName(item) {
  return String(item.editions?.zh?.reviewer || item.reviewer || "").trim();
}

export function isManuallyReviewedPublishedItem(item) {
  if (!item || item.type === "roundup") return false;
  if (!validTime(item.publishedAt)) return false;
  const zhEdition = item.editions?.zh;
  if (!zhEdition || zhEdition.status !== "published") return false;
  if (!validTime(zhEdition.reviewedAt || item.reviewedAt)) return false;
  const reviewer = humanReviewerName(item);
  if (!reviewer || reviewer === AUTOPILOT_REVIEWER) return false;
  return Object.values(item.editions || {}).some(({ status }) => status === "published");
}

export function eligibleWeeklyContentItems(items, now = Date.now()) {
  return items.filter((item) => {
    if (!isManuallyReviewedPublishedItem(item)) return false;
    const publishedAt = Date.parse(item.publishedAt);
    return publishedAt <= now && now - publishedAt <= WEEK_MS;
  });
}

function formatShanghaiDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function roundupSourceItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.type !== "roundup" && item?.editions?.zh?.title && Array.isArray(item?.claims) && item.claims.length);
}

function roundupFactRefs(item) {
  return [...new Set((item.claims || []).flatMap((claim) => claim.factRefs || []))];
}

function roundupClaimSummary(item) {
  const zh = item.editions.zh;
  return [zh.title, zh.deck || zh.resultLabel || ""].filter(Boolean).join("：");
}

export function buildRoundupReviewPacket(items, {
  now = new Date(),
  idPrefix = "weekly-football-roundup",
  readerQuestion = "这一批次已确认的足球页面各自聚焦了哪些确定性赛后事实？",
  title = null,
  deck = null,
} = {}) {
  const sourceItems = roundupSourceItems(items);
  if (sourceItems.length < ROUNDUP_MINIMUM_ITEMS) return null;
  const dateKey = formatShanghaiDateKey(now);
  const digest = sha256(sourceItems.map(({ id }) => id).sort().join("|")).slice(0, 10);
  const id = `${idPrefix}-${dateKey}-${digest}`;
  const slug = normalizeSlug(`${idPrefix}-${dateKey}-${digest}`);
  const claims = sourceItems.map((item, index) => ({
    id: `${id}_claim_${index + 1}`,
    kind: "fact",
    factRefs: roundupFactRefs(item),
    summary: roundupClaimSummary(item),
  }));
  const paragraphs = sourceItems.map((item, index) => ({
    id: `${id}_paragraph_${index + 1}`,
    text: roundupClaimSummary(item),
    claimRefs: [claims[index].id],
  }));
  const packet = {
    schemaVersion: 3,
    id,
    revision: 1,
    type: "roundup",
    sport: "football",
    primaryIntentKey: `${idPrefix}-${dateKey}-${digest}`,
    angleKey: `confirmed-football-roundup-${dateKey}`,
    originalContribution: `${idPrefix}-${digest}`,
    readerQuestion,
    author: "Event Analysis Roundup Builder",
    confidence: 90,
    entityRefs: [...new Set(sourceItems.flatMap((item) => item.entityRefs || []))],
    eventRefs: [...new Set(sourceItems.flatMap((item) => item.eventRefs || []))],
    sourceContentRefs: sourceItems.map(({ id: contentId }) => contentId),
    claims,
    editions: {
      zh: {
        slug,
        title: title || `${dateKey} 足球页面汇总`,
        deck: deck || `汇总本批次已确认的 ${sourceItems.length} 篇足球页面，只保留原稿已确认的赛后事实与关键节点。`,
        competition: "足球",
        venue: "本批次已确认页面",
        homeName: "多场比赛",
        awayName: "批次汇总",
        resultLabel: `${sourceItems.length} 篇已确认页面`,
        sections: [
          {
            id: "overview",
            title: "批次概览",
            paragraphs: [
              {
                id: `${id}_overview`,
                text: `本页汇总本批次已确认的 ${sourceItems.length} 篇足球页面，逐条保留原稿已经确认的赛后事实与关键节点。`,
                claimRefs: claims.map(({ id: claimId }) => claimId),
              },
            ],
          },
          {
            id: "confirmed_items",
            title: "已确认页面",
            paragraphs,
          },
        ],
        timeline: [],
        status: "needs_review",
        complianceStatus: "unreviewed",
      },
    },
  };
  return prepareChineseMaster(packet);
}

export async function writeRoundupReviewPacket(root, items, options = {}) {
  const packet = buildRoundupReviewPacket(items, options);
  if (!packet) return null;
  const outputDir = resolve(root, "content/review-packets");
  await mkdir(outputDir, { recursive: true });
  const path = resolve(outputDir, `${packet.id}.json`);
  await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`);
  return { packet, path };
}
