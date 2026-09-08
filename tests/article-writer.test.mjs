import test from "node:test";
import assert from "node:assert/strict";
import { assertDraftShape, normalizeReviewDraft } from "../pipeline/lib/article-writer.mjs";

test("review draft normalization softens unsupported causal phrasing and drops unsupported timeline entries", () => {
  const item = {
    claims: [
      { id: "claim_goal", kind: "fact", factRefs: ["fact_goal"], summary: "恩佐·费尔南德斯第85分钟扳平。" },
      { id: "claim_analysis", kind: "analysis", factRefs: ["fact_goal"], summary: "追平球是持续施压后的结果。" },
    ],
    editions: {
      zh: {
        title: "两次末段破门",
        deck: "追平球是持续施压后的结果。",
        sections: [
          {
            id: "result",
            title: "结果",
            paragraphs: [
              { id: "p1", text: "这一序列显示，追平球是持续施压后的结果，而非一次突然出现的机会。", claimRefs: ["claim_analysis"] },
            ],
          },
        ],
        timeline: [
          { minute: "64'", label: "阿根廷用尼科·冈萨雷斯换下莱安德罗·帕雷德斯。", claimRefs: ["claim_analysis"] },
          { minute: "85'", label: "恩佐·费尔南德斯进球，阿根廷扳成1比1。", claimRefs: ["claim_goal"] },
        ],
      },
    },
  };

  normalizeReviewDraft(item);

  assert.equal(item.claims[1].summary, "追平球出现在持续施压之后。");
  assert.equal(item.editions.zh.deck, "追平球出现在持续施压之后。");
  assert.match(item.editions.zh.sections[0].paragraphs[0].text, /追平球出现在持续施压之后/);
  assert.equal(item.editions.zh.timeline.length, 1);
  assert.equal(item.editions.zh.timeline[0].minute, "85'");
  assert.deepEqual(item.editions.zh.timeline[0].claimRefs, ["claim_goal"]);
});

test("moment primary intent keys are normalized to the event scope when needed", () => {
  const item = {
    id: "moment-test",
    type: "moment_analysis",
    sport: "football",
    primaryIntentKey: "post_match_key_moment_review",
    angleKey: "final-score",
    originalContribution: "test",
    eventRefs: ["event_example"],
    entityRefs: ["team_home", "team_away"],
    claims: [
      { id: "claim_goal", kind: "fact", factRefs: ["fact_goal"], summary: "终场比分确认。" },
    ],
    editions: {
      zh: {
        slug: "moment-test",
        title: "终场比分确认",
        deck: "只保留确定事实。",
        sections: [
          {
            id: "result",
            title: "结果",
            paragraphs: [
              { id: "p1", text: "终场比分确认。", claimRefs: ["claim_goal"] },
            ],
          },
        ],
        timeline: [],
      },
    },
  };

  assertDraftShape(item, {
    references: {
      eventRefs: ["event_example"],
      entityRefs: ["team_home", "team_away"],
      requiredFactRefs: ["fact_goal"],
      optionalFactRefs: [],
    },
    entities: [],
  });

  assert.equal(item.primaryIntentKey, "moment-analysis-event-example");
});
