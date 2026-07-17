#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ui } from "../lib/ui-copy.mjs";
import { legalCopy } from "../lib/legal-copy.mjs";
import { validateContentData, routeKeyForType, routePath, absoluteUrl } from "./lib/data-store.mjs";
import { isEditionLocallyPreviewable, isEditionPublishable } from "./lib/compliance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputArgument = process.argv.find((value) => value.startsWith("--output="))?.split("=")[1];
const includeApproved = process.argv.includes("--include-approved");
const localeArgument = process.argv.find((value) => value.startsWith("--locales="))?.slice("--locales=".length);
const clientOutput = outputArgument ? resolve(root, outputArgument) : resolve(root, "dist/client");
const baseUrl = "https://eventanalysis.org";
const [data, locales, sports, adConfig] = await Promise.all([
  validateContentData(root),
  readJson("content/locales.json"),
  readJson("content/sports.json"),
  readJson("site/ad-config.json"),
]);
const localeMap = new Map(locales.map((locale) => [locale.code, locale]));
const buildLocaleCodes = localeArgument ? localeArgument.split(",").filter(Boolean) : locales.map(({ code }) => code);
const unknownBuildLocale = buildLocaleCodes.find((code) => !localeMap.has(code));
if (unknownBuildLocale) throw new Error(`Unknown build locale: ${unknownBuildLocale}`);
const entityMap = new Map(data.entities.map((entity) => [entity.id, entity]));
const eventMap = new Map(data.events.map((event) => [event.id, event]));
const factMap = new Map(data.facts.map((fact) => [fact.id, fact]));
const activeSports = sports.filter(({ status }) => status === "active");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll("&#39;", "&apos;");
}

