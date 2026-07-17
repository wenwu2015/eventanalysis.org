function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function formatDate(value) {
  if (!value) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function workflowStatusText(status) {
  return {
    editorial_approved: "编辑已批准",
    quarantined: "已隔离",
    release_blocked: "申请被阻断（未发布）",
    release_ready: "已完成本地预发",
    release_requested: "发布申请处理中",
    release_review_required: "发布待人工复核",
    review_pending: "待编辑一键通过",
  }[status] || status;
}

function factGapText(values) {
  return values?.length ? values.join("、") : "无";
}

function findingsHtml(findings) {
  if (!findings?.length) return "<p class=\"meta\">当前没有记录到发布阻断项。</p>";
  return `<ul class="list">${findings.map((finding) => {
    const suffix = [
      finding.code,
      finding.jurisdiction ? `jurisdiction=${finding.jurisdiction}` : null,
      Array.isArray(finding.reasons) && finding.reasons.length ? `reasons=${finding.reasons.join(",")}` : null,
      finding.locale ? `locale=${finding.locale}` : null,
      finding.factId ? `fact=${finding.factId}` : null,
    ].filter(Boolean).join(" · ");
    return `<li>${escapeHtml(suffix || JSON.stringify(finding))}</li>`;
  }).join("")}</ul>`;
}

function blockedJurisdictions(findings = []) {
  return [...new Set((findings || [])
    .map((finding) => String(finding?.jurisdiction || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value) && value !== "ZZ"))];
}

function blockedWorkflowMeaning(workflow) {
  const jurisdictions = blockedJurisdictions(workflow?.release?.findings);
  if (!jurisdictions.length) {
    return "这表示发布申请已经真实执行过，但没有公开发布成功；当前只需查看阻断摘要并等待后台修复发布条件。";
  }
  if (jurisdictions.length === 1) {
    return `这表示发布申请已经真实执行过，但没有公开发布成功；后台当前卡在 ${jurisdictions[0]} 对应的发布条件，公开站点没有放行。`;
  }
  return `这表示发布申请已经真实执行过，但没有公开发布成功；后台当前卡在 ${jurisdictions.join("、")} 对应的发布条件，公开站点没有放行。`;
}

export function renderReviewPreviewHtml(reviewItem) {
  const item = reviewItem.item;
  const edition = reviewItem.edition;
  const workflow = reviewItem.workflow;
  const release = workflow.release || {};
  const timeline = edition.timeline?.length
    ? edition.timeline.map((entry) => `<div class="timeline-item"><div class="minute">${escapeHtml(entry.minute)}</div><div><div>${escapeHtml(entry.label)}</div><div class="meta">Claim: ${escapeHtml((entry.claimRefs || []).join(", "))}</div></div></div>`).join("")
    : "<p class=\"meta\">此稿件没有时间线。</p>";
  const sections = (edition.sections || []).map((section) => `
    <section class="panel">
      <h2>${escapeHtml(section.title)}</h2>
      ${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p><p class="meta">Claim: ${escapeHtml((paragraph.claimRefs || []).join(", "))}</p>`).join("")}
    </section>`).join("");
  const claims = item.claims?.length
    ? item.claims.map((claim) => `<div class="claim"><strong>${escapeHtml(claim.id)}</strong><div class="meta">${escapeHtml(claim.kind)} · ${escapeHtml((claim.factRefs || []).join(", "))}</div><p>${escapeHtml(claim.summary)}</p></div>`).join("")
    : "<p class=\"meta\">此稿件没有 claim。</p>";
  const workflowMeaning = workflow.status === "release_blocked"
    ? blockedWorkflowMeaning(workflow)
    : workflow.status === "release_requested"
      ? "后台正在执行独立预审、合规审计与中文本地预发，本页稍后刷新状态即可。"
      : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(edition.title)} - 审稿预览</title><style>
  :root {
    --bg: #f3ecde;
    --panel: #fffaf1;
    --ink: #1f201d;
    --muted: #5a5f56;
    --line: #d9cdb8;
    --accent: #1f6b52;
    --soft: #dceadf;
    --warn: #8a5413;
    --warn-soft: #f7e7d3;
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); font-family: "PingFang SC","Noto Serif SC","Source Han Serif SC",serif; background: linear-gradient(180deg, #fbf7ee 0%, var(--bg) 48%, #ece0cb 100%); }
  main { width: min(1120px, calc(100vw - 28px)); margin: 0 auto; padding: 24px 0 44px; display: grid; gap: 18px; }
  h1, h2, h3, p { margin: 0; }
  .hero, .panel { border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 95%, white 5%); }
  .hero { padding: 22px; background: linear-gradient(135deg, rgba(31,107,82,0.1), rgba(255,250,241,0.96)); }
  .hero h1 { margin-top: 8px; font-size: clamp(2rem, 4vw, 3.4rem); line-height: 1.02; }
  .hero p { margin-top: 10px; line-height: 1.8; color: var(--muted); }
  .eyebrow { color: var(--muted); font-size: 0.95rem; }
  .grid { display: grid; gap: 18px; }
  .summary { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .panel { padding: 16px; }
  .panel h2, .panel h3 { margin-bottom: 10px; font-size: 1rem; }
  .meta { color: var(--muted); font-size: 0.95rem; line-height: 1.65; }
  .pill { display: inline-flex; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.5); }
  .list { margin: 0; padding-left: 18px; }
  .list li { margin-bottom: 6px; }
  .timeline-item { display: grid; grid-template-columns: 76px 1fr; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
  .timeline-item:first-child { border-top: 0; padding-top: 0; }
  .minute { color: var(--accent); font-weight: 700; }
  .claim { padding: 10px 0; border-top: 1px solid var(--line); }
  .claim:first-child { border-top: 0; padding-top: 0; }
  .banner { padding: 12px 14px; border: 1px solid #e0bf8a; background: var(--warn-soft); color: var(--warn); line-height: 1.7; }
  .two-col { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, 0.95fr); gap: 18px; }
  @media (max-width: 920px) { .two-col { grid-template-columns: 1fr; } }
  </style></head><body><main>
  <div class="banner">此页面仅用于私有审稿与发物审核，禁止公开分发、截图外传或作为生产发布页面使用。</div>
  <section class="hero">
    <div class="eyebrow">${escapeHtml(edition.competition || "未标注赛事")} · ${escapeHtml(edition.homeName)} vs ${escapeHtml(edition.awayName)}</div>
    <h1>${escapeHtml(edition.title)}</h1>
    <p>${escapeHtml(edition.deck || "")}</p>
  </section>
  <section class="grid summary">
    <article class="panel"><h3>审稿状态</h3><p class="pill">${escapeHtml(workflowStatusText(workflow.status))}</p><p class="meta">${escapeHtml(workflow.summary || "未记录")}</p>${workflowMeaning ? `<p class="meta">${escapeHtml(workflowMeaning)}</p>` : ""}</article>
    <article class="panel"><h3>编辑状态</h3><p class="meta">Edition: ${escapeHtml(edition.status)}</p><p class="meta">Compliance: ${escapeHtml(edition.complianceStatus)}</p><p class="meta">最近更新: ${escapeHtml(formatDate(workflow.updatedAt))}</p></article>
    <article class="panel"><h3>事实完整度</h3><p class="meta">双源确认数: ${escapeHtml(reviewItem.metrics.coreSourceConfirmations ?? "未记录")}</p><p class="meta">交锋样本: ${escapeHtml(reviewItem.metrics.h2hMatches ?? "未记录")}</p><p class="meta">缺口: ${escapeHtml(factGapText(reviewItem.metrics.missing))}</p></article>
    <article class="panel"><h3>发布申请</h3><p class="meta">请求语言: ${escapeHtml((release.requestedLocales || []).join(", ") || "未提交")}</p><p class="meta">最近决策: ${escapeHtml(release.decision || "未记录")}</p><p class="meta">决策时间: ${escapeHtml(formatDate(release.decisionAt))}</p></article>
  </section>
  <section class="two-col">
    <div class="grid">
      ${sections}
      <section class="panel"><h2>时间线</h2>${timeline}</section>
      <section class="panel"><h2>Claims</h2>${claims}</section>
    </div>
    <aside class="grid">
      <section class="panel">
        <h3>比赛信息</h3>
        <p class="meta">赛事时间: ${escapeHtml(formatDate(reviewItem.event?.startedAt || reviewItem.evidence?.match?.startedAt))}</p>
        <p class="meta">比分: ${escapeHtml(reviewItem.evidence?.match ? `${reviewItem.evidence.match.homeScore} - ${reviewItem.evidence.match.awayScore}` : edition.resultLabel || "未记录")}</p>
        <p class="meta">事实包状态: ${escapeHtml(reviewItem.evidence?.status || "未找到")}</p>
      </section>
      <section class="panel">
        <h3>阵容延续</h3>
        ${reviewItem.metrics.continuity?.length
    ? `<ul class="list">${reviewItem.metrics.continuity.map((entry) => `<li>${escapeHtml(entry.teamName)} 首发延续率 ${escapeHtml(entry.continuityRate)}%，共有 ${escapeHtml(entry.sharedStarters)}/${escapeHtml(entry.currentStarters)} 名首发连续出场</li>`).join("")}</ul>`
    : "<p class=\"meta\">未找到对应阵容延续数据。</p>"}
      </section>
      <section class="panel">
        <h3>发布阻断记录</h3>
        ${findingsHtml(release.findings)}
      </section>
    </aside>
  </section>
  </main></body></html>`;
}
