#!/usr/bin/env node
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { isDiscoveredPathInScope } from "./live-verification-scope.mjs";

const root = resolve(import.meta.dirname, "../..");
const option = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const baseUrl = new URL(option("base-url", "https://www.eventanalysis.org"));
const manifestPath = resolve(root, option("manifest", "pipeline/runtime/compliance/edge-manifest.json"));
const reportPath = resolve(root, option("report", "pipeline/runtime/live-e2e/latest.json"));
const artifactDir = resolve(root, option("artifacts", `output/playwright/live-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const retries = Number(option("retries", "3"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];
const checkedUrls = new Set();
const discoveredLinks = new Set();
const pageResults = [];
const startedAt = new Date().toISOString();

function fail(scope, message, details = null) {
  failures.push({ scope, message, ...(details ? { details } : {}) });
}

function siteUrl(pathname) {
  return new URL(pathname, baseUrl).href;
}

function isHtmlPath(pathname) {
  return pathname.endsWith("/") || pathname.endsWith(".html") || pathname === "/";
}

function expectedContentType(pathname) {
  if (isHtmlPath(pathname)) return "text/html";
  if (pathname.endsWith(".xml")) return "xml";
  if (pathname.endsWith(".json")) return "application/json";
  if (pathname.endsWith(".css")) return "text/css";
  if (pathname.endsWith(".js")) return "javascript";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return null;
}

async function retry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 1_000));
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
}

async function checkResponse(url) {
  if (checkedUrls.has(url)) return;
  checkedUrls.add(url);
  try {
    const response = await retry(`GET ${url}`, () => fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "EventAnalysis production E2E/1.0", "accept-language": "en" },
      signal: AbortSignal.timeout(20_000),
    }).then(async (result) => ({
      status: result.status,
      contentType: result.headers.get("content-type") || "",
      body: await result.text(),
      finalUrl: result.url,
    })));
    if (response.status !== 200) fail(url, `Expected HTTP 200, received ${response.status}`);
    if (/This publication is not available in your jurisdiction/i.test(response.body)) fail(url, "Country restriction response is forbidden");
    const expected = expectedContentType(new URL(url).pathname);
    if (expected && !response.contentType.toLowerCase().includes(expected)) {
      fail(url, `Expected content-type containing ${expected}, received ${response.contentType || "none"}`);
    }
  } catch (error) {
    fail(url, error.message);
  }
}

async function saveFailureScreenshot(page, pathname) {
  await mkdir(artifactDir, { recursive: true });
  const name = pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 100) || "root";
  await page.screenshot({ path: resolve(artifactDir, `${name}.png`), fullPage: true }).catch(() => {});
}

async function inspectPage(page, url) {
  const pageFailuresBefore = failures.length;
  const runtimeErrors = [];
  const onConsole = (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  };
  const onPageError = (error) => runtimeErrors.push(`pageerror: ${error.message}`);
  const onRequestFailed = (request) => runtimeErrors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText || "unknown"})`);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  try {
    const response = await retry(`Navigate ${url}`, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
    if (!response || response.status() !== 200) fail(url, `Browser navigation returned ${response?.status() || "no response"}`);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    const structure = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map(({ id }) => id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      const anchors = [...document.querySelectorAll("a[href]")].map((anchor) => ({
        href: anchor.href,
        rawHref: anchor.getAttribute("href") || "",
        name: (anchor.getAttribute("aria-label") || anchor.textContent || anchor.getAttribute("title") || "").trim(),
      }));
      const controlsWithoutNames = [...document.querySelectorAll("input, select, textarea, button")]
        .filter((control) => {
          const label = control.labels?.[0]?.textContent || control.getAttribute("aria-label") || control.getAttribute("title");
          return !String(label || "").trim();
        })
        .map((control) => control.outerHTML.slice(0, 180));
      return {
        title: document.title.trim(),
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        mainCount: document.querySelectorAll("main#main").length,
        h1Count: document.querySelectorAll("h1").length,
        duplicates: [...new Set(duplicates)],
        anchors,
        controlsWithoutNames,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyText: document.body.innerText,
      };
    });

    if (!structure.title) fail(url, "Document title is empty");
    if (!structure.lang) fail(url, "html[lang] is missing");
    if (structure.mainCount !== 1) fail(url, `Expected one main#main, received ${structure.mainCount}`);
    if (structure.h1Count !== 1) fail(url, `Expected one h1, received ${structure.h1Count}`);
    if (structure.duplicates.length) fail(url, `Duplicate IDs: ${structure.duplicates.join(", ")}`);
    if (structure.controlsWithoutNames.length) fail(url, "Form controls without accessible names", structure.controlsWithoutNames);
    if (structure.overflow > 1) fail(url, `Desktop horizontal overflow: ${structure.overflow}px`);
    if (/This publication is not available in your jurisdiction/i.test(structure.bodyText)) fail(url, "Country restriction page rendered");
    if (new URL(url).pathname.startsWith("/ar/") && structure.dir !== "rtl") fail(url, "Arabic page must use dir=rtl");

    for (const anchor of structure.anchors) {
      if (!anchor.name) fail(url, `Link has no accessible name: ${anchor.rawHref}`);
      if (/^javascript:/i.test(anchor.rawHref)) fail(url, `javascript: link is forbidden: ${anchor.rawHref}`);
      const target = new URL(anchor.href);
      if (target.origin === baseUrl.origin) discoveredLinks.add(`${target.origin}${target.pathname}${target.search}`);
      if (target.origin === baseUrl.origin && target.pathname === new URL(url).pathname && target.hash) {
        const hashId = decodeURIComponent(target.hash.slice(1));
        const exists = await page.evaluate((id) => Boolean(document.getElementById(id)), hashId);
        if (!exists) fail(url, `Hash target does not exist: ${target.hash}`);
      }
    }

    const skipLink = page.locator("a.skip-link");
    if (await skipLink.count()) {
      await skipLink.focus();
      if (!(await skipLink.isVisible())) fail(url, "Skip link is not visible when focused");
      await skipLink.click();
      if (new URL(page.url()).hash !== "#main") fail(url, "Skip link did not reach #main");
    } else {
      fail(url, "Skip link is missing");
    }

    const localeMenu = page.locator("details.locale-menu");
    if (await localeMenu.count()) {
      const summary = localeMenu.locator("summary");
      await summary.click();
      if (!(await localeMenu.evaluate((element) => element.open))) fail(url, "Locale menu did not open");
      const localeLinks = localeMenu.locator("a[href]");
      if (!(await localeLinks.count())) fail(url, "Locale menu has no destinations");
      await summary.click();
    } else {
      fail(url, "Locale menu is missing");
    }

    if (await page.locator("[data-search-query]").count()) {
      const results = page.locator("[data-search-result]");
      const initial = await results.count();
      const visibleCount = () => results.evaluateAll((nodes) => nodes.filter((node) => !node.hidden).length);
      const query = page.locator("[data-search-query]");
      await query.fill("__eventanalysis_no_match__");
      if ((await visibleCount()) !== 0 || !(await page.locator("[data-search-empty]").isVisible())) fail(url, "Search no-results state failed");
      await query.fill("");
      if ((await visibleCount()) !== initial) fail(url, "Clearing search did not restore all results");
      for (const select of await page.locator("select[data-search-facet]").all()) {
        if ((await select.locator("option").count()) < 2) continue;
        await select.selectOption({ index: 1 });
        if ((await visibleCount()) < 1) fail(url, `Facet produced no matching result: ${await select.getAttribute("data-search-facet")}`);
        await select.selectOption({ index: 0 });
      }
    }

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    if (axe.violations.length) {
      fail(url, `Accessibility violations: ${axe.violations.map(({ id, impact, nodes }) => `${id}:${impact}:${nodes.length}`).join(", ")}`, axe.violations);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(50);
    const mobileLayout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: [...document.querySelectorAll("body *")].map((element) => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, className: String(element.className || ""), left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      }).filter(({ left, right }) => left < -1 || right > document.documentElement.clientWidth + 1).slice(0, 12),
    }));
    if (mobileLayout.overflow > 1) fail(url, `Mobile horizontal overflow: ${mobileLayout.overflow}px`, mobileLayout.elements);
    await page.setViewportSize({ width: 1440, height: 1000 });
  } catch (error) {
    fail(url, error.message);
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    for (const error of runtimeErrors) fail(url, error);
    if (failures.length > pageFailuresBefore) await saveFailureScreenshot(page, new URL(url).pathname);
    pageResults.push({ url, status: failures.length === pageFailuresBefore ? "PASS" : "FAIL" });
  }
}

const expectedPaths = new Set([
  "/",
  "/404.html",
  "/favicon.svg",
  "/robots.txt",
  "/sitemap.xml",
  "/assets/site.css",
  "/assets/search.js",
  ...(manifest.publicRoutes || []),
  ...(manifest.routes || []).map(({ path }) => path),
]);
const htmlUrls = [...expectedPaths].filter(isHtmlPath).map(siteUrl);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();

for (const url of htmlUrls) await inspectPage(page, url);
for (const path of expectedPaths) await checkResponse(siteUrl(path));
for (const url of discoveredLinks) {
  const target = new URL(url);
  if (!isDiscoveredPathInScope(target.pathname, expectedPaths, manifest)) continue;
  await checkResponse(url);
}

await context.close();
await browser.close();

const report = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  baseUrl: baseUrl.href,
  manifest: manifestPath,
  status: failures.length ? "FAIL" : "PASS",
  htmlPages: htmlUrls.length,
  urlsChecked: checkedUrls.size,
  discoveredLinks: discoveredLinks.size,
  accessibilityStandard: "WCAG 2.1 A/AA",
  pages: pageResults,
  failures,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...report, pages: undefined, failures: failures.slice(0, 20) }, null, 2));
if (failures.length) process.exitCode = 1;