function encodedPath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function titleCaseSegment(value) {
  const text = String(value).replaceAll("-", " ");
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

function route(locale, sport, routeKey, slug) {
  return routePath({ locale, sport, routeKey, slug, routes: data.routes });
}

function homeRoute(locale, sport = "football") {
  return `/${locale}/${sport}/`;
}

function legalRoute(locale, sport = "football") {
  return `/${locale}/${sport}/legal/`;
}

function publicationDate(item) {
  return item.publishedAt || item.reviewedAt || eventMap.get(item.eventRefs?.[0])?.startedAt || "1970-01-01T00:00:00Z";
}

function isEditionVisible(item, locale) {
  return includeApproved ? isEditionLocallyPreviewable(item, locale) : isEditionPublishable(item, locale);
}

function publishedEntries(locale, sport = "football") {
  return data.items
    .filter((item) => item.sport === sport && isEditionVisible(item, locale))
    .map((item) => ({ item, edition: item.editions[locale], path: route(locale, sport, routeKeyForType(item.type), item.editions[locale].slug) }))
    .sort((a, b) => {
      const published = new Date(publicationDate(b.item)) - new Date(publicationDate(a.item));
      if (published) return published;
      const priority = (entry) => entry.item.type === "match_analysis" ? 3 : entry.item.type === "competition_story" ? 2 : 1;
      const typeOrder = priority(b) - priority(a);
      if (typeOrder) return typeOrder;
      const eventTime = (entry) => eventMap.get(entry.item.eventRefs?.[0])?.startedAt || "";
      return eventTime(b).localeCompare(eventTime(a));
    });
}

function validateAds(config) {
  if (typeof config.enabled !== "boolean" || !config.placements || typeof config.placements !== "object") throw new Error("Ad config must contain enabled and placements");
  for (const [placement, creative] of Object.entries(config.placements)) {
    if (!["page-top", "content-mid"].includes(placement)) throw new Error(`Unknown ad placement: ${placement}`);
    if (![creative.headline, creative.body, creative.href].every((value) => typeof value === "string" && !/[<>]/.test(value))) throw new Error(`Ad placement ${placement} must use structured plain text`);
    if (new URL(creative.href).protocol !== "https:") throw new Error(`Ad placement ${placement} must use HTTPS`);
  }
}
validateAds(adConfig);

function adSlot(placement) {
  return adConfig.enabled && adConfig.placements[placement] ? `<div data-ea-ad data-placement="${placement}"></div>` : "";
}

function adRuntime() {
  if (!adConfig.enabled) return "";
  return `<script id="ea-ad-config" type="application/json">${JSON.stringify(adConfig).replaceAll("<", "\\u003c")}</script><script src="/assets/ad-slot.js" defer></script>`;
}

function alternateLinks(alternates, xDefault) {
  const links = alternates.map(({ locale, path }) => `<link rel="alternate" hreflang="${escapeHtml(localeMap.get(locale).htmlLang)}" href="${absoluteUrl(path)}">`);
  if (xDefault) links.push(`<link rel="alternate" hreflang="x-default" href="${absoluteUrl(xDefault)}">`);
  return links.join("\n  ");
}

function documentPage({ locale = "en", title, description, canonical, alternates = [], xDefault, body, jsonLd = [], robots = "index,follow", scripts = [] }) {
  const definition = localeMap.get(locale) || localeMap.get("en");
  const structured = jsonLd.length ? `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": jsonLd }).replaceAll("<", "\\u003c")}</script>` : "";
  return `<!doctype html>
<html lang="${escapeHtml(definition.htmlLang)}" dir="${definition.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${robots}">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>${escapeHtml(title)} · Event Analysis</title>
  <link rel="canonical" href="${absoluteUrl(canonical)}">
  ${alternateLinks(alternates, xDefault)}
  <link rel="stylesheet" href="/assets/site.css">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Event Analysis">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  ${structured}
</head>
<body>${body}${scripts.map((src) => `<script src="${src}" defer></script>`).join("")}${adRuntime()}</body>
</html>
`;
}

function languageMenu(locale, linkForLocale) {
  const visibleLocales = locales.filter(({ code }) => buildLocaleCodes.includes(code));
  const links = visibleLocales.map((entry) => {
    const href = linkForLocale(entry.code);
    return `<a href="${encodedPath(href)}" hreflang="${escapeHtml(entry.htmlLang)}" lang="${escapeHtml(entry.htmlLang)}" dir="${entry.dir}"${entry.code === locale ? ' aria-current="page"' : ""}><span>${escapeHtml(entry.nativeName)}</span><small>${escapeHtml(entry.code.toUpperCase())}</small></a>`;
  }).join("");
  return `<details class="locale-menu"><summary class="locale-switch" aria-label="${escapeHtml(ui[locale].nav.languages)}">${escapeHtml(localeMap.get(locale).nativeName)} · ${visibleLocales.length}</summary><div class="locale-menu-panel">${links}</div></details>`;
}

function shell(locale, sport, content, { linkForLocale = (code) => homeRoute(code, sport) } = {}) {
  const copy = ui[locale];
  const entries = publishedEntries(locale, sport);
  const allPath = route(locale, sport, "all-content");
  const searchPath = route(locale, sport, "search");
  const nav = [`<a href="${encodedPath(homeRoute(locale, sport))}#latest">${escapeHtml(copy.nav.latest)}</a>`];
  if (entries.length) {
    nav.push(`<a href="${encodedPath(allPath)}">${escapeHtml(titleCaseSegment(data.routes.locales[locale]["all-content"]))}</a>`);
    nav.push(`<a href="${encodedPath(searchPath)}">${escapeHtml(titleCaseSegment(data.routes.locales[locale].search))}</a>`);
  }
  const footerLinks = `${entries.length ? `<a href="${encodedPath(allPath)}">${escapeHtml(titleCaseSegment(data.routes.locales[locale]["all-content"]))}</a><a href="${encodedPath(homeRoute(locale, sport))}feed.xml">RSS</a>` : ""}<a href="${encodedPath(legalRoute(locale, sport))}">${escapeHtml(legalCopy[locale].label)}</a>`;
  return `<div class="site-shell">
  <a class="skip-link" href="#main">${escapeHtml(copy.skip)}</a>
  <header class="site-header">
    <a href="${encodedPath(homeRoute(locale, sport))}" class="wordmark" aria-label="Event Analysis home"><span class="wordmark-ea">EA</span><span class="wordmark-name">Event Analysis</span></a>
    <nav class="site-nav" aria-label="Primary navigation">${nav.join("")}</nav>
    ${languageMenu(locale, linkForLocale)}
  </header>
  ${adSlot("page-top")}
  <main id="main" class="page-main">${content}</main>
  <footer class="site-footer"><div class="footer-grid"><div class="footer-mark">EA</div><div class="footer-copy"><div class="footer-links">${footerLinks}</div><p>${escapeHtml(copy.footer)}</p><p>© 2026 EventAnalysis.org</p></div></div></footer>
</div>`;
}

function legalPage(locale, sport) {
  const copy = legalCopy[locale];
  const canonical = legalRoute(locale, sport);
  const alternates = locales.map(({ code }) => ({ locale: code, path: legalRoute(code, sport) }));
  const content = `<div class="page-width"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${encodedPath(homeRoute(locale, sport))}">EA</a><span>·</span><span>${escapeHtml(copy.label)}</span></nav><header class="page-hero"><p class="eyebrow">EventAnalysis.org</p><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.intro)}</p></header><section class="section legal-contact"><p>${escapeHtml(copy.policy)}</p><p><a href="mailto:legal@eventanalysis.org">${escapeHtml(copy.contact)} · legal@eventanalysis.org</a></p></section></div>`;
  return documentPage({ locale, title: copy.title, description: copy.intro, canonical, alternates, xDefault: legalRoute("en", sport), body: shell(locale, sport, content, { linkForLocale: (code) => legalRoute(code, sport) }), jsonLd: [{ "@type": "WebPage", name: copy.title, description: copy.intro, inLanguage: localeMap.get(locale).htmlLang, url: absoluteUrl(canonical) }] });
}

function homePage(locale, sport) {
  const copy = ui[locale];
  const entries = publishedEntries(locale, sport);
  const leadEntry = entries[0];
  const lead = leadEntry ? leadStory(locale, leadEntry) : `<div class="editorial-principles">${copy.home.cards.map(([title, text], index) => `<article class="brief-card"><span class="brief-card-index">0${index + 1}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></article>`).join("")}</div>`;
  const latestHeading = entries.length ? `<div class="section-heading"><h2>${escapeHtml(copy.home.latest)}</h2><a href="${encodedPath(route(locale, sport, "all-content"))}">${escapeHtml(titleCaseSegment(data.routes.locales[locale]["all-content"]))}</a></div>` : `<div class="section-heading"><h2>${escapeHtml(copy.home.framework)}</h2></div>`;
  const additional = entries.length ? `<section class="section page-width"><div class="section-heading"><h2>${escapeHtml(copy.home.framework)}</h2></div><div class="brief-grid">${copy.home.cards.map(([title, text], index) => `<article class="brief-card"><span class="brief-card-index">0${index + 1}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></article>`).join("")}</div></section>` : "";
  const content = `<section class="masthead page-width"><p class="eyebrow">${escapeHtml(copy.home.eyebrow)}</p><h1>${copy.home.headline.split("\n").map(escapeHtml).join("<br>")}</h1><div class="masthead-bottom"><p class="masthead-intro">${escapeHtml(copy.home.intro)}</p><div class="edition-stamp"><span><span class="live-dot"></span>${escapeHtml(copy.home.desk)}</span><span>${escapeHtml(copy.home.scope)}</span></div></div></section><section id="latest" class="section page-width">${latestHeading}${lead}</section>${adSlot("content-mid")}${additional}`;
  const canonical = homeRoute(locale, sport);
  const alternates = locales.map(({ code }) => ({ locale: code, path: homeRoute(code, sport) }));
  return documentPage({ locale, title: copy.pageTitle, description: copy.pageDescription, canonical, alternates, xDefault: homeRoute("en", sport), body: shell(locale, sport, content), jsonLd: [{ "@type": "CollectionPage", name: copy.pageTitle, description: copy.pageDescription, inLanguage: localeMap.get(locale).htmlLang, url: absoluteUrl(canonical) }] });
}

function leadStory(locale, { item, edition, path }) {
  const event = eventMap.get(item.eventRefs[0]);
  return `<article class="lead-story"><div class="lead-copy"><div class="story-kicker"><span class="story-status">${escapeHtml(ui[locale].home.reviewed)}</span><span>${escapeHtml(edition.competition)}</span></div><h2><a href="${encodedPath(path)}">${escapeHtml(edition.title)}</a></h2><p>${escapeHtml(edition.deck)}</p><a class="story-link" href="${encodedPath(path)}">${escapeHtml(ui[locale].home.read)} →</a></div><div class="score-panel"><span class="score-competition">${escapeHtml(edition.resultLabel)}</span><div><div class="scoreline"><span>${escapeHtml(edition.homeName)}</span><strong>${event.homeScore}</strong></div><div class="scoreline"><span>${escapeHtml(edition.awayName)}</span><strong>${event.awayScore}</strong></div></div><span class="score-date">${escapeHtml(edition.venue)} · ${event.startedAt.slice(0, 10)}</span></div></article>`;
}

function collectionPage(locale, sport, routeKey, entries) {
  const copy = ui[locale];
  const title = titleCaseSegment(data.routes.locales[locale][routeKey]);
  const intro = routeKey === "all-content" ? copy.archive.intro : copy.pageDescription;
  const canonical = route(locale, sport, routeKey);
  const rows = entries.map(({ item, edition, path }) => {
    const event = eventMap.get(item.eventRefs[0]);
    const dateValue = publicationDate(item);
    const date = new Intl.DateTimeFormat(localeMap.get(locale).htmlLang).format(new Date(dateValue));
    return `<a class="archive-row" href="${encodedPath(path)}"><time datetime="${escapeHtml(dateValue)}">${escapeHtml(date)}</time><h2>${escapeHtml(edition.title)}</h2><span class="archive-meta">${escapeHtml(edition.competition || title)}</span><strong class="archive-score">${event ? `${event.homeScore}–${event.awayScore}` : "EA"}</strong></a>`;
  }).join("");
  const content = `<div class="page-width"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${encodedPath(homeRoute(locale, sport))}">EA</a><span>·</span><span>${escapeHtml(title)}</span></nav><header class="page-hero"><p class="eyebrow">Event Analysis · ${escapeHtml(sport)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p></header><section class="section"><div class="archive-list">${rows}</div></section>${adSlot("content-mid")}</div>`;
  const alternateLocales = locales.filter(({ code }) => {
    const candidates = publishedEntries(code, sport);
    return routeKey === "all-content" ? candidates.length : candidates.some(({ item }) => routeKeyForType(item.type) === routeKey);
  }).map(({ code }) => ({ locale: code, path: route(code, sport, routeKey) }));
  return documentPage({ locale, title, description: intro, canonical, alternates: alternateLocales, xDefault: alternateLocales.find(({ locale: code }) => code === "en")?.path, body: shell(locale, sport, content, { linkForLocale: (code) => publishedEntries(code, sport).length ? route(code, sport, routeKey) : homeRoute(code, sport) }), jsonLd: [{ "@type": "CollectionPage", name: title, description: intro, inLanguage: localeMap.get(locale).htmlLang, url: absoluteUrl(canonical) }, breadcrumbJson(locale, sport, [{ name: title, path: canonical }])] });
}

function searchPage(locale, sport, entries) {
  const title = titleCaseSegment(data.routes.locales[locale].search);
  const canonical = route(locale, sport, "search");
  const labels = locale === "zh" ? { query: "关键词", type: "内容类型", person: "人物", team: "球队", competition: "赛事", place: "地点", year: "年份", all: "全部", noResults: "没有匹配内容。" } : { query: "Keywords", type: "Content type", person: "Person", team: "Team", competition: "Competition", place: "Place", year: "Year", all: "All", noResults: "No matching content." };
  const cards = entries.map(({ item, edition, path }) => `<article class="search-result" data-search-result data-text="${escapeHtml([edition.title, edition.deck, ...item.entityRefs.map((id) => entityMap.get(id)?.names?.[locale] || entityMap.get(id)?.canonicalName || id), ...item.eventRefs].join(" ").toLocaleLowerCase())}" data-type="${escapeHtml(item.type)}" data-year="${escapeHtml(new Date(publicationDate(item)).getFullYear())}" data-entities="${escapeHtml(item.entityRefs.join(" "))}"><p class="eyebrow">${escapeHtml(edition.competition || item.type)}</p><h2><a href="${encodedPath(path)}">${escapeHtml(edition.title)}</a></h2><p>${escapeHtml(edition.deck)}</p></article>`).join("");
  const types = [...new Set(entries.map(({ item }) => item.type))].map((type) => `<option value="${type}">${escapeHtml(titleCaseSegment(data.routes.locales[locale][routeKeyForType(type)]))}</option>`).join("");
  const years = [...new Set(entries.map(({ item }) => String(new Date(publicationDate(item)).getFullYear())))].sort().reverse().map((year) => `<option value="${year}">${year}</option>`).join("");
  const facet = (kind, label) => {
    const ids = [...new Set(entries.flatMap(({ item }) => item.entityRefs).filter((id) => entityMap.get(id)?.kind === kind))];
    if (!ids.length) return "";
    const options = ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(entityMap.get(id).names?.[locale] || entityMap.get(id).canonicalName)}</option>`).join("");
    return `<label>${escapeHtml(label)}<select data-search-facet="entities"><option value="">${escapeHtml(labels.all)}</option>${options}</select></label>`;
  };
  const content = `<div class="page-width"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${encodedPath(homeRoute(locale, sport))}">EA</a><span>·</span><span>${escapeHtml(title)}</span></nav><header class="page-hero"><p class="eyebrow">Event Analysis · Search</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(ui[locale].pageDescription)}</p></header><div class="search-controls"><label>${escapeHtml(labels.query)}<input type="search" data-search-query autocomplete="off"></label><label>${escapeHtml(labels.type)}<select data-search-facet="type"><option value="">${escapeHtml(labels.all)}</option>${types}</select></label>${facet("Person", labels.person)}${facet("Team", labels.team)}${facet("Competition", labels.competition)}${facet("Place", labels.place)}<label>${escapeHtml(labels.year)}<select data-search-facet="year"><option value="">${escapeHtml(labels.all)}</option>${years}</select></label></div><p class="search-empty" data-search-empty hidden>${escapeHtml(labels.noResults)}</p><section class="search-results">${cards}</section></div>`;
  return documentPage({ locale, title, description: ui[locale].pageDescription, canonical, robots: "noindex,follow", body: shell(locale, sport, content, { linkForLocale: (code) => publishedEntries(code, sport).length ? route(code, sport, "search") : homeRoute(code, sport) }), scripts: ["/assets/search.js"] });
}

function breadcrumbJson(locale, sport, tail) {
  return { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Event Analysis", item: absoluteUrl(homeRoute(locale, sport)) }, ...tail.map((entry, index) => ({ "@type": "ListItem", position: index + 2, name: entry.name, item: absoluteUrl(entry.path) }))] };
}

function articlePage(locale, item, edition) {
  const event = eventMap.get(item.eventRefs[0]);
  if (!event) throw new Error(`Article ${item.id} has no event`);
  const labels = ui[locale].article;
  const h2h = [...factMap.values()].find((fact) => fact.subjectId === event.id && fact.predicate === "head_to_head_before_match")?.value;
  const path = route(locale, item.sport, routeKeyForType(item.type), edition.slug);
  const sectionPath = route(locale, item.sport, routeKeyForType(item.type));
  const claims = new Map(item.claims.map((claim) => [claim.id, claim]));
  const sections = edition.sections.map((section) => `<section><h2>${escapeHtml(section.title)}</h2>${section.id === "history" && h2h ? h2hTable(locale, edition, h2h) : ""}${section.id === "result" && edition.timeline?.length ? timeline(edition.timeline) : ""}${section.paragraphs.map((paragraph) => { const analysis = paragraph.claimRefs.some((id) => claims.get(id)?.kind === "analysis"); return `<p><span class="${analysis ? "analysis-label" : "fact-label"}">${escapeHtml(analysis ? labels.analysis : labels.fact)}</span>${escapeHtml(paragraph.text)}</p>`; }).join("")}</section>`).join("");
  const dateValue = publicationDate(item);
  const published = new Intl.DateTimeFormat(localeMap.get(locale).htmlLang, { dateStyle: "long" }).format(new Date(dateValue));
  const content = `<article class="page-width"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${encodedPath(homeRoute(locale, item.sport))}">EA</a><span>·</span><a href="${encodedPath(sectionPath)}">${escapeHtml(titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]))}</a><span>·</span><span>${escapeHtml(edition.homeName)} – ${escapeHtml(edition.awayName)}</span></nav><header class="article-header"><p class="eyebrow">${escapeHtml(edition.competition)}</p><h1>${escapeHtml(edition.title)}</h1><p class="article-deck">${escapeHtml(edition.deck)}</p><div class="article-byline"><span>${escapeHtml(item.author)}</span><time datetime="${escapeHtml(dateValue)}">${escapeHtml(published)}</time><span>${escapeHtml(labels.reviewed)}</span></div></header><div class="matchboard" aria-label="${escapeHtml(`${edition.homeName} ${event.homeScore}, ${edition.awayName} ${event.awayScore}`)}"><div class="matchboard-team"><strong>${escapeHtml(edition.homeName)}</strong><span>${escapeHtml(edition.venue)}</span></div><div class="matchboard-score">${event.homeScore}–${event.awayScore}</div><div class="matchboard-team"><strong>${escapeHtml(edition.awayName)}</strong><span>${escapeHtml(edition.resultLabel)}</span></div></div><div class="article-layout"><aside class="article-rail"><div class="rail-box"><strong>${escapeHtml(labels.confidence)}</strong><span>${item.confidence}/100</span></div><div class="rail-box"><strong>${escapeHtml(labels.historicalSample)}</strong><span>${h2h?.matches || 0} ${escapeHtml(labels.matches)}</span></div><div class="rail-box"><strong>${escapeHtml(labels.contentType)}</strong><span>${escapeHtml(labels.postMatch)}</span></div></aside><div class="article-body">${sections}<div class="confidence"><div class="confidence-head"><span>${escapeHtml(labels.evidence)}</span><strong>${item.confidence}%</strong></div><div class="confidence-track"><div class="confidence-fill" style="width:${item.confidence}%"></div></div></div></div></div>${adSlot("content-mid")}</article>`;
  const translations = Object.entries(item.editions).filter(([code]) => isEditionVisible(item, code)).map(([code, candidate]) => ({ locale: code, path: route(code, item.sport, routeKeyForType(item.type), candidate.slug) }));
  const graph = [{ "@type": "Article", headline: edition.title, description: edition.deck, datePublished: dateValue, dateModified: item.reviewedAt || dateValue, inLanguage: localeMap.get(locale).htmlLang, author: { "@type": "Organization", name: item.author }, publisher: { "@type": "Organization", name: "Event Analysis" }, mainEntityOfPage: absoluteUrl(path) }, { "@type": "SportsEvent", name: `${edition.homeName} ${event.homeScore}–${event.awayScore} ${edition.awayName}`, sport: "Football", startDate: event.startedAt, location: { "@type": "Place", name: edition.venue }, homeTeam: { "@type": "SportsTeam", name: edition.homeName }, awayTeam: { "@type": "SportsTeam", name: edition.awayName } }, breadcrumbJson(locale, item.sport, [{ name: titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]), path: sectionPath }, { name: edition.title, path }])];
  return documentPage({ locale, title: edition.title, description: edition.deck, canonical: path, alternates: translations, xDefault: translations.find(({ locale: code }) => code === "en")?.path, body: shell(locale, item.sport, content, { linkForLocale: (code) => isEditionVisible(item, code) ? route(code, item.sport, routeKeyForType(item.type), item.editions[code].slug) : homeRoute(code, item.sport) }), jsonLd: graph });
}

