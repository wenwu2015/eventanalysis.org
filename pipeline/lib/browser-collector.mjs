import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export class AccessControlError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessControlError";
    this.code = "ACCESS_CONTROL_REQUIRED";
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

export async function collectBrowserPage({ source, url, job, timeoutMs = 45_000, interact }) {
  const target = new URL(url);
  const sourceOrigin = new URL(source.baseUrl).origin;
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
  let sequence = 0;

  page.on("response", (response) => {
    const promise = (async () => {
      const responseUrl = new URL(response.url());
      if (responseUrl.origin !== sourceOrigin) return;
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
      await writeFile(path, body, { mode: 0o600 });
      captured.push({ url: responseUrl.toString(), status: response.status(), path, body });
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  });

  try {
    await pace(source);
    job.retainUrl(target.toString());
    const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
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
    await Promise.allSettled([...pending]);

    const title = await page.title();
    const visibleText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 200_000);
    if (/captcha|verify you are human|access denied|unusual traffic/i.test(`${title}\n${visibleText}`)) {
      throw new AccessControlError("An access-control challenge was detected; no bypass was attempted.");
    }
    const htmlPath = resolve(job.jobDir, "page.html");
    await writeFile(htmlPath, await page.content(), { mode: 0o600 });
    await job.checkDisk();
    return { title, visibleText, htmlPath, responses: captured };
  } finally {
    await context.clearCookies().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
