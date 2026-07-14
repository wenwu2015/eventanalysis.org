import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function startServer(port) {
  const child = spawn("npm", ["run", "start"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

test("Sites bundle is plain HTML and CSS with no persistence bindings", async () => {
  await access(resolve(root, "dist/index.html"));
  await access(resolve(root, "dist/assets/site.css"));
  const hosting = JSON.parse(await readFile(resolve(root, "dist/.openai/hosting.json"), "utf8"));
  assert.deepEqual(hosting, { d1: null, r2: null });
});

async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

test("every public page is framework-free static HTML", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const dependency of ["next", "react", "react-dom", "vinext", "vite", "tailwindcss", "wrangler"]) {
    assert.equal(packageJson.dependencies?.[dependency], undefined, dependency);
    assert.equal(packageJson.devDependencies?.[dependency], undefined, dependency);
  }
  const files = await htmlFiles(resolve(root, "dist"));
  assert.ok(files.length >= 66, "all locale routes should be pre-generated");
  for (const path of files) {
    const html = await readFile(path, "utf8");
    assert.match(html, /^<!doctype html>/i, path);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css">/, path);
    assert.doesNotMatch(html, /(?:_next|__next|react-dom|react\.production|vinext|@vite\/client|tailwindcss|wrangler|webpack)/i, path);
    assert.doesNotMatch(html, /<script[^>]+src=/i, path);
    assert.doesNotMatch(html, /data-ea-ad|class="ad-slot"/i, path);
  }
});

test("rendered public pages are anonymous, media-free and disclosure-free", async () => {
  const port = 43173;
  const server = await startServer(port);
  try {
    const paths = [
      "/",
      "/zh/",
      "/en/",
      "/ja/",
      "/ru/archive/",
      "/ar/methodology/",
      "/zh/archive/",
      "/en/methodology/",
      "/en/articles/spain-england-euro-2024-final/",
    ];
    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.doesNotMatch(html, /<(?:img|picture|video|iframe|canvas|form)\b/i, path);
      assert.doesNotMatch(html, /sofascore|sportradar|genius sports|wyscout|statsbomb|transfermarkt|skillcorner/i, path);
      assert.doesNotMatch(html, /signin-with-chatgpt|signout-with-chatgpt|oai-authenticated-user/i, path);
      assert.doesNotMatch(html, /class="ad-slot"/i, path);
    }
    const article = await (await fetch(`http://127.0.0.1:${port}/en/articles/spain-england-euro-2024-final/`)).text();
    assert.match(article, /application\/ld\+json/);
    assert.match(article, /hreflang="zh-CN"/);
    assert.match(article, /48\.1%/);
    assert.match(article, /Human reviewed/);
    const japanese = await (await fetch(`http://127.0.0.1:${port}/ja/`)).text();
    assert.match(japanese, /日本語版を準備中です/);
    assert.doesNotMatch(japanese, /Spain 2–1 England/);
    const arabic = await (await fetch(`http://127.0.0.1:${port}/ar/methodology/`)).text();
    assert.match(arabic, /dir="rtl"/);
    assert.match(arabic, /كيف نفسر مباراة/);
  } finally {
    server.kill("SIGTERM");
  }
});

test("RSS, sitemap and robots are static public assets", async () => {
  const locales = JSON.parse(await readFile(resolve(root, "content/locales.json"), "utf8"));
  assert.equal(locales.length, 21);
  for (const path of [...locales.map(({ code }) => `dist/${code}/feed.xml`), "dist/sitemap.xml", "dist/robots.txt"]) {
    await access(resolve(root, path));
  }
});