function editorialPage(locale, item, edition) {
  const path = route(locale, item.sport, routeKeyForType(item.type), edition.slug);
  const sectionPath = route(locale, item.sport, routeKeyForType(item.type));
  const claims = new Map(item.claims.map((claim) => [claim.id, claim]));
  const sections = edition.sections.map((section) => `<section><h2>${escapeHtml(section.title)}</h2>${section.paragraphs.map((paragraph) => { const analysis = paragraph.claimRefs.some((id) => claims.get(id)?.kind === "analysis"); return `<p><span class="${analysis ? "analysis-label" : "fact-label"}">${escapeHtml(analysis ? ui[locale].article.analysis : ui[locale].article.fact)}</span>${escapeHtml(paragraph.text)}</p>`; }).join("")}</section>`).join("");
  const dateValue = publicationDate(item);
  const content = `<article class="page-width"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${encodedPath(homeRoute(locale, item.sport))}">EA</a><span>·</span><a href="${encodedPath(sectionPath)}">${escapeHtml(titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]))}</a><span>·</span><span>${escapeHtml(edition.title)}</span></nav><header class="article-header"><p class="eyebrow">${escapeHtml(edition.kicker || titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]))}</p><h1>${escapeHtml(edition.title)}</h1><p class="article-deck">${escapeHtml(edition.deck)}</p><div class="article-byline"><span>${escapeHtml(item.author)}</span><time datetime="${escapeHtml(dateValue)}">${escapeHtml(new Intl.DateTimeFormat(localeMap.get(locale).htmlLang, { dateStyle: "long" }).format(new Date(dateValue)))}</time><span>${escapeHtml(ui[locale].article.reviewed)}</span></div></header><div class="article-layout editorial-layout"><aside class="article-rail"><div class="rail-box"><strong>${escapeHtml(ui[locale].article.confidence)}</strong><span>${item.confidence}/100</span></div><div class="rail-box"><strong>${escapeHtml(ui[locale].article.contentType)}</strong><span>${escapeHtml(titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]))}</span></div></aside><div class="article-body">${sections}</div></div>${adSlot("content-mid")}</article>`;
  const translations = Object.entries(item.editions).filter(([code]) => isEditionVisible(item, code)).map(([code, candidate]) => ({ locale: code, path: route(code, item.sport, routeKeyForType(item.type), candidate.slug) }));
  return documentPage({ locale, title: edition.title, description: edition.deck, canonical: path, alternates: translations, xDefault: translations.find(({ locale: code }) => code === "en")?.path, body: shell(locale, item.sport, content, { linkForLocale: (code) => isEditionVisible(item, code) ? route(code, item.sport, routeKeyForType(item.type), item.editions[code].slug) : homeRoute(code, item.sport) }), jsonLd: [{ "@type": "Article", headline: edition.title, description: edition.deck, datePublished: dateValue, dateModified: item.reviewedAt || dateValue, inLanguage: localeMap.get(locale).htmlLang, author: { "@type": "Organization", name: item.author }, publisher: { "@type": "Organization", name: "Event Analysis" }, mainEntityOfPage: absoluteUrl(path) }, breadcrumbJson(locale, item.sport, [{ name: titleCaseSegment(data.routes.locales[locale][routeKeyForType(item.type)]), path: sectionPath }, { name: edition.title, path }])] });
}

