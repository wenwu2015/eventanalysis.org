import generatedArticlesJson from "../content/articles.generated.json" with { type: "json" };
import { isLocale, type Locale } from "./locales.ts";

export type { Locale } from "./locales.ts";
export { isLocale };
export { ui } from "./ui-copy.ts";
export type ArticleStatus =
  | "draft"
  | "needs_review"
  | "data_incomplete"
  | "approved"
  | "published";

export type ArticleTranslation = {
  title: string;
  deck: string;
  competition: string;
  venue: string;
  homeName: string;
  awayName: string;
  resultLabel: string;
  h2hTitle: string;
  h2hIntro: string;
  personnelTitle: string;
  personnelParagraphs: string[];
  resultTitle: string;
  resultParagraphs: string[];
  verdictTitle: string;
  verdictParagraphs: string[];
  events: Array<{ minute: string; title: string; detail: string }>;
};

export type Article = {
  id: string;
  slug: string;
  status: ArticleStatus;
  publishedAt: string;
  reviewedAt: string;
  author: string;
  confidence: number;
  match: {
    startedAt: string;
    homeScore: number;
    awayScore: number;
  };
  headToHeadBeforeMatch: {
    matches: number;
    homeWins: number;
    draws: number;
    awayWins: number;
  };
  requiredLocales?: Locale[];
  translations: Partial<Record<Locale, ArticleTranslation>>;
};

