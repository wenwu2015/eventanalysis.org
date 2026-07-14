#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedArticles, ui, winRate } from "../lib/content.ts";
import { localeByCode, localeDefinitions } from "../lib/locales.ts";
import { activeSports, articlePath, sportByCode } from "../lib/sports.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const clientOutput = resolve(output, "client");
const baseUrl = "https://eventanalysis.org";
const adConfig = JSON.parse(await readFile(resolve(root, "site/ad-config.json"), "utf8"));
const activeSportCodes = new Set(activeSports.map(({ code }) => code));
const publicArticles = publishedArticles.filter((article) => activeSportCodes.has(article.sport));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll("&#39;", "&apos;");
}

function validateAds(config) {
  if (typeof config.enabled !== "boolean" || typeof config.placements !== "object" || !config.placements) {
    throw new Error("Ad config must contain enabled and placements");
  }
  for (const [placement, creative] of Object.entries(config.placements)) {
    if (!['page-top', 'content-mid'].includes(placement)) throw new Error(`Unknown ad placement: ${placement}`);
    if (![creative.headline, creative.body, creative.href].every((value) => typeof value === "string" && !/[<>]/.test(value))) {
      throw new Error(`Ad placement ${placement} must contain structured plain text`);
    }
    const url = new URL(creative.href);
    if (url.protocol !== "https:") throw new Error(`Ad placement ${placement} must use HTTPS`);
  }
}

validateAds(adConfig);

function alternateLinks(path = "", onlyLocales = localeDefinitions.map(({ code }) => code)) {
  return onlyLocales.map((code) => {
    const locale = localeByCode[code];
    return `<link rel="alternate" hreflang="${escapeHtml(locale.htmlLang)}" href="${baseUrl}/${code}${path}">`;
  }).join("");
}

function adSlot(placement) {
  if (!adConfig.enabled || !adConfig.placements[placement]) return "";
  return `<div data-ea-ad data-placement="${placement}"></div>`;
}

function adRuntime() {
  if (!adConfig.enabled) return "";
  const safeJson = JSON.stringify(adConfig).replaceAll("<", "\\u003c");
  return `<script id="ea-ad-config" type="application/json">${safeJson}</script><script src="/assets/ad-slot.js" defer></script>`;
}

function documentPage({
  lang = "en",
  dir = "ltr",
  title,
  description,
  canonical,
  alternates = "",
  body,
  jsonLd = "",
}) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="${safeDescription}">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>${safeTitle} · Event Analysis</title>
  <link rel="canonical" href="${baseUrl}${canonical}">
  ${alternates}
  <link rel="stylesheet" href="/assets/site.css">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Event Analysis">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  ${jsonLd}
</head>
<body>${body}${adRuntime()}</body>
</html>
`;
}

function languageMenu(locale, linkForLocale = (code) => `/${code}/`) {
  const copy = ui[locale];
  const current = localeByCode[locale];
  const links = localeDefinitions.map((item) => `
    <a href="${escapeHtml(linkForLocale(item.code))}" hreflang="${escapeHtml(item.htmlLang)}" lang="${escapeHtml(item.htmlLang)}" dir="${item.dir}"${item.code === locale ? ' aria-current="page"' : ""}>
      <span>${escapeHtml(item.nativeName)}</span><small>${escapeHtml(item.code.toUpperCase())}</small>
    </a>`).join("");
  return `<details class="locale-menu"><summary class="locale-switch" aria-label="${escapeHtml(copy.nav.languages)}">${escapeHtml(current.nativeName)} · ${localeDefinitions.length}</summary><div class="locale-menu-panel">${links}</div></details>`;
}

function shell(locale, content, { homeHref = `/${locale}/`, linkForLocale } = {}) {
  const copy = ui[locale];
  return `<div class="site-shell">
  <a class="skip-link" href="#main">${escapeHtml(copy.skip)}</a>
  <header class="site-header">
    <a href="${homeHref}" class="wordmark" aria-label="Event Analysis home"><span class="wordmark-ea">EA</span><span class="wordmark-name">Event Analysis</span></a>
    <nav class="site-nav" aria-label="Primary navigation">
      <a href="${homeHref}#latest">${escapeHtml(copy.nav.latest)}</a>
      <a href="/${locale}/archive">${escapeHtml(copy.nav.archive)}</a>
      <a href="/${locale}/methodology">${escapeHtml(copy.nav.methodology)}</a>
    </nav>
    ${languageMenu(locale, linkForLocale)}
  </header>
  ${adSlot("page-top")}
  <main id="main" class="page-main">${content}</main>
  <footer class="site-footer"><div class="footer-grid"><div class="footer-mark">EA</div><div class="footer-copy"><div class="footer-links"><a href="/${locale}/archive">${escapeHtml(copy.nav.archive)}</a><a href="/${locale}/methodology">${escapeHtml(copy.nav.methodology)}</a><a href="/${locale}/feed.xml">RSS</a></div><p>${escapeHtml(copy.footer)}</p><p>© 2026 EventAnalysis.org</p></div></div></footer>