function h2hTable(locale, edition, value) {
  const labels = ui[locale].article;
  const rate = (wins) => value.matches ? `${((wins / value.matches) * 100).toFixed(1)}%` : "—";
  const homeWins = value.homeWins ?? value.spainWins;
  const awayWins = value.awayWins ?? value.englandWins;
  const rows = [[`${edition.homeName} ${labels.wins}`, homeWins, rate(homeWins)], [labels.draws, value.draws, rate(value.draws)], [`${edition.awayName} ${labels.wins}`, awayWins, rate(awayWins)]].map(([name, count, share]) => `<tr><td>${escapeHtml(name)}</td><td>${count}</td><td>${share}</td></tr>`).join("");
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>${escapeHtml(labels.outcome)}</th><th>${escapeHtml(labels.matches)}</th><th>${escapeHtml(labels.share)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function timeline(events) {
  return `<div class="timeline">${events.map((event) => `<div class="timeline-row"><span class="timeline-minute">${escapeHtml(event.minute)}</span><div class="timeline-event"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.detail)}</span></div></div>`).join("")}</div>`;
}

export const templateRegistry = Object.freeze({
  match_analysis: articlePage, moment_analysis: articlePage, person_profile: editorialPage, person_comparison: editorialPage,
  team_profile: editorialPage, competition_story: editorialPage, place_story: editorialPage, topic_story: editorialPage, roundup: editorialPage,
});