const editorialArticles: Article[] = [
  {
    id: "ea-euro-2024-final",
    slug: "spain-england-euro-2024-final",
    status: "published",
    publishedAt: "2026-07-14T08:00:00+08:00",
    reviewedAt: "2026-07-14T07:30:00+08:00",
    author: "Event Analysis Editorial Desk",
    confidence: 94,
    match: {
      startedAt: "2024-07-14T21:00:00+02:00",
      homeScore: 2,
      awayScore: 1,
    },
    headToHeadBeforeMatch: {
      matches: 27,
      homeWins: 10,
      draws: 4,
      awayWins: 13,
    },
    translations: {
      zh: {
        title: "西班牙 2–1 英格兰：决赛为何最终属于更敢于拉开球场的一方",
        deck:
          "历史交锋并不偏向西班牙，但人员调整、边路宽度和替补时机共同改写了决赛。比分直到第 86 分钟才确定，比赛的方向却在更早之前已经形成。",
        competition: "2024 欧洲杯 · 决赛",
        venue: "柏林奥林匹克体育场",
        homeName: "西班牙",
        awayName: "英格兰",
        resultLabel: "全场",
        h2hTitle: "过去交锋：历史优势不在最终赢家一侧",
        h2hIntro:
          "决赛前双方共交手 27 次。英格兰 13 胜、西班牙 10 胜、另有 4 场平局。按全部历史比赛计算，英格兰胜率 48.1%，西班牙胜率 37.0%，平局占 14.8%。这里的统计只描述过去，并不直接等于本场胜率。",
        personnelTitle: "人员变化：两套换人都奏效，但持续时间不同",
        personnelParagraphs: [
          "西班牙中场在半场出现被动变化：罗德里无法继续比赛，祖比门迪在第 46 分钟登场。变化没有让球队退回低位。祖比门迪继续出现在接应线路中，西班牙仍能把两名边锋留在足够宽的位置。",
          "英格兰第 61 分钟用沃特金斯换下凯恩，第 70 分钟再用帕尔默换下梅努。帕尔默三分钟后扳平，说明替补确实提高了禁区前沿的出球速度。但英格兰没有把这一阶段延长为持续压迫，扳平后再次把控球和场地宽度交还给对手。",
          "西班牙第 68 分钟让奥亚萨瓦尔替下莫拉塔。这个调整减少了固定支点，却增加了前锋横向移动和突然冲击中卫身后的可能。第 86 分钟的制胜球正是这种移动方式的直接结果。",
        ],
        resultTitle: "赛后结果：2–1，以及三个真正改变比赛的节点",
        resultParagraphs: [
          "第 47 分钟，亚马尔从右侧向内吸引后送出横传，尼科·威廉斯从另一侧进入禁区得分。这个进球并非孤立的个人突破，而是两侧宽度同时存在后制造出的横向拉扯。",
          "第 73 分钟，贝林厄姆回做，帕尔默在禁区外快速完成低射。英格兰最好的进攻来自更早出球，而不是长时间等待阵地成形。这次得分验证了替补调整，却没有改变球队随后回收的选择。",
          "第 86 分钟，库库雷利亚从左路低传，奥亚萨瓦尔抢在防线回收前完成触球。西班牙在最后阶段仍能把边后卫送到高位，并让替补前锋攻击中卫之间的空隙，这解释了为什么制胜球出现在比赛末段。",
        ],
        verdictTitle: "为什么会是这个结果",
        verdictParagraphs: [
          "事实层面，西班牙创造并把握了两个来自边路宽度的机会；英格兰的扳平来自替补球员提高进攻速度。分析层面，差异不只是控球多少，而是谁能在比分变化后继续维持自己的进攻结构。",
          "英格兰的调整短暂改变了比赛，西班牙的调整则保住了比赛方式。前者得到一个进球，后者最终得到结果。历史交锋中的英格兰优势没有消失，但对一场决赛而言，阵容当下的连接方式比总历史记录更有解释力。",
        ],
        events: [
          { minute: "46′", title: "祖比门迪换下罗德里", detail: "西班牙在被动换人后维持中场结构。" },
          { minute: "47′", title: "尼科·威廉斯进球", detail: "亚马尔助攻，西班牙率先得分。" },
          { minute: "70′", title: "帕尔默登场", detail: "英格兰加快禁区前沿的处理速度。" },
          { minute: "73′", title: "帕尔默扳平", detail: "贝林厄姆回做，比分变为 1–1。" },
          { minute: "86′", title: "奥亚萨瓦尔制胜", detail: "库库雷利亚左路低传，西班牙 2–1。" },
        ],
      },
      en: {
        title: "Spain 2–1 England: Why the final belonged to the side that kept the pitch wide",
        deck:
          "The historical record favoured England. The final did not. Personnel changes, width and the timing of each substitution explain how Spain turned a tight game into a deserved late win.",
        competition: "UEFA EURO 2024 · Final",
        venue: "Olympiastadion Berlin",
        homeName: "Spain",
        awayName: "England",
        resultLabel: "Full time",
        h2hTitle: "Previous meetings: the historical edge sat with the losing side",
        h2hIntro:
          "The teams had met 27 times before the final: 13 England wins, 10 Spain wins and four draws. Across that full sample, England's win rate was 48.1%, Spain's 37.0%, with draws at 14.8%. That record describes the past; it is not a model of this match by itself.",
        personnelTitle: "Personnel changes: both benches worked, but for different lengths of time",
        personnelParagraphs: [
          "Spain were forced into a midfield change at the interval when Rodri could not continue. Martín Zubimendi entered in the 46th minute, but the team did not retreat. He kept presenting in the passing lanes while Spain preserved the width of both wingers.",
          "England replaced Harry Kane with Ollie Watkins after 61 minutes and introduced Cole Palmer for Kobbie Mainoo after 70. Palmer levelled three minutes later, evidence that the changes accelerated play around the edge of the box. England did not extend that spell into sustained pressure, however, and gradually surrendered territory again.",
          "Mikel Oyarzabal replaced Álvaro Morata after 68 minutes. Spain lost a fixed reference but gained lateral movement and a runner willing to attack the gap behind the centre-backs. The 86th-minute winner was the direct expression of that trade.",
        ],
        resultTitle: "The result: 2–1, shaped by three decisive moments",
        resultParagraphs: [
          "In the 47th minute, Lamine Yamal drew attention infield from the right and released Nico Williams arriving from the opposite side. The goal was not an isolated dribble; it came from stretching the defence across the full width of the pitch.",
          "In the 73rd minute, Jude Bellingham set the ball back and Palmer finished early from outside the box. England's best attack came from speeding the move up rather than waiting for a settled structure. The goal validated the substitution, but not the decision to withdraw again afterwards.",
          "In the 86th minute, Marc Cucurella crossed low from the left and Oyarzabal reached the space before the defensive line could recover. Spain were still willing to advance a full-back late in the game and still had a substitute striker attacking between defenders. That is why the winner arrived so late without feeling accidental.",
        ],
        verdictTitle: "Why this result made sense",
        verdictParagraphs: [
          "As fact, Spain created and converted two moves born from width; England's equaliser came from substitutes increasing the speed of the attack. As analysis, the difference was less about total possession than which team could preserve its attacking structure after the score changed.",
          "England's changes altered the game briefly. Spain's changes protected the way they wanted to play. One produced an equaliser; the other produced the result. England's historical advantage remained true, but in a final the current connections between players explained more than the all-time record.",
        ],
        events: [
          { minute: "46′", title: "Zubimendi replaces Rodri", detail: "Spain preserve their midfield structure after a forced change." },
          { minute: "47′", title: "Nico Williams scores", detail: "Yamal assists as Spain take the lead." },
          { minute: "70′", title: "Palmer enters", detail: "England add speed around the edge of the box." },
          { minute: "73′", title: "Palmer equalises", detail: "Bellingham's set-back creates the 1–1 goal." },
          { minute: "86′", title: "Oyarzabal wins it", detail: "Cucurella crosses low and Spain lead 2–1." },
        ],
      },
    },
  },
];