</div>`;
}

function rootPage() {
  return homePage("en", { isRoot: true });
}

function headline(value) {
  return value.split("\n").map((line) => `${escapeHtml(line)}<br>`).join("");
}

function homePage(locale, { isRoot = false } = {}) {
  const copy = ui[locale];
  const article = publicArticles.find((item) => item.translations[locale]);
  const translation = article?.translations[locale];
  let lead;
  let numbers = "";
  if (article && translation) {
    const h2h = article.headToHeadBeforeMatch;
    const path = articlePath(locale, article.sport, article.slug);
    lead = `<article class="lead-story"><div class="lead-copy"><div class="story-kicker"><span class="story-status">${escapeHtml(copy.home.reviewed)}</span><span>${escapeHtml(translation.competition)}</span></div><h2><a href="${path}">${escapeHtml(translation.title)}</a></h2><p>${escapeHtml(translation.deck)}</p><a class="story-link" href="${path}">${escapeHtml(copy.home.read)} →</a></div><div class="score-panel"><span class="score-competition">${escapeHtml(translation.resultLabel)}</span><div><div class="scoreline"><span>${escapeHtml(translation.homeName)}</span><strong>${article.match.homeScore}</strong></div><div class="scoreline"><span>${escapeHtml(translation.awayName)}</span><strong>${article.match.awayScore}</strong></div></div><span class="score-date">${escapeHtml(translation.venue)} · 14.07.2024</span></div></article>`;
    numbers = `<section class="section page-width"><div class="section-heading"><h2>${escapeHtml(copy.home.numbers)}</h2><span class="eyebrow">H2H · PRE-MATCH</span></div><div class="numbers-grid"><div class="number-card"><strong>${h2h.matches}</strong><span>${escapeHtml(copy.home.meetings)}</span></div><div class="number-card"><strong>${winRate(h2h.homeWins, h2h.matches)}</strong><span>${escapeHtml(translation.homeName)} · ${escapeHtml(copy.home.winRate)}</span></div><div class="number-card"><strong>${winRate(h2h.awayWins, h2h.matches)}</strong><span>${escapeHtml(translation.awayName)} · ${escapeHtml(copy.home.winRate)}</span></div><div class="number-card"><strong>86′</strong><span>${escapeHtml(copy.home.winnerMinute)}</span></div></div></section>`;
  } else {
    lead = `<div class="edition-empty"><span class="edition-empty-code">${escapeHtml(locale.toUpperCase())}</span><div><h3>${escapeHtml(copy.home.emptyTitle)}</h3><p>${escapeHtml(copy.home.emptyBody)}</p></div></div>`;
  }
  const cards = copy.home.cards.map(([title, body], index) => `<article class="brief-card"><span class="brief-card-index">0${index + 1}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></article>`).join("");
  const content = `<section class="masthead page-width"><p class="eyebrow">${escapeHtml(copy.home.eyebrow)}</p><h1>${headline(copy.home.headline)}</h1><div class="masthead-bottom"><p class="masthead-intro">${escapeHtml(copy.home.intro)}</p><div class="edition-stamp"><span><span class="live-dot"></span>${escapeHtml(copy.home.desk)}</span><span>${escapeHtml(copy.home.scope)}</span></div></div></section><section id="latest" class="section page-width"><div class="section-heading"><h2>${escapeHtml(copy.home.latest)}</h2><a href="/${locale}/archive">${escapeHtml(copy.home.all)}</a></div>${lead}</section>${adSlot("content-mid")}${numbers}<section class="section page-width"><div class="section-heading"><h2>${escapeHtml(copy.home.framework)}</h2><a href="/${locale}/methodology">${escapeHtml(copy.nav.methodology)}</a></div><div class="brief-grid">${cards}</div></section>`;
  const alternates = `${alternateLinks()}<link rel="alternate" hreflang="x-default" href="${baseUrl}/">`;
  return documentPage({ lang: localeByCode[locale].htmlLang, dir: localeByCode[locale].dir, title: copy.pageTitle, description: copy.pageDescription, canonical: isRoot ? "/" : `/${locale}`, alternates, body: shell(locale, content, { homeHref: isRoot ? "/" : `/${locale}/` }) });
}

function archivePage(locale) {
  const copy = ui[locale];
  const articles = publicArticles.filter((article) => article.translations[locale]);
  const rows = articles.map((article) => {
    const translation = article.translations[locale];
    const date = new Intl.DateTimeFormat(localeByCode[locale].htmlLang).format(new Date(article.publishedAt));
    return `<a class="archive-row" href="${articlePath(locale, article.sport, article.slug)}"><time datetime="${escapeHtml(article.publishedAt)}">${escapeHtml(date)}</time><h2>${escapeHtml(translation.title)}</h2><span class="archive-meta">${escapeHtml(translation.competition)}</span><strong class="archive-score">${article.match.homeScore}–${article.match.awayScore}</strong></a>`;
  }).join("") || `<p class="archive-empty">${escapeHtml(copy.archive.empty)}</p>`;
  const content = `<div class="page-width"><header class="page-hero"><p class="eyebrow">Event Analysis · Index</p><h1>${escapeHtml(copy.archive.title)}</h1><p>${escapeHtml(copy.archive.intro)}</p></header><section class="section"><div class="archive-list">${rows}</div></section>${adSlot("content-mid")}</div>`;
  return documentPage({ lang: localeByCode[locale].htmlLang, dir: localeByCode[locale].dir, title: copy.archive.title, description: copy.archive.intro, canonical: `/${locale}/archive`, alternates: alternateLinks("/archive"), body: shell(locale, content, { linkForLocale: (code) => `/${code}/archive/` }) });
}

function methodologyPage(locale) {
  const copy = ui[locale];
  const steps = copy.method.steps.map(([title, body]) => `<section><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></section>`).join("");
  const content = `<div class="page-width"><header class="page-hero"><p class="eyebrow">Editorial standard · v1.0</p><h1>${escapeHtml(copy.method.title)}</h1><p>${escapeHtml(copy.method.intro)}</p></header><section class="section method-grid"><aside class="method-aside">${escapeHtml(copy.method.flow)}</aside><div class="method-content">${steps}<p class="policy-note">${escapeHtml(copy.method.policy)}</p></div></section>${adSlot("content-mid")}</div>`;
  return documentPage({ lang: localeByCode[locale].htmlLang, dir: localeByCode[locale].dir, title: copy.method.title, description: copy.method.intro, canonical: `/${locale}/methodology`, alternates: alternateLinks("/methodology"), body: shell(locale, content, { linkForLocale: (code) => `/${code}/methodology/` }) });
}

function articlePage(locale, article) {
  const t = article.translations[locale];
  const labels = ui[locale].article;
  const h2h = article.headToHeadBeforeMatch;
  const published = new Intl.DateTimeFormat(localeByCode[locale].htmlLang, { dateStyle: "long" }).format(new Date(article.publishedAt));
  const rows = [
    [t.homeName + " " + labels.wins, h2h.homeWins, winRate(h2h.homeWins, h2h.matches)],
    [labels.draws, h2h.draws, winRate(h2h.draws, h2h.matches)],
    [t.awayName + " " + labels.wins, h2h.awayWins, winRate(h2h.awayWins, h2h.matches)],
  ].map(([name, count, rate]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td><td>${rate}</td></tr>`).join("");
  const personnel = t.personnelParagraphs.map((paragraph, index) => `<p><span class="${index === 0 ? "fact-label" : "analysis-label"}">${escapeHtml(index === 0 ? labels.change : labels.analysis)}</span>${escapeHtml(paragraph)}</p>`).join("");
  const timeline = t.events.map((event) => `<div class="timeline-row"><span class="timeline-minute">${escapeHtml(event.minute)}</span><div class="timeline-event"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.detail)}</span></div></div>`).join("");
  const results = t.resultParagraphs.map((paragraph) => `<p><span class="fact-label">${escapeHtml(labels.fact)}</span>${escapeHtml(paragraph)}</p>`).join("");
  const verdict = t.verdictParagraphs.map((paragraph) => `<p><span class="analysis-label">${escapeHtml(labels.reading)}</span>${escapeHtml(paragraph)}</p>`).join("");
  const content = `<article class="page-width"><header class="article-header"><p class="eyebrow">${escapeHtml(t.competition)}</p><h1>${escapeHtml(t.title)}</h1><p class="article-deck">${escapeHtml(t.deck)}</p><div class="article-byline"><span>${escapeHtml(article.author)}</span><time datetime="${escapeHtml(article.publishedAt)}">${escapeHtml(published)}</time><span>${escapeHtml(labels.reviewed)}</span></div></header><div class="matchboard" aria-label="${escapeHtml(`${t.homeName} ${article.match.homeScore}, ${t.awayName} ${article.match.awayScore}`)}"><div class="matchboard-team"><strong>${escapeHtml(t.homeName)}</strong><span>${escapeHtml(t.venue)}</span></div><div class="matchboard-score">${article.match.homeScore}–${article.match.awayScore}</div><div class="matchboard-team"><strong>${escapeHtml(t.awayName)}</strong><span>${escapeHtml(t.resultLabel)}</span></div></div><div class="article-layout"><aside class="article-rail" aria-label="Article facts"><div class="rail-box"><strong>${escapeHtml(labels.confidence)}</strong><span>${article.confidence}/100</span></div><div class="rail-box"><strong>${escapeHtml(labels.historicalSample)}</strong><span>${h2h.matches} ${escapeHtml(labels.matches)}</span></div><div class="rail-box"><strong>${escapeHtml(labels.contentType)}</strong><span>${escapeHtml(labels.postMatch)}</span></div></aside><div class="article-body"><section><h2>${escapeHtml(t.h2hTitle)}</h2><p><span class="fact-label">${escapeHtml(labels.fact)}</span>${escapeHtml(t.h2hIntro)}</p><div class="data-table-wrap"><table class="data-table"><thead><tr><th>${escapeHtml(labels.outcome)}</th><th>${escapeHtml(labels.matches)}</th><th>${escapeHtml(labels.share)}</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>${escapeHtml(t.personnelTitle)}</h2>${personnel}</section>${adSlot("content-mid")}<section><h2>${escapeHtml(t.resultTitle)}</h2><div class="timeline">${timeline}</div>${results}</section><section><h2>${escapeHtml(t.verdictTitle)}</h2>${verdict}<div class="confidence"><div class="confidence-head"><span>${escapeHtml(labels.evidence)}</span><strong>${article.confidence}%</strong></div><div class="confidence-track"><div class="confidence-fill" style="width:${article.confidence}%"></div></div></div></section></div></div></article>`;
  const translatedLocales = Object.keys(article.translations);
  const sportBase = sportByCode[article.sport].publicBasePath;
  const canonicalPath = articlePath(locale, article.sport, article.slug);
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Article", headline: t.title, description: t.deck, datePublished: article.publishedAt, dateModified: article.reviewedAt, inLanguage: localeByCode[locale].htmlLang, author: { "@type": "Organization", name: article.author }, publisher: { "@type": "Organization", name: "Event Analysis" }, mainEntityOfPage: `${baseUrl}${canonicalPath}` }, { "@type": "SportsEvent", name: `${t.homeName} ${article.match.homeScore}–${article.match.awayScore} ${t.awayName}`, sport: sportByCode[article.sport].name, startDate: article.match.startedAt, location: { "@type": "Place", name: t.venue }, homeTeam: { "@type": "SportsTeam", name: t.homeName }, awayTeam: { "@type": "SportsTeam", name: t.awayName } }] }).replaceAll("<", "\\u003c")}</script>`;
  return documentPage({ lang: localeByCode[locale].htmlLang, dir: localeByCode[locale].dir, title: t.title, description: t.deck, canonical: canonicalPath, alternates: alternateLinks(`${sportBase}/articles/${article.slug}`, translatedLocales), body: shell(locale, content, { linkForLocale: (code) => article.translations[code] ? `${articlePath(code, article.sport, article.slug)}/` : `/${code}/` }), jsonLd });
}

