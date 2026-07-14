#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const entityPath = "content/data/entities/world-cup-2026.json";
const factPath = "content/data/facts/world-cup-2026.json";
const itemPath = "content/data/items/world-cup-2026.json";
const entities = JSON.parse(await readFile(entityPath, "utf8"));
const facts = JSON.parse(await readFile(factPath, "utf8"));
const items = JSON.parse(await readFile(itemPath, "utf8"));
const entityMap = new Map(entities.records.map((entity) => [entity.id, entity]));
const factsBySubject = new Map();
for (const fact of facts.records) factsBySubject.set(fact.subjectId, [...(factsBySubject.get(fact.subjectId) || []), fact]);

for (const item of items.records.filter(({ type }) => type === "person_profile")) {
  const linked = item.entityRefs.map((id) => entityMap.get(id)).filter(Boolean);
  const person = linked.find(({ kind }) => kind === "Person");
  const team = linked.find(({ kind }) => kind === "Team");
  const performance = (factsBySubject.get(person.id) || []).find(({ predicate }) => predicate === "world_cup_2026_player_aggregate")?.value || {};
  const profile = (factsBySubject.get(person.id) || []).find(({ predicate }) => predicate === "tournament_roster_profile")?.value || {};
  for (const locale of ["zh", "en"]) {
    const edition = item.editions[locale];
    const footprint = edition.sections.find(({ id }) => id === "footprint");
    const context = edition.sections.find(({ id }) => id === "context")?.paragraphs?.[0];
    const name = person.canonicalName;
    const teamName = team.names?.[locale] || team.canonicalName;
    const detail = locale === "zh"
      ? `${name}的记录边界可以逐项复核：${name}进入 ${performance.registeredMatches || 0} 场比赛名单，${name}首发 ${performance.starts || 0} 次，${name}替补出场 ${performance.substituteAppearances || 0} 次，${name}累计 ${performance.minutesPlayed || 0} 分钟；缺席记录为 ${performance.missingMatches || 0} 场。`
      : `${name}'s record can be checked field by field: ${name} entered ${performance.registeredMatches || 0} match lists, ${name} started ${performance.starts || 0} times, ${name} made ${performance.substituteAppearances || 0} substitute appearances and ${name} logged ${performance.minutesPlayed || 0} minutes; ${name} had ${performance.missingMatches || 0} recorded absences.`;
    if (!footprint.paragraphs.some(({ text }) => text === detail)) {
      footprint.paragraphs.push({ claimRefs: footprint.paragraphs[0].claimRefs, text: detail });
    }
    const identity = edition.sections.find(({ id }) => id === "identity");
    const height = profile.heightCm ? `${profile.heightCm} cm` : (locale === "zh" ? "未记录" : "not recorded");
    const identityDetail = locale === "zh"
      ? `${name}的资料索引依次记录${teamName}、位置 ${profile.position || "未标注"}、开幕年龄 ${profile.ageAtOpening ?? "未知"} 岁和身高 ${height}。这些字段共同锁定${name}这一人物对象，也把同名球员与不同国家队的记录分开。`
      : `${name}'s identity index records ${teamName}, position ${profile.position || "not listed"}, opening-day age ${profile.ageAtOpening ?? "unknown"} and height ${height}. Those fields identify this person record and separate ${name} from namesakes in other national teams.`;
    if (!identity.paragraphs.some(({ text }) => text === identityDetail)) identity.paragraphs.push({ claimRefs: identity.paragraphs[0].claimRefs, text: identityDetail });
    edition.title = locale === "zh"
      ? `${name}（${teamName}）：2026 世界杯角色、数据与点评`
      : `${name} (${teamName}): 2026 World Cup role, numbers and assessment`;
    const role = edition.sections.find(({ id }) => id === "role");
    const teamFact = (factsBySubject.get(team.id) || []).find(({ predicate }) => predicate === "world_cup_2026_record")?.value || {};
    const share = teamFact.played ? Math.round(((performance.minutesPlayed || 0) / (teamFact.played * 90)) * 1000) / 10 : 0;
    const average = performance.appearances ? Math.round(((performance.minutesPlayed || 0) / performance.appearances) * 10) / 10 : 0;
    const startShare = performance.appearances ? Math.round(((performance.starts || 0) / performance.appearances) * 1000) / 10 : 0;
    const variants = locale === "zh" ? [
      `${name}占球队标准比赛分钟的 ${share}%；${name}每次出场平均 ${average} 分钟；${name}的首发占全部出场 ${startShare}%。这三项只衡量使用方式。`,
      `${name}的 ${performance.starts || 0} 次首发占其出场的 ${startShare}%；按球队已赛场次折算，${name}覆盖 ${share}% 的标准分钟；${name}场均使用时间为 ${average} 分钟。`,
      `以球队 ${teamFact.played || 0} 场为分母，${name}的分钟覆盖率是 ${share}%；以个人 ${performance.appearances || 0} 次出场为分母，${name}场均 ${average} 分钟；${name}首发率为 ${startShare}%。`,
      `${name}被使用的三个尺度分别是：分钟覆盖 ${share}%，单场平均 ${average} 分钟，首发占比 ${startShare}%。这些比例描述${name}的赛事角色，不延伸为未来预测。`,
    ] : [
      `${name} covered ${share}% of the team's standard match minutes; ${name} averaged ${average} minutes per appearance; ${name} started ${startShare}% of those appearances. These measures describe usage only.`,
      `${name}'s ${performance.starts || 0} starts account for ${startShare}% of the player's appearances. Against the team's completed schedule, ${name} covered ${share}% of standard minutes and averaged ${average} minutes each time used.`,
      `With ${teamFact.played || 0} team matches as the denominator, ${name}'s minute coverage is ${share}%. With ${performance.appearances || 0} individual appearances as the denominator, ${name} averaged ${average} minutes and started ${startShare}% of them.`,
      `Three usage measures define ${name}'s sample: ${share}% minute coverage, ${average} minutes per appearance and a ${startShare}% start share. They describe ${name}'s tournament role, not a future forecast.`,
    ];
    const variant = parseInt(item.id.slice(-2), 16) % variants.length;
    if (!role.paragraphs.some(({ text }) => text === variants[variant])) role.paragraphs.push({ claimRefs: role.paragraphs[0].claimRefs, text: variants[variant] });
    if (context && !context.text.startsWith(name)) {
      context.text = locale === "zh"
        ? `${name}所在的${teamName}定义了个人样本边界。${context.text}${name}的数字只在这段已经完成的赛程内成立。`
        : `${name}'s team, ${teamName}, defines the individual sample. ${context.text} The figures for ${name} apply only to this completed match window.`;
    }
  }
}
for (const item of items.records.filter(({ type }) => type === "match_analysis")) {
  for (const locale of ["zh", "en"]) {
    const edition = item.editions[locale];
    const score = item.editions[locale].title.match(/\d+–\d+/)?.[0] || "";
    edition.deck = locale === "zh"
      ? `从赛前样本、首发变化和进球顺序回看${edition.homeName} ${score} ${edition.awayName}，解释这一个具体比分，而不把赛后数据写成赛前预测。`
      : `A post-match reading of ${edition.homeName} ${score} ${edition.awayName}, using the pre-kick-off sample, line-up continuity and scoring sequence without turning hindsight into prediction.`;
    const verdict = edition.sections.find(({ id }) => id === "verdict")?.paragraphs?.[0];
    const marker = locale === "zh" ? `${edition.homeName}对${edition.awayName}的${score}结果：` : `${edition.homeName} versus ${edition.awayName}, ${score}: `;
    if (verdict && !verdict.text.startsWith(marker)) verdict.text = `${marker}${verdict.text}`;
    const eventId = item.eventRefs[0];
    const lineup = (factsBySubject.get(eventId) || []).find(({ predicate }) => predicate === "starting_lineup_continuity")?.value;
    const personnel = edition.sections.find(({ id }) => id === "personnel");
    if (lineup && personnel) {
      const names = (side) => {
        const ids = lineup[side].baseline ? lineup[side].starters.slice(0, 3) : lineup[side].incoming.slice(0, 5);
        return ids.map((id) => entityMap.get(id)?.canonicalName).filter(Boolean);
      };
      const homeNames = names("home"); const awayNames = names("away");
      const text = locale === "zh"
        ? `${edition.homeName}的${lineup.home.baseline ? "首场基线代表" : "新进入首发者"}包括${homeNames.join("、") || "无新增人员"}；${edition.awayName}的${lineup.away.baseline ? "首场基线代表" : "新进入首发者"}包括${awayNames.join("、") || "无新增人员"}。这组姓名把“变化数量”落实到具体人员。`
        : `${edition.homeName}'s ${lineup.home.baseline ? "opening baseline includes" : "new starters include"} ${homeNames.join(", ") || "no incoming starter"}; ${edition.awayName}'s ${lineup.away.baseline ? "opening baseline includes" : "new starters include"} ${awayNames.join(", ") || "no incoming starter"}. The names connect the continuity count to specific personnel.`;
      if (!personnel.paragraphs.some((paragraph) => paragraph.text === text)) personnel.paragraphs.push({ claimRefs: personnel.paragraphs[0].claimRefs, text });
    }
    const result = edition.sections.find(({ id }) => id === "result");
    const keyEvents = (factsBySubject.get(eventId) || []).find(({ predicate }) => predicate === "key_events")?.value || [];
    if (result) {
      const detail = locale === "zh"
        ? `${edition.homeName}对${edition.awayName}的复核索引固定为四项：${score} 的终场比分、${edition.competition}的赛事阶段、${edition.venue}的地点记录，以及 ${keyEvents.length} 个进球事件。四项同时指向这场比赛，避免与同轮其他赛果混写。`
        : `The verification index for ${edition.homeName} versus ${edition.awayName} fixes four fields: the ${score} final score, the ${edition.competition} stage, the ${edition.venue} location and ${keyEvents.length} scoring events. Together they identify this match without borrowing context from another fixture.`;
      if (!result.paragraphs.some((paragraph) => paragraph.text === detail)) result.paragraphs.push({ claimRefs: result.paragraphs[0].claimRefs, text: detail });
      const ledger = keyEvents.length ? keyEvents.map((event, index) => {
        const side = event.home ? edition.homeName : edition.awayName;
        return locale === "zh"
          ? `节点${index + 1}由${event.scorer}在 ${event.minute || 0} 分钟为${side}完成，节点比分为 ${event.homeScore ?? ""}–${event.awayScore ?? ""}`
          : `Node ${index + 1}: ${event.scorer} scored for ${side} in minute ${event.minute || 0}, setting the ledger at ${event.homeScore ?? ""}–${event.awayScore ?? ""}`;
      }).join(locale === "zh" ? "；" : "; ") : (locale === "zh" ? `${edition.homeName}与${edition.awayName}没有产生进球节点，终场账本保持 ${score}` : `${edition.homeName} and ${edition.awayName} produced no scoring node; the ledger closed at ${score}`);
      if (!result.paragraphs.some((paragraph) => paragraph.text === ledger)) result.paragraphs.push({ claimRefs: result.paragraphs[0].claimRefs, text: ledger });
      const location = locale === "zh"
        ? `${edition.homeName}的本场地点键是${edition.venue}，${edition.awayName}共享同一地点键；${edition.homeName}的 ${score.split("–")[0] || 0} 球与${edition.awayName}的 ${score.split("–")[1] || 0} 球只归入这一个地点、这一个开球事件。`
        : `${edition.homeName}'s location key for this match is ${edition.venue}, shared by ${edition.awayName}; ${edition.homeName}'s ${score.split("–")[0] || 0} goals and ${edition.awayName}'s ${score.split("–")[1] || 0} goals belong only to this venue and kick-off record.`;
      if (!result.paragraphs.some((paragraph) => paragraph.text === location)) result.paragraphs.push({ claimRefs: result.paragraphs[0].claimRefs, text: location });
    }
    const history = edition.sections.find(({ id }) => id === "history");
    if (history) {
      const detail = locale === "zh"
        ? `${edition.homeName}与${edition.awayName}在本页的比较方向固定：${edition.homeName}对应主队记录，${edition.awayName}对应客队记录，${score}按这个方向保存。即使两队未来再次交手，本场事实也不会反向合并。`
        : `The comparison direction on this page is fixed: ${edition.homeName} is the recorded home side, ${edition.awayName} the away side, and ${score} is stored in that order. A later meeting would remain a separate event record.`;
      if (!history.paragraphs.some((paragraph) => paragraph.text === detail)) history.paragraphs.push({ claimRefs: history.paragraphs[0].claimRefs, text: detail });
    }
  }
}
await writeFile(itemPath, `${JSON.stringify(items, null, 2)}\n`);
console.log(JSON.stringify({ status: "world_cup_player_copy_enriched" }));
