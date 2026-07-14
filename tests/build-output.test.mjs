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

async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
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
  assert.ok(pages.length >= 29, "21 locale homes and editorial routes should be pre-generated");
  for (const path of pages) {
    const html = await readFile(path, "utf8");
    assert.match(html, /^<!doctype html>/i, path);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css">/, path);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, path);
    assert.doesNotMatch(html, /(?:_next|__next|react-dom|react\.production|vinext|@vite\/client|tailwindcss|wrangler|webpack)/i, path);
    assert.doesNotMatch(html, /data-ea-ad|class="ad-slot"/i, path);
  }
});

test("new localized URL contract works and retired URLs are real 404s", async () => {
  const port = 43173;
  const server = await startServer(port);
  try {
    const publicPaths = [
      "/zh/football/",
      "/en/football/",
      "/ja/football/",
      "/ar/football/",
      "/en/football/all-content/",
      "/en/football/match-analysis/",
      "/en/football/match-analysis/spain-england-euro-2024-final/",
      "/zh/football/%E6%AF%94%E8%B5%9B%E5%88%86%E6%9E%90/%E8%A5%BF%E7%8F%AD%E7%89%99-%E8%8B%B1%E6%A0%BC%E5%85%B0-2024%E6%AC%A7%E6%B4%B2%E6%9D%AF%E5%86%B3%E8%B5%9B/",
    ];
    for (const path of publicPaths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.doesNotMatch(html, /<(?:img|picture|video|iframe|canvas)\b/i, path);
      assert.doesNotMatch(html, /sofascore|sportradar|genius sports|wyscout|statsbomb|transfermarkt|skillcorner/i, path);
      assert.doesNotMatch(html, /\b(?:AI|ChatGPT|OpenAI)\b|人工智能/i, path);
    }
    for (const path of ["/en/", "/zh/", "/en/archive/", "/zh/archive/", "/en/methodology/", "/zh/methodology/", "/en/articles/spain-england-euro-2024-final/"]) {
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
    const article = await (await fetch(`http://127.0.0.1:${port}/en/football/match-analysis/spain-england-euro-2024-final/`)).text();
    assert.match(article, /application\/ld\+json/);
    assert.match(article, /hreflang="zh-CN"/);
    assert.match(article, /48\.1%/);
    assert.match(article, /href="\/zh\/football\/%E6%AF%94%E8%B5%9B%E5%88%86%E6%9E%90\//);
    const japanese = await (await fetch(`http://127.0.0.1:${port}/ja/football/`)).text();
    assert.match(japanese, /分析の枠組み/);
    assert.doesNotMatch(japanese, /Spain 2–1 England|準備中/);
    const arabic = await (await fetch(`http://127.0.0.1:${port}/ar/football/`)).text();
    assert.match(arabic, /dir="rtl"/);
    assert.match(arabic, /تنتهي المباراة/);
    const search = await (await fetch(`http://127.0.0.1:${port}/en/football/search/?q=Spain`)).text();
    assert.match(search, /name="robots" content="noindex,follow"/);
    assert.match(search, /data-search-result/);
  } finally {
    server.kill("SIGTERM");
  }
});

test("RSS and nested sitemap index are static assets", async () => {
  await access(resolve(root, "dist/client/en/football/feed.xml"));
  await access(resolve(root, "dist/client/zh/football/feed.xml"));
  const sitemap = await readFile(resolve(root, "dist/client/sitemap.xml"), "utf8");
  assert.match(sitemap, /<sitemapindex/);
  assert.match(sitemap, /sitemaps\/en-football-match-analysis\.xml/);
  assert.doesNotMatch(sitemap, /methodology|archive|\/search/);
});
