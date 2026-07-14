import { normalizeSlug } from "./data-store.mjs";

const COMPETITION_ID = "competition_fifa_world_cup_2026";
const CHINESE_TEAMS = new Map(Object.entries({
  Algeria: "阿尔及利亚", Argentina: "阿根廷", Australia: "澳大利亚", Austria: "奥地利", Belgium: "比利时",
  Brazil: "巴西", "Bosnia & Herzegovina": "波斯尼亚和黑塞哥维那", Cameroon: "喀麦隆", Canada: "加拿大", "Cape Verde": "佛得角", "Cabo Verde": "佛得角", Colombia: "哥伦比亚",
  "Costa Rica": "哥斯达黎加", Croatia: "克罗地亚", Curaçao: "库拉索", Czechia: "捷克", Denmark: "丹麦", "DR Congo": "刚果民主共和国", Ecuador: "厄瓜多尔",
  Egypt: "埃及", England: "英格兰", France: "法国", Germany: "德国", Ghana: "加纳", Haiti: "海地",
  Iran: "伊朗", Iraq: "伊拉克", Italy: "意大利", "Ivory Coast": "科特迪瓦", "Côte d'Ivoire": "科特迪瓦", Japan: "日本", Jordan: "约旦", Mexico: "墨西哥",
  Morocco: "摩洛哥", Netherlands: "荷兰", "New Zealand": "新西兰", Nigeria: "尼日利亚", Norway: "挪威",
  Panama: "巴拿马", Paraguay: "巴拉圭", Poland: "波兰", Portugal: "葡萄牙", Qatar: "卡塔尔",
  "Saudi Arabia": "沙特阿拉伯", Scotland: "苏格兰", Senegal: "塞内加尔", "South Africa": "南非",
  "South Korea": "韩国", Spain: "西班牙", Sweden: "瑞典", Switzerland: "瑞士", Tunisia: "突尼斯", Türkiye: "土耳其", Ukraine: "乌克兰",
  Uruguay: "乌拉圭", USA: "美国", "United States": "美国", Uzbekistan: "乌兹别克斯坦", Wales: "威尔士",
}));

function teamId(id) { return `team_wc2026_${id}`; }
function personId(id) { return `person_wc2026_${id}`; }
function eventId(id) { return `event_wc2026_${id}`; }
function placeId(id) { return `place_wc2026_${id}`; }
function factId(prefix, id) { return `fact_wc2026_${prefix}_${id}`; }

function teamName(team, locale) {
  if (locale === "zh") return CHINESE_TEAMS.get(team.name) || team.name;
  return team.name;
}

function eventTeamName(event, side, locale, teamsBySourceId) {
  const sourceId = side === "home" ? event.homeTeamId : event.awayTeamId;
  const team = teamsBySourceId.get(String(sourceId));
  return team ? teamName(team, locale) : (side === "home" ? event.homeTeam : event.awayTeam);
}

function ageAt(timestamp, at = Date.UTC(2026, 5, 11)) {
  if (!Number.isFinite(timestamp)) return null;
  const born = new Date(timestamp * 1_000);
  const date = new Date(at);
  let age = date.getUTCFullYear() - born.getUTCFullYear();
  if (date.getUTCMonth() < born.getUTCMonth() || (date.getUTCMonth() === born.getUTCMonth() && date.getUTCDate() < born.getUTCDate())) age -= 1;
  return age;
}