function feed(locale, sport, entries) {
  const items = entries.map(({ item, edition, path }) => { const url = absoluteUrl(path); return `<item><title>${escapeXml(edition.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(publicationDate(item)).toUTCString()}</pubDate><description>${escapeXml(edition.deck)}</description></item>`; }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Event Analysis · ${escapeXml(localeMap.get(locale).nativeName)}</title><link>${absoluteUrl(homeRoute(locale, sport))}</link><description>${escapeXml(ui[locale].pageDescription)}</description><language>${localeMap.get(locale).htmlLang}</language>${items}</channel></rss>\n`;
}

function rootPage() {
  if (buildLocaleCodes.length === 1) return homePage(buildLocaleCodes[0], "football");
  const paths = Object.fromEntries(locales.filter(({ code }) => buildLocaleCodes.includes(code)).map(({ code }) => [code, homeRoute(code)]));
  const fallbackLocale = paths.en ? "en" : buildLocaleCodes[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>Event Analysis</title><link rel="canonical" href="${baseUrl}/"><link rel="stylesheet" href="/assets/site.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><script>!function(){var s=${JSON.stringify(paths)},l=(navigator.languages||[navigator.language||"en"]).map(function(x){return x.toLowerCase().replace("_","-")}),c=${JSON.stringify(fallbackLocale)};for(var i=0;i<l.length;i++){var x=l[i];if(/^zh-(hant|tw|hk|mo)/.test(x)&&s["zh-hant"]){c="zh-hant";break}if((x==="zh"||x.indexOf("zh-")===0)&&s.zh){c="zh";break}if(s[x]){c=x;break}var b=x.split("-")[0];if(s[b]){c=b;break}}location.replace(s[c])}();</script></head><body><noscript><p><a href="${homeRoute(fallbackLocale)}">Event Analysis</a></p></noscript></body></html>\n`;
}

async function writeFileEnsured(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeRoute(path, html) {
  await writeFileEnsured(path === "/" ? resolve(clientOutput, "index.html") : resolve(clientOutput, path.slice(1), "index.html"), html);
}

await rm(clientOutput, { recursive: true, force: true });
await mkdir(resolve(clientOutput, "assets"), { recursive: true });
await Promise.all([
  cp(resolve(root, "site/site.css"), resolve(clientOutput, "assets/site.css")),
  cp(resolve(root, "site/search.js"), resolve(clientOutput, "assets/search.js")),
  cp(resolve(root, "site/favicon.svg"), resolve(clientOutput, "favicon.svg")),
  adConfig.enabled ? cp(resolve(root, "site/ad-slot.js"), resolve(clientOutput, "assets/ad-slot.js")) : Promise.resolve(),
]);
await writeRoute("/", rootPage());

const sitemapGroups = [];
for (const sport of activeSports) for (const locale of buildLocaleCodes) {
  const entries = publishedEntries(locale, sport.code);
  const staticPaths = [homeRoute(locale, sport.code), legalRoute(locale, sport.code)];
  await writeRoute(homeRoute(locale, sport.code), homePage(locale, sport.code));
  await writeRoute(legalRoute(locale, sport.code), legalPage(locale, sport.code));
  if (entries.length) {
    const allPath = route(locale, sport.code, "all-content");
    const searchPath = route(locale, sport.code, "search");
    await writeRoute(allPath, collectionPage(locale, sport.code, "all-content", entries));
    await writeRoute(searchPath, searchPage(locale, sport.code, entries));
    await writeFileEnsured(resolve(clientOutput, locale, sport.code, "search-index.json"), `${JSON.stringify(entries.map(({ item, edition, path }) => ({ id: item.id, type: item.type, year: new Date(publicationDate(item)).getFullYear(), title: edition.title, deck: edition.deck, path: encodedPath(path), entityRefs: item.entityRefs, eventRefs: item.eventRefs })), null, 2)}\n`);
    await writeFileEnsured(resolve(clientOutput, locale, sport.code, "feed.xml"), feed(locale, sport.code, entries));
    staticPaths.push(allPath);
    const grouped = new Map();
    for (const entry of entries) grouped.set(entry.item.type, [...(grouped.get(entry.item.type) || []), entry]);
    for (const [type, typeEntries] of grouped) {
      const sectionPath = route(locale, sport.code, routeKeyForType(type));
      await writeRoute(sectionPath, collectionPage(locale, sport.code, routeKeyForType(type), typeEntries));
      const articlePaths = [];
      for (const { item, edition, path } of typeEntries) {
        await writeRoute(path, templateRegistry[item.type](locale, item, edition));
        articlePaths.push(path);
      }
      sitemapGroups.push({ name: `${locale}-${sport.code}-${routeKeyForType(type)}`, paths: [sectionPath, ...articlePaths], lastModified: typeEntries[0].item.reviewedAt });
    }
  }
  sitemapGroups.push({ name: `${locale}-${sport.code}`, paths: staticPaths, lastModified: entries[0]?.item.reviewedAt || "2026-07-14T00:00:00Z" });
}

for (const group of sitemapGroups) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${group.paths.map((path) => `<url><loc>${absoluteUrl(path)}</loc><lastmod>${new Date(group.lastModified).toISOString()}</lastmod></url>`).join("")}</urlset>\n`;
  await writeFileEnsured(resolve(clientOutput, "sitemaps", `${group.name}.xml`), xml);
}
const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapGroups.map(({ name, lastModified }) => `<sitemap><loc>${baseUrl}/sitemaps/${name}.xml</loc><lastmod>${new Date(lastModified).toISOString()}</lastmod></sitemap>`).join("")}</sitemapindex>\n`;
await writeFileEnsured(resolve(clientOutput, "sitemap.xml"), sitemapIndex);
await writeFileEnsured(resolve(clientOutput, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\nHost: ${baseUrl}\n`);
const notFoundLocale = buildLocaleCodes.includes("en") ? "en" : buildLocaleCodes[0];
await writeFileEnsured(resolve(clientOutput, "404.html"), documentPage({ locale: notFoundLocale, title: notFoundLocale === "zh" ? "页面不存在" : "Page not found", description: notFoundLocale === "zh" ? "请求的页面不存在。" : "The requested page does not exist.", canonical: "/404.html", robots: "noindex,follow", body: shell(notFoundLocale, "football", `<div class="not-found"><div><strong>404</strong><h1>${notFoundLocale === "zh" ? "页面不存在" : "Page not found"}</h1><a href="${homeRoute(notFoundLocale)}">Event Analysis</a></div></div>`) }));

console.log(`Generated ${sitemapGroups.reduce((sum, group) => sum + group.paths.length, 1)} framework-free HTML routes in ${clientOutput}.`);
