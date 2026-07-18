import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function startServer(port) {
  const child = spawn("npm", ["run", "start"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (!output.includes("Static server running")) {
    if (child.exitCode !== null) throw new Error(`Production server exited early: ${output}`);
    if (Date.now() > deadline) throw new Error(`Production server did not become ready: ${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return child;
}

async function startZhServer(port) {
  const child = spawn("npm", ["run", "start:zh"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (!output.includes("Static server running")) {
    if (child.exitCode !== null) throw new Error(`Chinese preview server exited early: ${output}`);
    if (Date.now() > deadline) throw new Error(`Chinese preview server did not become ready: ${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return child;
}

async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

function runNpmScript(script) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("npm", ["run", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`npm run ${script} failed: ${output}`));
    });
  });
}

test("AWS publish directory contains framework-free static output", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const dependency of ["next", "react", "react-dom", "vinext", "vite", "tailwindcss", "wrangler"]) {
    assert.equal(packageJson.dependencies?.[dependency], undefined, dependency);
    assert.equal(packageJson.devDependencies?.[dependency], undefined, dependency);
  }
  await access(resolve(root, "dist/client/assets/site.css"));
  await access(resolve(root, "dist/client/assets/search.js"));
  await access(resolve(root, "dist/client/favicon.svg"));
  await assert.rejects(access(resolve(root, "dist/client/assets/ad-slot.js")));
  const pages = await htmlFiles(resolve(root, "dist/client"));
  assert.ok(pages.length >= 44, "21 locale homes, 21 legal pages, root and 404 should be pre-generated");
  for (const path of pages) {
    const html = await readFile(path, "utf8");
    assert.match(html, /^<!doctype html>/i, path);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css">/, path);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, path);
    assert.doesNotMatch(html, /(?:_next|__next|react-dom|react\.production|vinext|@vite\/client|tailwindcss|wrangler|webpack)/i, path);
    assert.doesNotMatch(html, /data-ea-ad|class="ad-slot"/i, path);
  }
});

