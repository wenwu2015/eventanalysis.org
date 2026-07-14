#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicRoot = resolve(root, "dist/client");
const baseUrl = "https://eventanalysis.org";
const failures = [];
const warnings = [];

async function files(directory, predicate = () => true) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path, predicate));
    else if (predicate(path)) output.push(path);
  }
  return output;
}

function pathForFile(file) {
  const relative = file.slice(publicRoot.length).split(sep).join("/");
  if (relative === "/index.html") return "/";
  return relative.endsWith("/index.html") ? relative.slice(0, -10) : relative;
}

function localFileForUrl(value) {
  const url = new URL(value, baseUrl);
  if (url.origin !== baseUrl) return null;
  const decoded = decodeURIComponent(url.pathname);
  const candidate = resolve(publicRoot, `.${decoded}`);
  if (candidate !== publicRoot && !candidate.startsWith(publicRoot + sep)) return null;
  return extname(decoded) ? candidate : resolve(candidate, "index.html");
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(([tag]) => tag);
}

function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] || "";
}

function mainText(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || "";
  return main.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function canonical(html) {
  return attr(tags(html, "link").find((tag) => /\brel=["']canonical["']/i.test(tag)) || "", "href");
}

const htmlFiles = await files(publicRoot, (path) => path.endsWith(".html"));
const pages = new Map();
const bodyHashes = new Map();
for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
  const publicPath = pathForFile(file);
  pages.set(publicPath, { file, html });
  if (!/^<!doctype html>/i.test(html)) failures.push(`${publicPath}: missing HTML doctype`);
  if (!/<link rel="stylesheet" href="\/assets\/site\.css">/.test(html)) failures.push(`${publicPath}: missing first-party stylesheet`);
  if (/<(?:img|picture|video|iframe|canvas)\b/i.test(html)) failures.push(`${publicPath}: forbidden public media element`);
  if (/(?:_next|__next|react-dom|@vite\/client|tailwindcss|webpack)/i.test(html)) failures.push(`${publicPath}: framework runtime signal`);
  if (/sofascore|sportradar|genius sports|wyscout|statsbomb|transfermarkt|skillcorner|private-evidence|private-sources|pipeline\/jobs/i.test(html)) failures.push(`${publicPath}: private source or path disclosure`);
  if (/\b(?:AI|ChatGPT|OpenAI)\b|artificial intelligence|人工智能|人工知能|인공지능|искусственн\w* интеллект|الذكاء الاصطناعي|هوش مصنوعی/i.test(html)) failures.push(`${publicPath}: prohibited production-process wording`);
  if (/data-ea-ad|class="ad-slot"/i.test(html)) failures.push(`${publicPath}: disabled advertising emitted public DOM`);
  if (publicPath !== "/") {
    const value = canonical(html);
    if (!value) failures.push(`${publicPath}: missing canonical`);
    else {
      const target = localFileForUrl(value);
      if (!target || await stat(target).catch(() => null) === null) failures.push(`${publicPath}: canonical target does not exist: ${value}`);
      if (publicPath !== "/404.html" && new URL(value).pathname !== encodedPath(publicPath)) failures.push(`${publicPath}: canonical is not self-referencing: ${value}`);
    }
    if (/name="robots" content="index,follow"/.test(html)) {
      const text = mainText(html);
      if ([...text].length < 100) failures.push(`${publicPath}: possible soft 404 or thin rendered page`);
      const hash = createHash("sha256").update(text.normalize("NFKC").toLocaleLowerCase()).digest("hex");
      if (bodyHashes.has(hash)) failures.push(`${publicPath}: exact rendered-body duplicate of ${bodyHashes.get(hash)}`);
      bodyHashes.set(hash, publicPath);
    }
    for (const script of [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]) {
      try { JSON.parse(script[1]); } catch { failures.push(`${publicPath}: invalid JSON-LD`); }
    }
  }
}

function encodedPath(path) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

for (const [publicPath, { html }] of pages) {
  for (const tag of tags(html, "a")) {
    const href = attr(tag, "href");
    if (!href || href.startsWith("#") || /^(?:mailto:|tel:)/.test(href)) continue;
    const target = localFileForUrl(href);
    if (!target) { failures.push(`${publicPath}: external or invalid internal link ${href}`); continue; }
    if (await stat(target).catch(() => null) === null) failures.push(`${publicPath}: broken internal link ${href}`);
  }
  const sourceCanonical = canonical(html);
  for (const tag of tags(html, "link").filter((tag) => /\brel=["']alternate["']/i.test(tag) && attr(tag, "hreflang") !== "x-default")) {
    const href = attr(tag, "href");
    const targetPath = decodeURIComponent(new URL(href).pathname);
    const target = pages.get(targetPath);
    if (!target) { failures.push(`${publicPath}: hreflang target missing ${href}`); continue; }
    if (sourceCanonical && !target.html.includes(`href="${sourceCanonical}"`)) failures.push(`${publicPath}: hreflang is not reciprocal with ${targetPath}`);
  }
}

const sitemapIndex = await readFile(resolve(publicRoot, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemapIndex.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, value]) => value);
for (const sitemapUrl of sitemapUrls) {
  const sitemapFile = localFileForUrl(sitemapUrl);
  if (!sitemapFile || await stat(sitemapFile).catch(() => null) === null) { failures.push(`sitemap index target missing: ${sitemapUrl}`); continue; }
  const xml = await readFile(sitemapFile, "utf8");
  for (const [, pageUrl] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const target = localFileForUrl(pageUrl);
    if (!target || await stat(target).catch(() => null) === null) failures.push(`sitemap page missing: ${pageUrl}`);
    else {
      const html = await readFile(target, "utf8");
      if (!/name="robots" content="index,follow"/.test(html)) failures.push(`sitemap contains non-indexable page: ${pageUrl}`);
      if (canonical(html) !== pageUrl) failures.push(`sitemap URL differs from canonical: ${pageUrl}`);
    }
  }
}

for (const retired of ["/en/", "/zh/", "/en/archive/", "/zh/archive/", "/en/methodology/", "/zh/methodology/", "/en/articles/spain-england-euro-2024-final/"]) {
  if (await stat(resolve(publicRoot, `.${retired}`, "index.html")).catch(() => null)) failures.push(`retired route still exists: ${retired}`);
}

const report = { generatedAt: new Date().toISOString(), status: failures.length ? "BLOCK" : warnings.length ? "REVIEW" : "PASS", counts: { htmlPages: htmlFiles.length, indexableBodies: bodyHashes.size, sitemapFiles: sitemapUrls.length }, failures, warnings };
await mkdir(resolve(root, "pipeline/runtime"), { recursive: true });
await writeFile(resolve(root, "pipeline/runtime/prepublish-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