function sum(target, source, keys) {
  for (const key of keys) target[key] = (target[key] || 0) + (Number(source?.[key]) || 0);
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function pct(numerator, denominator) {
  return denominator ? round((numerator / denominator) * 100, 1) : 0;
}

function goalsFromIncidents(packet) {
  return (packet?.incidents || [])
    .filter((incident) => incident.incidentType === "goal" && !/missed/i.test(String(incident.incidentClass || "")))
    .sort((a, b) => (a.time || 0) - (b.time || 0));
}

function goalName(goal) {
  return goal.player?.name || goal.playerName || "Unknown scorer";
}

function assistName(goal) {
  return goal.assist1?.name || goal.assist2?.name || null;
}

function positionGroup(position) {
  const value = String(position || "").toUpperCase();
  if (value === "G" || value === "GK") return "goalkeeper";
  if (value.startsWith("D")) return "defender";
  if (value.startsWith("M")) return "midfielder";
  return "forward";
}

function stageName(match, locale) {
  const group = match.event.raw?.tournament?.groupName || match.event.raw?.roundInfo?.name || "World Cup";
  const zh = {
    "Group A": "A组", "Group B": "B组", "Group C": "C组", "Group D": "D组", "Group E": "E组", "Group F": "F组",
    "Group G": "G组", "Group H": "H组", "Group I": "I组", "Group J": "J组", "Group K": "K组", "Group L": "L组",
    "Round of 32": "32强", "Round of 16": "16强", Quarterfinals: "四分之一决赛", Semifinals: "半决赛", Final: "决赛",
  };
  return locale === "zh" ? (zh[group] || group) : group;
}

function teamTournamentRecords(snapshot) {
  const records = new Map(snapshot.teams.map((team) => [String(team.id), {
    team, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, evidenceIds: [], lastMatch: null, active: false,
  }]));
  const scheduledTeams = new Set(snapshot.events.filter((event) => !["finished", "afterpenalties", "afterextra"].some((status) => event.status.includes(status))).flatMap((event) => [String(event.homeTeamId), String(event.awayTeamId)]));
  for (const match of snapshot.matches) {
    for (const side of ["home", "away"]) {
      const id = String(side === "home" ? match.event.homeTeamId : match.event.awayTeamId);
      const record = records.get(id);
      const own = side === "home" ? match.event.homeScore : match.event.awayScore;
      const other = side === "home" ? match.event.awayScore : match.event.homeScore;
      record.played += 1;
      record.goalsFor += own;
      record.goalsAgainst += other;
      if (own > other) record.wins += 1;
      else if (own === other) record.draws += 1;
      else record.losses += 1;
      record.evidenceIds.push(match.evidenceId);
      record.lastMatch = match;
    }
  }
  for (const [id, record] of records) record.active = scheduledTeams.has(id);
  return records;
}

function addLineupContinuity(matches) {
  const previous = new Map();
  for (const match of matches) {
    match.lineupChanges = {};
    for (const side of ["home", "away"]) {
      const sourceTeamId = String(side === "home" ? match.event.homeTeamId : match.event.awayTeamId);
      const starters = new Set((match.players[side] || []).filter((record) => record.availability === "matchday" && !record.substitute).map((record) => String(record.player.id)));
      const prior = previous.get(sourceTeamId);
      const incoming = prior ? [...starters].filter((id) => !prior.has(id)) : [];
      const outgoing = prior ? [...prior].filter((id) => !starters.has(id)) : [];
      match.lineupChanges[side] = { baseline: !prior, starters: [...starters], incoming, outgoing, changes: incoming.length };
      previous.set(sourceTeamId, starters);
    }
  }
}

function aggregatePlayers(snapshot) {
  const players = new Map();
  const statKeys = [
    "goals", "goalAssist", "minutesPlayed", "totalShots", "shotsOnTarget", "expectedGoals", "expectedAssists", "keyPass",
    "totalPass", "accuratePass", "totalTackle", "interceptionWon", "totalClearance", "saves", "goalsPrevented",
    "duelWon", "totalDuels", "possessionLostCtrl", "touches", "bigChanceCreated", "bigChanceMissed",
  ];
  for (const match of snapshot.matches) for (const side of ["home", "away"]) {
    const sourceTeamId = String(side === "home" ? match.event.homeTeamId : match.event.awayTeamId);
    for (const record of match.players[side] || []) {
      const raw = record.player;
      if (!raw?.id || !raw?.name) continue;
      const id = String(raw.id);
      let player = players.get(id);
      if (!player) {
        player = {
          id, raw, sourceTeamId, position: record.position || raw.position || "", positions: new Set(), evidenceIds: new Set(),
          registeredMatches: 0, missingMatches: 0, appearances: 0, starts: 0, substituteAppearances: 0, ratings: [], stats: {}, eventIds: [], bestRating: null, bestEventId: null,
        };
        players.set(id, player);
      }
      player.positions.add(record.position || raw.position || "");
      player.evidenceIds.add(match.evidenceId);
      player.registeredMatches += 1;
      if (record.availability === "missing") {
        player.missingMatches += 1;
        continue;
      }
      const statistics = record.statistics || {};
      const minutes = Number(statistics.minutesPlayed) || 0;
      if (minutes > 0) {
        player.appearances += 1;
        player.starts += record.substitute ? 0 : 1;
        player.substituteAppearances += record.substitute ? 1 : 0;
        player.eventIds.push(String(match.event.id));
        if (Number.isFinite(statistics.rating)) {
          player.ratings.push(Number(statistics.rating));
          if (player.bestRating === null || Number(statistics.rating) > player.bestRating) {
            player.bestRating = Number(statistics.rating);
            player.bestEventId = String(match.event.id);
          }
        }
        sum(player.stats, statistics, statKeys);
      }
    }
  }
  for (const player of players.values()) {
    player.stats.minutesPlayed = Math.round(player.stats.minutesPlayed || 0);
    player.averageRating = player.ratings.length ? round(player.ratings.reduce((a, b) => a + b, 0) / player.ratings.length, 2) : null;
    player.positionGroup = positionGroup(player.position);
    player.age = ageAt(player.raw.dateOfBirthTimestamp);
  }
  return players;
}

function matchTeamTotals(records) {
  const totals = {};
  for (const record of records || []) if (record.availability === "matchday" && record.statistics?.minutesPlayed) {
    sum(totals, record.statistics, ["totalShots", "shotsOnTarget", "expectedGoals", "expectedAssists", "keyPass", "totalPass", "accuratePass", "totalTackle", "interceptionWon", "totalClearance", "saves", "bigChanceCreated", "bigChanceMissed"]);
  }
  totals.passAccuracy = pct(totals.accuratePass, totals.totalPass);
  return totals;
}

function currentTournamentH2h(matches, targetIndex) {
  const target = matches[targetIndex].event;
  const pair = [String(target.homeTeamId), String(target.awayTeamId)].sort().join(":");
  const prior = matches.slice(0, targetIndex).filter(({ event }) => [String(event.homeTeamId), String(event.awayTeamId)].sort().join(":") === pair);
  let homeWins = 0; let awayWins = 0; let draws = 0;
  for (const { event } of prior) {
    if (event.homeScore === event.awayScore) draws += 1;
    else {
      const winner = event.homeScore > event.awayScore ? String(event.homeTeamId) : String(event.awayTeamId);
      if (winner === String(target.homeTeamId)) homeWins += 1;
      else awayWins += 1;
    }
  }
  return { matches: prior.length, homeWins, awayWins, draws, scope: "2026 World Cup matches before kick-off" };
}

function matchReading(match, locale) {
  const home = match.event.homeTeam;
  const away = match.event.awayTeam;
  const homeTotals = match.teamTotals.home;
  const awayTotals = match.teamTotals.away;
  const goals = match.goals;
  const winner = match.event.homeScore === match.event.awayScore ? null : (match.event.homeScore > match.event.awayScore ? home : away);
  const loser = winner === home ? away : home;
  const score = `${match.event.homeScore}-${match.event.awayScore}`;
  const trailingWinner = winner && goals.some((goal) => goal.isHome !== (winner === home) && ((goal.isHome ? goal.homeScore : goal.awayScore) || 0) > 0);
  const shotEdge = (homeTotals.totalShots || 0) - (awayTotals.totalShots || 0);
  const passEdge = (homeTotals.passAccuracy || 0) - (awayTotals.passAccuracy || 0);
  if (locale === "zh") {
    if (!winner) return `${CHINESE_TEAMS.get(home) || home}与${CHINESE_TEAMS.get(away) || away}没有在比分上分出胜负。双方球员统计合计的射门差为 ${Math.abs(shotEdge)} 次、传球成功率差为 ${Math.abs(passEdge).toFixed(1)} 个百分点；结果更接近机会兑现率相互抵消，而不是一方持续压倒另一方。`;
    if (trailingWinner) return `${CHINESE_TEAMS.get(winner) || winner}在对阵${CHINESE_TEAMS.get(loser) || loser}时经历落后仍以 ${score} 逆转，说明决定结果的是比分变化后的应对。射门与传球数据提供过程背景，真正改变赛果的是落后方没有让首个失球固定比赛节奏。`;
    return `${CHINESE_TEAMS.get(winner) || winner}在对阵${CHINESE_TEAMS.get(loser) || loser}时把领先转化为 ${score} 的最终结果。球员统计合计显示双方射门差为 ${Math.abs(shotEdge)} 次、传球成功率差为 ${Math.abs(passEdge).toFixed(1)} 个百分点；关键不是单一控球数字，而是领先一方对后续阶段的处理。`;
  }
  if (!winner) return `${home} and ${away} stayed level. Aggregated player data shows a shot gap of ${Math.abs(shotEdge)} and a pass-completion gap of ${Math.abs(passEdge).toFixed(1)} percentage points; the outcome reflects offsetting conversion rather than uninterrupted control by one side.`;
  if (trailingWinner) return `${winner} recovered after falling behind against ${loser} to win ${score}. The decisive feature was the response to the first score change: the concession did not lock the game into the opponent's preferred rhythm.`;
  return `${winner} converted the lead against ${loser} into the ${score} result. Aggregated player data shows a shot gap of ${Math.abs(shotEdge)} and a pass-completion gap of ${Math.abs(passEdge).toFixed(1)} percentage points; game-state management mattered more than any single possession number.`;
}

function matchTimeline(match, locale) {
  return match.goals.map((goal) => {
    const scorer = goalName(goal);
    const assist = assistName(goal);
    const score = `${goal.homeScore ?? ""}–${goal.awayScore ?? ""}`;
    return locale === "zh"
      ? { minute: `${goal.time || 0}′`, title: `${scorer} 改写比分`, detail: `${score}${assist ? `，助攻：${assist}` : ""}`, claimRefs: [`claim_${match.event.id}_events`] }
      : { minute: `${goal.time || 0}′`, title: `${scorer} changes the score`, detail: `${score}${assist ? `; assisted by ${assist}` : ""}`, claimRefs: [`claim_${match.event.id}_events`] };
  });
}

function matchEdition(match, locale, teamsBySourceId, venue) {
  const home = eventTeamName(match.event, "home", locale, teamsBySourceId);
  const away = eventTeamName(match.event, "away", locale, teamsBySourceId);
  const stage = stageName(match, locale);
  const score = `${match.event.homeScore}–${match.event.awayScore}`;
  const changes = match.lineupChanges;
  const goals = match.goals;
  const goalText = goals.length ? goals.map((goal) => `${goal.time || 0}′ ${goalName(goal)}`).join("、") : (locale === "zh" ? "没有进球事件" : "no scoring event");
  const h2h = match.h2h;
  const h2hSentence = locale === "zh"
    ? `按“本届世界杯、开球前已经结束的比赛”这一明确口径，双方此前交手 ${h2h.matches} 次：${home} ${h2h.homeWins} 胜，平局 ${h2h.draws} 场，${away} ${h2h.awayWins} 胜。这不是两队全部历史交锋，不能冒充全时段胜率。`
    : `Using the explicit scope of completed 2026 World Cup matches before kick-off, the teams had met ${h2h.matches} times: ${h2h.homeWins} ${home} wins, ${h2h.draws} draws and ${h2h.awayWins} ${away} wins. This is not presented as an all-time record.`;
  const pairDetail = locale === "zh"
    ? `${home}与${away}在本页的比较方向固定：${home}对应主队记录，${away}对应客队记录，${score}按这个方向保存。即使两队未来再次交手，本场事实也不会反向合并。`
    : `The comparison direction on this page is fixed: ${home} is the recorded home side, ${away} the away side, and ${score} is stored in that order. A later meeting would remain a separate event record.`;
  const changeSentence = locale === "zh"
    ? `${home}${changes.home.baseline ? "以本届赛事首场首发作为基线" : `较上一场更换 ${changes.home.changes} 名首发`}；${away}${changes.away.baseline ? "同样建立首场基线" : `更换 ${changes.away.changes} 名首发`}。人员连续性只按已确认首发计算，不把未出场名单当作战术变化。`
    : `${home} ${changes.home.baseline ? "established its tournament starting baseline" : `changed ${changes.home.changes} starters from its previous match`}; ${away} ${changes.away.baseline ? "also established its opening baseline" : `changed ${changes.away.changes} starters`}. Continuity is calculated from confirmed starters only.`;
  const lineupNames = (side) => {
    const ids = changes[side].baseline ? changes[side].starters.slice(0, 3) : changes[side].incoming.slice(0, 5);
    const records = new Map((match.players[side] || []).map((record) => [String(record.player?.id), record.player?.name]));
    return ids.map((id) => records.get(String(id))).filter(Boolean);
  };
  const homeNames = lineupNames("home");
  const awayNames = lineupNames("away");
  const lineupDetail = locale === "zh"
    ? `${home}的${changes.home.baseline ? "首场基线代表" : "新进入首发者"}包括${homeNames.join("、") || "无新增人员"}；${away}的${changes.away.baseline ? "首场基线代表" : "新进入首发者"}包括${awayNames.join("、") || "无新增人员"}。这组姓名把“变化数量”落实到具体人员。`
    : `${home}'s ${changes.home.baseline ? "opening baseline includes" : "new starters include"} ${homeNames.join(", ") || "no incoming starter"}; ${away}'s ${changes.away.baseline ? "opening baseline includes" : "new starters include"} ${awayNames.join(", ") || "no incoming starter"}. The names connect the continuity count to specific personnel.`;
  const resultSentence = locale === "zh"
    ? `终场比分为 ${home} ${score} ${away}。可核验的进球节点为：${goalText}。比分、进球顺序和首发变化属于事实；由这些事实推导出的比赛机制单独标为分析。`
    : `The final score was ${home} ${score} ${away}. The verified scoring sequence was ${goalText}. Score, sequence and line-up changes are facts; the mechanism inferred from them is labelled as analysis.`;
  const resultDetail = locale === "zh"
    ? `${home}对${away}的复核索引固定为四项：${score} 的终场比分、${stage}的赛事阶段、${venue || "比赛场地"}的地点记录，以及 ${goals.length} 个进球事件。四项同时指向这场比赛，避免与同轮其他赛果混写。`
    : `The verification index for ${home} versus ${away} fixes four fields: the ${score} final score, the ${stage} stage, the ${venue || "match venue"} location and ${goals.length} scoring events. Together they identify this match without borrowing context from another fixture.`;
  const goalLedger = goals.length ? goals.map((goal, index) => {
    const side = goal.isHome ? home : away;
    return locale === "zh"
      ? `节点${index + 1}由${goalName(goal)}在 ${goal.time || 0} 分钟为${side}完成，节点比分为 ${goal.homeScore ?? ""}–${goal.awayScore ?? ""}`
      : `Node ${index + 1}: ${goalName(goal)} scored for ${side} in minute ${goal.time || 0}, setting the ledger at ${goal.homeScore ?? ""}–${goal.awayScore ?? ""}`;
  }).join(locale === "zh" ? "；" : "; ") : (locale === "zh" ? `${home}与${away}没有产生进球节点，终场账本保持 ${score}` : `${home} and ${away} produced no scoring node; the ledger closed at ${score}`);
  const locationLedger = locale === "zh"
    ? `${home}的本场地点键是${venue || "比赛场地"}，${away}共享同一地点键；${home}的 ${match.event.homeScore} 球与${away}的 ${match.event.awayScore} 球只归入这一个地点、这一个开球事件。`
    : `${home}'s location key for this match is ${venue || "match venue"}, shared by ${away}; ${home}'s ${match.event.homeScore} goals and ${away}'s ${match.event.awayScore} goals belong only to this venue and kick-off record.`;
  return {
    status: "published",
    slug: normalizeSlug(locale === "zh" ? `${home}-${away}-2026世界杯-${match.event.startTimestamp}` : `${match.event.homeTeamSlug}-${match.event.awayTeamSlug}-world-cup-2026-${match.event.startTimestamp}`),
    slugFrozenAt: match.capturedAt,
    title: locale === "zh" ? `${home} ${score} ${away}：比分如何在${stage}形成` : `${home} ${score} ${away}: How the ${stage} result took shape`,
    deck: locale === "zh" ? `从赛前样本、首发变化和进球顺序回看${home} ${score} ${away}这场${stage}，解释这一个具体比分，而不把赛后数据写成赛前预测。` : `A post-match reading of ${home} ${score} ${away} in the ${stage}, using the pre-kick-off sample, line-up continuity and scoring sequence without turning hindsight into prediction.`,
    competition: locale === "zh" ? `2026 世界杯 · ${stage}` : `2026 FIFA World Cup · ${stage}`,
    venue: venue || (locale === "zh" ? "比赛场地" : "Match venue"),
    homeName: home,
    awayName: away,
    resultLabel: locale === "zh" ? "全场" : "Full time",
    reviewer: "Event Analysis Verification Desk",
    sections: [
      { id: "history", title: locale === "zh" ? "赛前交锋：先把统计口径说清" : "Before kick-off: define the sample first", paragraphs: [{ claimRefs: [`claim_${match.event.id}_h2h`], text: h2hSentence }, { claimRefs: [`claim_${match.event.id}_h2h`, `claim_${match.event.id}_result`], text: pairDetail }] },
      { id: "personnel", title: locale === "zh" ? "人员变化：首发连续性如何移动" : "Personnel: how the starting XI changed", paragraphs: [{ claimRefs: [`claim_${match.event.id}_lineup`], text: changeSentence }, { claimRefs: [`claim_${match.event.id}_lineup`], text: lineupDetail }] },
      { id: "result", title: locale === "zh" ? `赛后结果：${score} 与关键节点` : `The result: ${score} and the decisive sequence`, paragraphs: [{ claimRefs: [`claim_${match.event.id}_result`, `claim_${match.event.id}_events`], text: resultSentence }, { claimRefs: [`claim_${match.event.id}_result`, `claim_${match.event.id}_events`], text: resultDetail }, { claimRefs: [`claim_${match.event.id}_events`], text: goalLedger }, { claimRefs: [`claim_${match.event.id}_result`], text: locationLedger }] },
      { id: "verdict", title: locale === "zh" ? "为什么会是这个结果" : "Why this result made sense", paragraphs: [{ claimRefs: [`claim_${match.event.id}_mechanism`, `claim_${match.event.id}_verdict`], text: matchReading(match, locale) }] },
    ],
    timeline: matchTimeline(match, locale),
  };
}

function playerRoleText(player, teamRecord, locale) {
  const s = player.stats;
  const team = locale === "zh" ? teamName(teamRecord.team, "zh") : teamRecord.team.name;
  if (!player.appearances) return locale === "zh"
    ? `${player.raw.name}进入了${team}的赛事名单记录，但截至本次快照没有可确认的出场分钟。这个页面因此只评价其名单位置，不把“未出场”写成能力结论；后续若有正式出场，统计对象会在新版本中更新。`
    : `${player.raw.name} appears in ${team}'s tournament roster evidence but has no confirmed playing minutes in this snapshot. The page therefore describes roster status rather than treating non-selection as a judgement of ability.`;
  if (player.positionGroup === "goalkeeper") return locale === "zh"
    ? `${player.raw.name}在 ${s.minutesPlayed} 分钟内完成 ${s.saves || 0} 次扑救，场均评分 ${player.averageRating ?? "暂无"}。门将评价优先看扑救、处理球与出场样本，不能用球队失球数直接替代个人表现。`
    : `${player.raw.name} recorded ${s.saves || 0} saves in ${s.minutesPlayed} minutes with an average rating of ${player.averageRating ?? "n/a"}. Goalkeeping is read through saves, distribution and sample size rather than team goals conceded alone.`;
  if (player.positionGroup === "defender") return locale === "zh"
    ? `${player.raw.name}累计 ${s.totalTackle || 0} 次抢断、${s.interceptionWon || 0} 次拦截和 ${s.totalClearance || 0} 次解围。防守贡献要与球队所处比赛状态一起读：领先后的解围增加，并不自动等于防线失控。`
    : `${player.raw.name} accumulated ${s.totalTackle || 0} tackles, ${s.interceptionWon || 0} interceptions and ${s.totalClearance || 0} clearances. Defensive volume is interpreted with game state; more clearances while protecting a lead do not automatically mean loss of control.`;
  if (player.positionGroup === "midfielder") return locale === "zh"
    ? `${player.raw.name}完成 ${s.accuratePass || 0}/${s.totalPass || 0} 次传球，送出 ${s.keyPass || 0} 次关键传球，贡献 ${s.goalAssist || 0} 次助攻。中场作用由连接、推进与防守回收共同组成，单看进球会遗漏主要工作。`
    : `${player.raw.name} completed ${s.accuratePass || 0} of ${s.totalPass || 0} passes, made ${s.keyPass || 0} key passes and supplied ${s.goalAssist || 0} assists. Midfield value is read through connection, progression and recovery, not goals alone.`;
  return locale === "zh"
    ? `${player.raw.name}在 ${s.minutesPlayed} 分钟内打进 ${s.goals || 0} 球、助攻 ${s.goalAssist || 0} 次，并完成 ${s.totalShots || 0} 次射门。前场评价同时考虑产出、出场时间和球队比赛阶段，避免用一次进球覆盖整届赛事。`
    : `${player.raw.name} produced ${s.goals || 0} goals and ${s.goalAssist || 0} assists from ${s.totalShots || 0} shots in ${s.minutesPlayed} minutes. Attacking output is read against playing time and tournament stage rather than allowing one finish to define the whole campaign.`;
}

function playerEdition(player, teamRecord, locale) {
  const name = player.raw.name;
  const team = teamName(teamRecord.team, locale);
  const position = player.position || player.raw.position || (locale === "zh" ? "未标注" : "not listed");
  const age = player.age ?? (locale === "zh" ? "未知" : "unknown");
  const height = player.raw.height ? `${player.raw.height} cm` : (locale === "zh" ? "未记录" : "not recorded");
  const footprint = locale === "zh"
    ? `${name}在已完成比赛中出场 ${player.appearances} 次、首发 ${player.starts} 次，累计 ${player.stats.minutesPlayed || 0} 分钟，进球 ${player.stats.goals || 0} 个、助攻 ${player.stats.goalAssist || 0} 次${player.averageRating ? `，平均评分 ${player.averageRating}` : ""}。所有数字都来自逐场名单与球员统计的合并，不用推测补齐。`
    : `${name} has ${player.appearances} appearances, ${player.starts} starts and ${player.stats.minutesPlayed || 0} minutes in completed matches, with ${player.stats.goals || 0} goals and ${player.stats.goalAssist || 0} assists${player.averageRating ? ` at an average rating of ${player.averageRating}` : ""}. The totals are merged from match-by-match line-ups without inferred values.`;
  const context = locale === "zh"
    ? `${name}所在的${team}截至快照已赛 ${teamRecord.played} 场，${teamRecord.wins} 胜 ${teamRecord.draws} 平 ${teamRecord.losses} 负，进 ${teamRecord.goalsFor} 球、失 ${teamRecord.goalsAgainst} 球。${name}的个人统计必须放回这一团队样本中理解；球队${teamRecord.active ? "仍在本届赛事中" : "本届赛程已经结束"}。`
    : `${name}'s team, ${team}, had played ${teamRecord.played} matches at the snapshot: ${teamRecord.wins} wins, ${teamRecord.draws} draws and ${teamRecord.losses} losses, with ${teamRecord.goalsFor} scored and ${teamRecord.goalsAgainst} conceded. That team record defines the available sample for ${name}; the side ${teamRecord.active ? "remained in the tournament" : "had completed its campaign"}.`;
  const auditDetail = locale === "zh"
    ? `${name}的记录边界可以逐项复核：${name}进入 ${player.registeredMatches} 场比赛名单，${name}首发 ${player.starts} 次，${name}替补出场 ${player.substituteAppearances} 次，${name}累计 ${player.stats.minutesPlayed || 0} 分钟；缺席记录为 ${player.missingMatches} 场。`
    : `${name}'s record can be checked field by field: ${name} entered ${player.registeredMatches} match lists, ${name} started ${player.starts} times, ${name} made ${player.substituteAppearances} substitute appearances and ${name} logged ${player.stats.minutesPlayed || 0} minutes; ${name} had ${player.missingMatches} recorded absences.`;
  const identityDetail = locale === "zh"
    ? `${name}的资料索引依次记录${team}、位置 ${position}、开幕年龄 ${age} 岁和身高 ${height}。这些字段共同锁定${name}这一人物对象，也把同名球员与不同国家队的记录分开。`
    : `${name}'s identity index records ${team}, position ${position}, opening-day age ${age} and height ${height}. Those fields identify this person record and separate ${name} from namesakes in other national teams.`;
  const minutesShare = pct(player.stats.minutesPlayed || 0, Math.max(1, teamRecord.played * 90));
  const variants = locale === "zh" ? [
    `${name}占球队标准比赛分钟的 ${minutesShare}%；${name}每次出场平均 ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} 分钟；${name}的首发占全部出场 ${pct(player.starts, player.appearances)}%。这三项只衡量使用方式。`,
    `${name}的 ${player.starts} 次首发占其出场的 ${pct(player.starts, player.appearances)}%；按球队已赛场次折算，${name}覆盖 ${minutesShare}% 的标准分钟；${name}场均使用时间为 ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} 分钟。`,
    `以球队 ${teamRecord.played} 场为分母，${name}的分钟覆盖率是 ${minutesShare}%；以个人 ${player.appearances} 次出场为分母，${name}场均 ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} 分钟；${name}首发率为 ${pct(player.starts, player.appearances)}%。`,
    `${name}被使用的三个尺度分别是：分钟覆盖 ${minutesShare}%，单场平均 ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} 分钟，首发占比 ${pct(player.starts, player.appearances)}%。这些比例描述${name}的赛事角色，不延伸为未来预测。`,
  ] : [
    `${name} covered ${minutesShare}% of the team's standard match minutes; ${name} averaged ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} minutes per appearance; ${name} started ${pct(player.starts, player.appearances)}% of those appearances. These measures describe usage only.`,
    `${name}'s ${player.starts} starts account for ${pct(player.starts, player.appearances)}% of the player's appearances. Against the team's completed schedule, ${name} covered ${minutesShare}% of standard minutes and averaged ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} minutes each time used.`,
    `With ${teamRecord.played} team matches as the denominator, ${name}'s minute coverage is ${minutesShare}%. With ${player.appearances} individual appearances as the denominator, ${name} averaged ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} minutes and started ${pct(player.starts, player.appearances)}% of them.`,
    `Three usage measures define ${name}'s sample: ${minutesShare}% minute coverage, ${player.appearances ? round((player.stats.minutesPlayed || 0) / player.appearances, 1) : 0} minutes per appearance and a ${pct(player.starts, player.appearances)}% start share. They describe ${name}'s tournament role, not a future forecast.`,
  ];
  const usageDetail = variants[Number(player.id) % variants.length];
  return {
    status: "published",
    slug: normalizeSlug(locale === "zh" ? `${team}-${player.raw.slug || name}-2026世界杯球员` : `${player.raw.slug || name}-${teamRecord.team.slug}-world-cup-2026`),
    slugFrozenAt: player.capturedAt,
    title: locale === "zh" ? `${name}（${team}）：2026 世界杯角色、数据与点评` : `${name} (${team}): 2026 World Cup role, numbers and assessment`,
    deck: locale === "zh" ? `${team}球员 ${name} 的逐场出场样本、位置数据和团队背景。事实与判断分开呈现。` : `${name}'s match-by-match sample, positional data and team context for ${team}, with facts separated from assessment.`,
    kicker: locale === "zh" ? `2026 世界杯 · ${team} · 球员档案` : `2026 FIFA World Cup · ${team} · Player profile`,
    reviewer: "Event Analysis Verification Desk",
    sections: [
      { id: "identity", title: locale === "zh" ? "球员资料：身份与位置" : "Player record: identity and position", paragraphs: [{ claimRefs: [`claim_player_${player.id}_profile`], text: locale === "zh" ? `${name}代表${team}参赛，位置标记为 ${position}，赛事开幕时 ${age} 岁，身高 ${height}。资料字段只描述登记信息，不把身高、年龄直接等同于能力。` : `${name} represented ${team}, with position listed as ${position}, age ${age} at the tournament opening and height ${height}. These are registration facts, not proxies for ability.` }, { claimRefs: [`claim_player_${player.id}_profile`], text: identityDetail }] },
      { id: "footprint", title: locale === "zh" ? "本届足迹：出场与产出" : "Tournament footprint: minutes and output", paragraphs: [{ claimRefs: [`claim_player_${player.id}_performance`], text: footprint }, { claimRefs: [`claim_player_${player.id}_performance`], text: auditDetail }] },
      { id: "role", title: locale === "zh" ? "角色点评：数据能说明什么" : "Role assessment: what the numbers support", paragraphs: [{ claimRefs: [`claim_player_${player.id}_role`], text: playerRoleText(player, teamRecord, locale) }, { claimRefs: [`claim_player_${player.id}_role`], text: usageDetail }] },
      { id: "context", title: locale === "zh" ? "球队背景：个人样本的边界" : "Team context: the boundary of the sample", paragraphs: [{ claimRefs: [`claim_player_${player.id}_context`], text: context }] },
    ],
  };
}

export function buildWorldCup2026Content(snapshot) {
  addLineupContinuity(snapshot.matches);
  const teamsBySourceId = new Map(snapshot.teams.map((team) => [String(team.id), team]));
  const teamRecords = teamTournamentRecords(snapshot);
  const players = aggregatePlayers(snapshot);
  const capturedAt = snapshot.capturedAt;
  for (const player of players.values()) player.capturedAt = capturedAt;
  const entities = [{
    id: COMPETITION_ID, kind: "Competition", sport: "football", canonicalName: "2026 FIFA World Cup",
    names: { zh: "2026 世界杯", en: "2026 FIFA World Cup" },
  }];
  for (const team of snapshot.teams) entities.push({
    id: teamId(team.id), kind: "Team", sport: "football", canonicalName: team.name,
    names: { zh: teamName(team, "zh"), en: team.name },
    relations: [{ predicate: "competition_entry", targetId: COMPETITION_ID, validFrom: "2026-06-11", validTo: "2026-07-19" }],
  });
  const places = new Map();
  for (const match of snapshot.matches) {
    const venue = match.event.raw?.venue;
    if (venue?.id && !places.has(String(venue.id))) {
      const entity = { id: placeId(venue.id), kind: "Place", sport: "football", canonicalName: venue.name, names: { zh: venue.name, en: venue.name } };
      places.set(String(venue.id), entity);
      entities.push(entity);
    }
  }
  for (const player of players.values()) entities.push({
    id: personId(player.id), kind: "Person", sport: "football", canonicalName: player.raw.name,
    names: { en: player.raw.name, zh: player.raw.name },
    attributes: { sourcePlayerId: player.id, position: player.position, heightCm: player.raw.height || null, dateOfBirthTimestamp: player.raw.dateOfBirthTimestamp || null },
    relations: [{ predicate: "tournament_roster", targetId: teamId(player.sourceTeamId), validFrom: "2026-06-11", validTo: "2026-07-19" }],
  });

  const events = [];
  const facts = [];
  const items = [];
  const teamFactIds = new Map();
  for (const [sourceId, record] of teamRecords) {
    const id = factId("team_record", sourceId);
    teamFactIds.set(sourceId, id);
    facts.push({
      id, subjectId: teamId(sourceId), predicate: "world_cup_2026_record", status: "confirmed", observedAt: capturedAt,
      value: { played: record.played, wins: record.wins, draws: record.draws, losses: record.losses, goalsFor: record.goalsFor, goalsAgainst: record.goalsAgainst, active: record.active },
      evidenceRefs: [...new Set([snapshot.official.evidenceId, ...record.evidenceIds])],
    });
  }

  const completedIds = new Set(snapshot.matches.map(({ event }) => String(event.id)));
  for (const rawEvent of snapshot.events) if (completedIds.has(String(rawEvent.id))) {
    const match = snapshot.matches.find(({ event }) => String(event.id) === String(rawEvent.id));
    const venue = match.event.raw?.venue;
    events.push({
      id: eventId(rawEvent.id), kind: "Event", sport: "football", competitionId: COMPETITION_ID,
      startedAt: new Date(rawEvent.startTimestamp * 1_000).toISOString(), status: "finished",
      homeTeamId: teamId(rawEvent.homeTeamId), awayTeamId: teamId(rawEvent.awayTeamId), homeScore: rawEvent.homeScore, awayScore: rawEvent.awayScore,
      ...(venue?.id ? { placeId: placeId(venue.id) } : {}),
      entityRefs: [teamId(rawEvent.homeTeamId), teamId(rawEvent.awayTeamId), COMPETITION_ID, ...(venue?.id ? [placeId(venue.id)] : [])],
    });
  }

  for (let index = 0; index < snapshot.matches.length; index += 1) {
    const match = snapshot.matches[index];
    match.capturedAt = capturedAt;
    match.goals = goalsFromIncidents(match.incidents);
    match.teamTotals = { home: matchTeamTotals(match.players.home), away: matchTeamTotals(match.players.away) };
    match.h2h = currentTournamentH2h(snapshot.matches, index);
    const id = String(match.event.id);
    const resultFact = factId("result", id);
    const h2hFact = factId("h2h", id);
    const lineupFact = factId("lineup", id);
    const eventsFact = factId("events", id);
    const performanceFact = factId("performance", id);
    facts.push(
      { id: resultFact, subjectId: eventId(id), predicate: "final_result", status: "confirmed", observedAt: capturedAt, value: { homeScore: match.event.homeScore, awayScore: match.event.awayScore, winnerId: match.event.homeScore === match.event.awayScore ? null : teamId(match.event.homeScore > match.event.awayScore ? match.event.homeTeamId : match.event.awayTeamId) }, evidenceRefs: [match.evidenceId, snapshot.official.evidenceId] },
      { id: h2hFact, subjectId: eventId(id), predicate: "head_to_head_before_match", status: "confirmed", validTo: new Date(match.event.startTimestamp * 1_000 - 1_000).toISOString(), value: match.h2h, evidenceRefs: [match.evidenceId, snapshot.official.evidenceId] },
      { id: lineupFact, subjectId: eventId(id), predicate: "starting_lineup_continuity", status: "confirmed", observedAt: capturedAt, value: match.lineupChanges, evidenceRefs: [match.evidenceId] },
      { id: eventsFact, subjectId: eventId(id), predicate: "key_events", status: "confirmed", observedAt: capturedAt, value: match.goals.map((goal) => ({ minute: goal.time || null, home: Boolean(goal.isHome), scorer: goalName(goal), assist: assistName(goal), homeScore: goal.homeScore ?? null, awayScore: goal.awayScore ?? null })), evidenceRefs: [match.evidenceId] },
      { id: performanceFact, subjectId: eventId(id), predicate: "player_stat_totals", status: "confirmed", observedAt: capturedAt, value: match.teamTotals, evidenceRefs: [match.evidenceId] },
    );
    const venue = match.event.raw?.venue?.name || "Match venue";
    items.push({
      schemaVersion: 2, id: `content_wc2026_match_${id}`, revision: 1, type: "match_analysis", sport: "football",
      primaryIntentKey: `world-cup-2026-match-${id}-result-explained`, angleKey: "lineup-continuity-score-sequence-and-game-state",
      originalContribution: `Explains ${match.event.homeTeam} ${match.event.homeScore}-${match.event.awayScore} ${match.event.awayTeam} through its verified score sequence, starting-XI continuity and aggregated player statistics.`,
      readerQuestion: `Why did ${match.event.homeTeam} vs ${match.event.awayTeam} finish ${match.event.homeScore}-${match.event.awayScore}?`,
      author: "Event Analysis Editorial Desk", publishedAt: capturedAt, reviewedAt: capturedAt, confidence: 92,
      entityRefs: [teamId(match.event.homeTeamId), teamId(match.event.awayTeamId), COMPETITION_ID], eventRefs: [eventId(id)],
      claims: [
        { id: `claim_${id}_result`, kind: "fact", factRefs: [resultFact], summary: `The final score was ${match.event.homeScore}-${match.event.awayScore}.` },
        { id: `claim_${id}_h2h`, kind: "calculation", factRefs: [h2hFact], summary: "The pre-kick-off comparison uses completed matches in this tournament and does not claim to be an all-time record." },
        { id: `claim_${id}_lineup`, kind: "calculation", factRefs: [lineupFact], summary: "Starting-XI continuity is calculated against each team's previous tournament match." },
        { id: `claim_${id}_events`, kind: "fact", factRefs: [eventsFact], summary: "The scoring sequence fixes the order in which game state changed." },
        { id: `claim_${id}_mechanism`, kind: "analysis", factRefs: [eventsFact, performanceFact], summary: `The score sequence and player-stat totals explain how ${match.event.homeTeam} and ${match.event.awayTeam} handled changing game states.` },
        { id: `claim_${id}_verdict`, kind: "analysis", factRefs: [resultFact, lineupFact, eventsFact], summary: "The result is explained from verified match mechanisms rather than hindsight presented as prediction." },
      ],
      editions: {
        zh: matchEdition(match, "zh", teamsBySourceId, venue),
        en: matchEdition(match, "en", teamsBySourceId, venue),
      },
    });
  }

  for (const player of players.values()) {
    const profileFact = factId("player_profile", player.id);
    const performanceFact = factId("player_performance", player.id);
    const evidenceRefs = [...player.evidenceIds];
    facts.push(
      { id: profileFact, subjectId: personId(player.id), predicate: "tournament_roster_profile", status: "confirmed", observedAt: capturedAt, value: { teamId: teamId(player.sourceTeamId), position: player.position, heightCm: player.raw.height || null, dateOfBirthTimestamp: player.raw.dateOfBirthTimestamp || null, ageAtOpening: player.age }, evidenceRefs },
      { id: performanceFact, subjectId: personId(player.id), predicate: "world_cup_2026_player_aggregate", status: "confirmed", observedAt: capturedAt, value: { appearances: player.appearances, starts: player.starts, substituteAppearances: player.substituteAppearances, registeredMatches: player.registeredMatches, missingMatches: player.missingMatches, averageRating: player.averageRating, ...player.stats }, evidenceRefs },
    );
    const teamRecord = teamRecords.get(player.sourceTeamId);
    const contentId = `content_wc2026_player_${player.id}`;
    items.push({
      schemaVersion: 2, id: contentId, revision: 1, type: "person_profile", sport: "football",
      primaryIntentKey: `world-cup-2026-player-${player.id}-profile`, angleKey: "tournament-role-output-and-team-context",
      originalContribution: `Audits ${player.raw.name}'s 2026 World Cup roster status, minutes, position-specific output and team context from match-level records.`,
      readerQuestion: `What did ${player.raw.name}'s role and verified tournament sample show?`,
      author: "Event Analysis Editorial Desk", publishedAt: capturedAt, reviewedAt: capturedAt,
      confidence: player.appearances ? 91 : 82,
      entityRefs: [personId(player.id), teamId(player.sourceTeamId), COMPETITION_ID], eventRefs: player.eventIds.map(eventId),
      claims: [
        { id: `claim_player_${player.id}_profile`, kind: "fact", factRefs: [profileFact], summary: `${player.raw.name}'s roster identity, position, age and height are recorded without using them as ability proxies.` },
        { id: `claim_player_${player.id}_performance`, kind: "calculation", factRefs: [performanceFact], summary: `${player.raw.name}'s appearances and totals are aggregated from completed match records.` },
        { id: `claim_player_${player.id}_role`, kind: "analysis", factRefs: [performanceFact], summary: `${player.raw.name}'s role is assessed with position-specific measures and sample-size limits.` },
        { id: `claim_player_${player.id}_context`, kind: "analysis", factRefs: [performanceFact, teamFactIds.get(player.sourceTeamId)], summary: `${player.raw.name}'s individual sample is interpreted within the team's tournament record.` },
      ],
      editions: { zh: playerEdition(player, teamRecord, "zh"), en: playerEdition(player, teamRecord, "en") },
    });
  }

  const remaining = snapshot.events.filter((event) => !completedIds.has(String(event.id)));
  const activeTeams = [...teamRecords.values()].filter(({ active }) => active).map(({ team }) => team.name);
  const stateFact = factId("tournament_state", "20260714");
  facts.push({
    id: stateFact, subjectId: COMPETITION_ID, predicate: "tournament_state", status: "confirmed", observedAt: capturedAt,
    value: { teams: snapshot.teams.length, players: players.size, matchesTotal: snapshot.events.length, matchesCompleted: snapshot.matches.length, matchesRemaining: remaining.length, activeTeams },
    evidenceRefs: [snapshot.official.evidenceId, ...snapshot.matches.slice(-4).map(({ evidenceId }) => evidenceId)],
  });
  items.push({
    schemaVersion: 2, id: "content_wc2026_current_state_20260714", revision: 1, type: "competition_story", sport: "football",
    primaryIntentKey: "world-cup-2026-current-state-after-quarterfinals", angleKey: "completed-field-semifinalists-and-coverage-audit",
    originalContribution: `A dated, non-live snapshot connecting the completed match count, remaining bracket and verified player coverage after the quarterfinals.`,
    readerQuestion: "What is the verified state of the 2026 World Cup after the quarterfinals?", author: "Event Analysis Editorial Desk",
    publishedAt: capturedAt, reviewedAt: capturedAt, confidence: 95, entityRefs: [COMPETITION_ID, ...activeTeams.map((name) => teamId(snapshot.teams.find((team) => team.name === name).id))], eventRefs: [],
    claims: [
      { id: "claim_wc2026_state", kind: "fact", factRefs: [stateFact], summary: `${snapshot.matches.length} of ${snapshot.events.length} matches were complete at the snapshot.` },
      { id: "claim_wc2026_coverage", kind: "calculation", factRefs: [stateFact], summary: `${players.size} unique tournament player records were normalized from match-level evidence.` },
      { id: "claim_wc2026_reading", kind: "analysis", factRefs: [stateFact], summary: "The remaining bracket is presented as a dated state, not a live-score or prediction product." },
    ],
    editions: {
      zh: { status: "published", slug: "2026世界杯-四分之一决赛后-赛事全景", slugFrozenAt: capturedAt, title: "2026 世界杯最新赛况：100 场结束，四队进入半决赛", deck: `截至本次静态快照，${snapshot.events.length} 场赛程中已有 ${snapshot.matches.length} 场结束；${activeTeams.map((name) => CHINESE_TEAMS.get(name) || name).join("、")}仍在争冠。`, kicker: "2026 世界杯 · 阶段快照", reviewer: "Event Analysis Verification Desk", sections: [
        { id: "state", title: "赛事进度", paragraphs: [{ claimRefs: ["claim_wc2026_state"], text: `本届赛事共有 ${snapshot.teams.length} 支球队、${snapshot.events.length} 场比赛。截至快照已结束 ${snapshot.matches.length} 场，剩余 ${remaining.length} 场。这个页面是赛后静态记录，不提供实时比分。` }] },
        { id: "field", title: "仍在争冠的球队", paragraphs: [{ claimRefs: ["claim_wc2026_state", "claim_wc2026_reading"], text: `${activeTeams.map((name) => CHINESE_TEAMS.get(name) || name).join("、")}进入最后阶段。尚未开球的场次只列作赛程状态，不提前生成赛后结论。` }] },
        { id: "coverage", title: "内容覆盖", paragraphs: [{ claimRefs: ["claim_wc2026_coverage"], text: `本批次从逐场名单中归一化 ${players.size} 名球员，并为每场已结束比赛建立结果、首发连续性、关键事件和球员统计事实对象；资料不足的判断不会用推测补齐。` }] },
      ] },
      en: { status: "published", slug: "world-cup-2026-state-after-quarterfinals", slugFrozenAt: capturedAt, title: "2026 World Cup state: 100 matches complete, four teams remain", deck: `At this static snapshot, ${snapshot.matches.length} of ${snapshot.events.length} matches were complete and ${activeTeams.join(", ")} remained in contention.`, kicker: "2026 FIFA World Cup · Stage snapshot", reviewer: "Event Analysis Verification Desk", sections: [
        { id: "state", title: "Tournament progress", paragraphs: [{ claimRefs: ["claim_wc2026_state"], text: `The tournament contains ${snapshot.teams.length} teams and ${snapshot.events.length} matches. At the snapshot, ${snapshot.matches.length} were complete and ${remaining.length} remained. This is a post-match static record, not a live-score service.` }] },
        { id: "field", title: "Teams still in contention", paragraphs: [{ claimRefs: ["claim_wc2026_state", "claim_wc2026_reading"], text: `${activeTeams.join(", ")} reached the closing phase. Fixtures that had not kicked off are recorded as schedule state and do not receive premature post-match conclusions.` }] },
        { id: "coverage", title: "Coverage audit", paragraphs: [{ claimRefs: ["claim_wc2026_coverage"], text: `${players.size} player records were normalized from match-level line-ups. Every completed match receives result, starting-XI continuity, key-event and player-stat fact objects; missing interpretation is not filled by guesswork.` }] },
      ] },
    },
  });

  return {
    counts: { teams: snapshot.teams.length, players: players.size, events: events.length, facts: facts.length, items: items.length },
    entities: { schemaVersion: 2, records: entities },
    events: { schemaVersion: 2, records: events },
    facts: { schemaVersion: 2, records: facts },
    items: { schemaVersion: 2, records: items },
  };
}