test("published site exposes locale homes, legal pages and released match-analysis routes", async () => {
  const port = 43173;
  const server = await startServer(port);
  try {
    const publicPaths = [
      "/zh/football/",
      "/en/football/",
      "/ja/football/",
      "/ar/football/",
      "/en/football/legal/",
      "/zh/football/legal/",
      "/en/football/all-content/",
      "/en/football/search/",
      "/en/football/match-analysis/",
      "/en/football/match-analysis/england-argentina-1-2-late-comeback-2026-en/",
    ];
    for (const path of publicPaths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.doesNotMatch(html, /<(?:img|picture|video|iframe|canvas)\b/i, path);
      assert.doesNotMatch(html, /sofascore|sportradar|genius sports|wyscout|statsbomb|transfermarkt|skillcorner/i, path);
      assert.doesNotMatch(html, /\b(?:AI|ChatGPT|OpenAI)\b|人工智能/i, path);
    }
    for (const path of ["/en/", "/zh/", "/en/archive/", "/zh/archive/", "/en/methodology/", "/zh/methodology/", "/en/articles/spain-england-euro-2024-final/", "/en/football/match-analysis/spain-england-euro-2024-final/"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" })).status, 404, path);
    }
    for (const [acceptLanguage, expectedLocation] of [
      ["zh-TW,zh;q=0.8,en;q=0.5", "/zh-hant/football/"],
      ["ja-JP,ja;q=0.9", "/ja/football/"],
      ["xx-YY", "/en/football/"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { "accept-language": acceptLanguage }, redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), expectedLocation);
      assert.equal(response.headers.get("vary"), "Accept-Language");
    }
    const legal = await (await fetch(`http://127.0.0.1:${port}/en/football/legal/`)).text();
    assert.match(legal, /application\/ld\+json/);
    assert.match(legal, /Legal, corrections and content concerns/);
    assert.match(legal, /legal@eventanalysis\.org/);
    const chinese = await (await fetch(`http://127.0.0.1:${port}/zh/football/`)).text();
    assert.match(chinese, /我们从三个角度解释比赛/);
    assert.match(chinese, /赛前发生过什么/);
    assert.match(chinese, /这一次改变了什么/);
    assert.match(chinese, /为什么形成这个结果/);
    assert.doesNotMatch(chinese, /我们的分析框架/);
    const japanese = await (await fetch(`http://127.0.0.1:${port}/ja/football/`)).text();
    assert.match(japanese, /分析の枠組み/);
    assert.doesNotMatch(japanese, /Spain 2–1 England|準備中/);
    const arabic = await (await fetch(`http://127.0.0.1:${port}/ar/football/`)).text();
    assert.match(arabic, /dir="rtl"/);
    assert.match(arabic, /تنتهي المباراة/);
  } finally {
    server.kill("SIGTERM");
  }
});

test("published sitemap includes homes, list pages and match-analysis detail sitemaps", async () => {
  await access(resolve(root, "dist/client/en/football/feed.xml"));
  await access(resolve(root, "dist/client/zh/football/search-index.json"));
  const sitemap = await readFile(resolve(root, "dist/client/sitemap.xml"), "utf8");
  assert.match(sitemap, /<sitemapindex/);
  assert.match(sitemap, /https:\/\/www\.eventanalysis\.org\/sitemaps\/en-football\.xml/);
  assert.match(sitemap, /https:\/\/www\.eventanalysis\.org\/sitemaps\/en-football-match-analysis\.xml/);
  assert.doesNotMatch(sitemap, /https:\/\/eventanalysis\.org/);
  assert.doesNotMatch(sitemap, /methodology|archive|\/search/);
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);
  const pageUrls = [];
  for (const sitemapUrl of sitemapUrls) {
    const parsedSitemapUrl = new URL(sitemapUrl);
    assert.equal(parsedSitemapUrl.origin, "https://www.eventanalysis.org");
    const xml = await readFile(resolve(root, "dist/client", `.${parsedSitemapUrl.pathname}`), "utf8");
    for (const [, pageUrl] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const parsedPageUrl = new URL(pageUrl);
      assert.equal(parsedPageUrl.origin, "https://www.eventanalysis.org");
      const localPath = resolve(root, "dist/client", `.${decodeURIComponent(parsedPageUrl.pathname)}`, parsedPageUrl.pathname.endsWith("/") ? "index.html" : "");
      await access(localPath);
      pageUrls.push(pageUrl);
    }
  }
  assert.equal(new Set(pageUrls).size, pageUrls.length, "sitemap URLs must be unique");
  const english = await readFile(resolve(root, "dist/client/sitemaps/en-football.xml"), "utf8");
  assert.match(english, /https:\/\/www\.eventanalysis\.org\/en\/football\/<\/loc>/);
  assert.match(english, /https:\/\/www\.eventanalysis\.org\/en\/football\/legal\/<\/loc>/);
  assert.match(english, /https:\/\/www\.eventanalysis\.org\/en\/football\/all-content\/<\/loc>/);
  assert.doesNotMatch(english, /https:\/\/eventanalysis\.org/);
  assert.doesNotMatch(english, /people|\/search\//);
  const englishMatchAnalysis = await readFile(resolve(root, "dist/client/sitemaps/en-football-match-analysis.xml"), "utf8");
  assert.match(englishMatchAnalysis, /https:\/\/www\.eventanalysis\.org\/en\/football\/match-analysis\/england-argentina-1-2-late-comeback-2026-en\/<\/loc>/);
  assert.match(englishMatchAnalysis, /https:\/\/www\.eventanalysis\.org\/en\/football\/match-analysis\/france-0-2-spain-continuity-decisive-moments\/<\/loc>/);
  const robots = await readFile(resolve(root, "dist/client/robots.txt"), "utf8");
  assert.equal(robots, "User-agent: *\nAllow: /\nSitemap: https://www.eventanalysis.org/sitemap.xml\nHost: https://www.eventanalysis.org\n");
});

test("Chinese preview build opens directly without a JavaScript-only root page", async () => {
  await runNpmScript("build:zh");
  const rootHtml = await readFile(resolve(root, "dist/preview-zh/index.html"), "utf8");
  assert.match(rootHtml, /赛后足球分析/);
  assert.match(rootHtml, /我们从三个角度解释比赛/);
  assert.doesNotMatch(rootHtml, /location\.replace/);
  await assert.rejects(access(resolve(root, "dist/preview-zh/en")));
  const port = 43174;
  const server = await startZhServer(port);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { "accept-language": "en-US,en;q=0.9" }, redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/zh/football/");
    const html = await (await fetch(`http://127.0.0.1:${port}/zh/football/`)).text();
    assert.match(html, /赛前发生过什么/);
  } finally {
    server.kill("SIGTERM");
  }
});