function feed(locale) {
  const definition = localeByCode[locale];
  const articles = publicArticles.filter((article) => article.translations[locale]);
  const items = articles.map((article) => {
    const t = article.translations[locale];
    const url = `${baseUrl}${articlePath(locale, article.sport, article.slug)}`;
    return `<item><title>${escapeXml(t.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate><description>${escapeXml(t.deck)}</description></item>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Event Analysis · ${escapeXml(definition.nativeName)}</title><link>${baseUrl}/${locale}</link><description>${escapeXml(definition.nativeName)} · Event Analysis</description><language>${definition.htmlLang}</language><lastBuildDate>${new Date(articles[0]?.publishedAt || publicArticles[0].publishedAt).toUTCString()}</lastBuildDate>${items}</channel></rss>\n`;
}

async function writeFileEnsured(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeRoute(route, html) {
  const path = route === "/" ? resolve(clientOutput, "index.html") : resolve(clientOutput, route.slice(1), "index.html");
  await writeFileEnsured(path, html);
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(clientOutput, "assets"), { recursive: true });
await cp(resolve(root, "site/site.css"), resolve(clientOutput, "assets/site.css"));
await cp(resolve(root, "site/ad-slot.js"), resolve(clientOutput, "assets/ad-slot.js"));
await writeRoute("/", rootPage());

for (const { code } of localeDefinitions) {
  await writeRoute(`/${code}`, homePage(code));
  await writeRoute(`/${code}/archive`, archivePage(code));
  await writeRoute(`/${code}/methodology`, methodologyPage(code));
  await writeFileEnsured(resolve(clientOutput, code, "feed.xml"), feed(code));
}

for (const article of publicArticles) {
  for (const locale of Object.keys(article.translations)) {
    await writeRoute(articlePath(locale, article.sport, article.slug), articlePage(locale, article));
  }
}

const staticPaths = ["/", ...localeDefinitions.flatMap(({ code }) => [`/${code}`, `/${code}/archive`, `/${code}/methodology`])];
const articlePaths = publicArticles.flatMap((article) => Object.keys(article.translations).map((locale) => articlePath(locale, article.sport, article.slug)));
const lastModified = new Date(publicArticles[0].publishedAt).toISOString();
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...staticPaths, ...articlePaths].map((path) => `<url><loc>${baseUrl}${path}</loc><lastmod>${lastModified}</lastmod></url>`).join("")}</urlset>\n`;
await writeFileEnsured(resolve(clientOutput, "sitemap.xml"), sitemap);
await writeFileEnsured(resolve(clientOutput, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\nHost: ${baseUrl}\n`);
await writeFileEnsured(resolve(clientOutput, "404.html"), documentPage({ title: "Page not found", description: "The requested page does not exist.", canonical: "/404", body: shell("en", `<div class="not-found"><div><strong>404</strong><h1>Page not found</h1><a href="/en/">Event Analysis</a></div></div>`) }));

console.log(`Generated ${1 + localeDefinitions.length * 3 + articlePaths.length} framework-free HTML pages in dist/.`);
