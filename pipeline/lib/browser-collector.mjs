import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export class AccessControlError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessControlError";
    this.code = "ACCESS_CONTROL_REQUIRED";
  }
}

export class BrowserResponseTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserResponseTimeoutError";
    this.code = "BROWSER_RESPONSE_TIMEOUT";
  }
}

const lastNavigationBySource = new Map();

async function pace(source) {
  const delay = Math.max(0, Number(source.minimumDelayMs) || 0);
  const previous = lastNavigationBySource.get(source.id) || 0;
  const wait = previous + delay - Date.now();
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  lastNavigationBySource.set(source.id, Date.now());
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function transientNavigationError(error) {
  return /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NETWORK_CHANGED)|Timeout/i.test(String(error));
}

export async function waitForPendingBrowserResponses(pending, { timeoutMs = 15_000 } = {}) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new BrowserResponseTimeoutError(`Timed out waiting for ${pending.size} browser response(s) to finish.`);
    }
    const snapshot = [...pending];
    if (!snapshot.length) continue;
    const remaining = Math.max(1, deadline - Date.now());
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise((_, reject) => setTimeout(() => reject(new BrowserResponseTimeoutError(`Timed out waiting for ${pending.size} browser response(s) to finish.`)), remaining)),
    ]);
  }
}

export async function collectBrowserPage({ source, url, job, timeoutMs = 45_000, interact }) {
  const target = new URL(url);
  const sourceOrigin = new URL(source.baseUrl).origin;
  const allowedOrigins = new Set([sourceOrigin, ...((source.responseOrigins || []).map((value) => {
    try { return new URL(value).origin; } catch { return null; }
  }).filter(Boolean))]);
  if (target.origin !== sourceOrigin) throw new Error(`URL origin is outside source boundary: ${target.origin}`);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    executablePath: source.browserExecutablePath || undefined,
  });
  const authPath = source.storageStatePath || undefined;
  const context = await browser.newContext({
    storageState: authPath,
    locale: source.locale || "en-GB",
    userAgent: source.userAgent || undefined,
  });
  const page = await context.newPage();
  const responseDirectory = resolve(job.jobDir, "browser-responses");
  await mkdir(responseDirectory, { recursive: true, mode: 0o700 });
  const captured = [];
  const pending = new Set();
  const responseErrors = [];
  let sequence = 0;
  let captureClosed = false;

  page.on("response", (response) => {
    if (captureClosed) return;
    const promise = (async () => {
      const responseUrl = new URL(response.url());
      if (!allowedOrigins.has(responseUrl.origin)) return;
      const type = response.headers()["content-type"] || "";
      if (!type.includes("json")) return;
      let body;
      try {
        body = await response.text();
      } catch {
        return;
      }
      if (Buffer.byteLength(body) > 20 * 1024 * 1024) return;
      const name = `${String(sequence++).padStart(4, "0")}-${safeFilePart(responseUrl.pathname)}.json`;
      const path = resolve(responseDirectory, name);
      if (captureClosed) return;
      await writeFile(path, body, { mode: 0o600 });
      captured.push({ url: responseUrl.toString(), status: response.status(), path, body, hash: sha256(body) });
    })().catch((error) => {
      if (captureClosed && error?.code === "ENOENT") return;
      responseErrors.push(error);
    });
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  });

  try {
    await pace(source);
    job.retainUrl(target.toString());
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!transientNavigationError(error) || attempt === 2) throw error;
        await page.waitForTimeout(1_500 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    if (response && [401, 403, 429].includes(response.status())) {
      throw new AccessControlError(`Provider returned ${response.status()}; use the contracted whitelist or refresh the authorised session.`);
    }

    for (const label of source.acceptCookieLabels || ["Accept all", "Accept", "Allow all"]) {
      const button = page.getByRole("button", { name: label, exact: true }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => {});
        break;
      }
    }
    if (interact) await interact(page);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 12_000) }).catch(() => {});
    await waitForPendingBrowserResponses(pending, { timeoutMs: Math.min(timeoutMs, 15_000) });
    captureClosed = true;
    if (responseErrors.length > 0) throw responseErrors[0];

    const title = await page.title();
    const visibleText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 200_000);
    if (/captcha|verify you are human|access denied|unusual traffic/i.test(`${title}\n${visibleText}`)) {
      throw new AccessControlError("An access-control challenge was detected; no bypass was attempted.");
    }
    const htmlPath = resolve(job.jobDir, "page.html");
    const html = await page.content();
    await writeFile(htmlPath, html, { mode: 0o600 });
    await job.checkDisk();
    return { title, visibleText, htmlPath, pageHash: sha256(html), responses: captured };
  } finally {
    captureClosed = true;
    await context.clearCookies().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