const generatedArticles = generatedArticlesJson as Article[];
export const articles: Article[] = [...editorialArticles, ...generatedArticles];

export const publishedArticles = articles.filter((article) => article.status === "published");

export function getArticle(slug: string): Article | undefined {
  return publishedArticles.find((article) => article.slug === slug);
}

export function winRate(wins: number, matches: number): string {
  return `${((wins / matches) * 100).toFixed(1)}%`;
}

export const legacyUi = {
  zh: {
    htmlLang: "zh-CN",
    nav: { latest: "最新", archive: "归档", methodology: "方法" },
    switchLabel: "EN",
    switchAria: "Switch to English",
    home: {
      eyebrow: "独立足球分析 · 中文版",
      headline: "终场之后，\n才开始解释。",
      intro: "不追逐实时喧嚣。我们回到历史交锋、人员变化与比赛证据，解释一个结果为何发生。",
      latest: "最新分析",
      all: "查看全部文章",
      read: "阅读全文",
      numbers: "本期数字",
      framework: "我们的分析框架",
      cards: [
        ["历史不是预测", "交锋次数和胜率提供背景，但不会替代对当下阵容的判断。"],
        ["变化必须可解释", "教练、首发、伤停与换人分别说明胜率为何可能移动。"],
        ["结果必须回到证据", "关键事件解释比分，观点与事实始终明确分开。"],
      ],
    },
    archive: { title: "文章归档", intro: "按终场时间整理的赛后历史分析。只收录经过人工审核并正式发布的文章。" },
    method: {
      title: "我们如何解释一场比赛",
      intro: "数据决定事实边界，编辑判断决定文章质量。AI 可以整理证据，但不能替代审核。",
    },
    footer: "Event Analysis 是一个只做赛后历史解读的独立静态内容门户。无实时比分、无账户、无用户追踪。",
  },
  en: {
    htmlLang: "en",
    nav: { latest: "Latest", archive: "Archive", methodology: "Method" },
    switchLabel: "中文",
    switchAria: "切换到中文",
    home: {
      eyebrow: "Independent football analysis · English edition",
      headline: "The whistle ends it.\nThe explanation starts.",
      intro: "No live noise. We return to the record, the personnel changes and the match evidence to explain why a result happened.",
      latest: "Latest analysis",
      all: "View the full archive",
      read: "Read the analysis",
      numbers: "The numbers",
      framework: "Our analytical frame",
      cards: [
        ["History is not a forecast", "Meetings and win rates create context; they do not replace a view of the current team."],
        ["Change needs a mechanism", "Coaches, line-ups, absences and substitutions explain why the balance may move."],
        ["The result returns to evidence", "Key events explain the score, with facts and interpretation kept visibly separate."],
      ],
    },
    archive: { title: "Article archive", intro: "Post-match historical analysis ordered by the final whistle. Only human-reviewed work is published." },
    method: {
      title: "How we explain a football match",
      intro: "Data sets the boundary of fact. Editorial judgement sets the standard of the article. AI can organise evidence; it cannot approve publication.",
    },
    footer: "Event Analysis is an independent static publication for post-match historical analysis. No live scores, accounts or user tracking.",
  },
} satisfies Record<"zh" | "en", unknown>;
