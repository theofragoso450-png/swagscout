import type { Browser } from "playwright-core";

/**
 * Shared headless-browser fetcher used by adapters whose targets sit behind
 * bot protection (Grailed's Cloudflare, Mercari's SPA). Launches the platform
 * Chrome once per process and reuses it across polls.
 */

let cached: Browser | null = null;
let launching: Promise<Browser> | null = null;

/**
 * Parse BROWSER_PROXY into Playwright's launch shape. Residential proxies are
 * almost always authenticated (user:pass), and Playwright wants credentials in
 * dedicated username/password fields — a bare server URL with embedded
 * credentials silently fails proxy auth. Returns undefined when unset/blank.
 */
export function parseProxyEnv(
  raw: string | undefined,
): { server: string; username?: string; password?: string } | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (!u.hostname) return { server: v };
    const username = decodeURIComponent(u.username) || undefined;
    const password = decodeURIComponent(u.password) || undefined;
    return {
      server: `${u.protocol}//${u.host}`,
      ...(username && { username }),
      ...(password && { password }),
    };
  } catch {
    // Not a parseable URL — pass it through untouched and let the launcher
    // surface the problem.
    return { server: v };
  }
}

export async function getSharedBrowser(executablePath?: string): Promise<Browser> {
  if (cached?.isConnected()) return cached;
  if (launching) return launching;

  launching = (async () => {
    const { chromium } = await import("playwright-core");
    // Optional escape hatch for IP-blocked targets (e.g. Grailed's Cloudflare):
    // BROWSER_PROXY=http://user:pass@proxy-host:port — ideally residential.
    // Credentials are split into Playwright's username/password fields (see
    // parseProxyEnv) — embedded-in-server form silently fails auth.
    const proxy = parseProxyEnv(process.env.BROWSER_PROXY);
    const attempts: Array<Record<string, unknown>> = [];
    if (executablePath) attempts.push({ executablePath });
    attempts.push({ channel: "chrome" }, { channel: "msedge" }, {});
    let lastErr: unknown;
    for (const opts of attempts) {
      try {
        const browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
          ...(proxy ? { proxy } : {}),
          ...opts,
        });
        cached = browser;
        return browser;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("No Chromium/Chrome available for browser fallback");
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export interface BrowserFetchOptions {
  executablePath?: string;
  timeoutMs?: number;
  locale?: string;
  /** Optional CSS selector to wait for before capturing HTML (SPA hydration). */
  waitForSelector?: string;
  selectorTimeoutMs?: number;
}

/**
 * Fetch a same-origin API path from inside a real page on `originUrl`.
 * The page load clears bot checks and seeds cookies, then `fetch` runs with
 * the browser's own credentials — indistinguishable from the site's SPA.
 */
export async function fetchJsonViaBrowser<T>(
  originUrl: string,
  apiPath: string,
  opts: BrowserFetchOptions = {},
): Promise<T> {
  const browser = await getSharedBrowser(opts.executablePath);
  const context = await browser.newContext({
    locale: opts.locale ?? "en-US",
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(originUrl, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 30_000,
    });
    // small settle so challenge scripts finish
    await page.waitForTimeout(1_500);
    const json = await page.evaluate(async (path) => {
      const res = await fetch(path, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`fetch ${path} → ${res.status}`);
      return res.text();
    }, apiPath);
    return JSON.parse(json) as T;
  } finally {
    await context.close();
  }
}

/** Render a page and return its HTML (used for SPA-only sites like Mercari). */
export async function renderPage(
  url: string,
  opts: BrowserFetchOptions = {},
): Promise<string> {
  const browser = await getSharedBrowser(opts.executablePath);
  const context = await browser.newContext({
    locale: opts.locale ?? "ja-JP",
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 30_000,
    });
    if (opts.waitForSelector) {
      await page
        .waitForSelector(opts.waitForSelector, {
          timeout: opts.selectorTimeoutMs ?? 12_000,
        })
        .catch(() => {});
    } else {
      await page.waitForTimeout(2_000);
    }
    return await page.content();
  } finally {
    await context.close();
  }
}

/** Close the shared browser (call on shutdown). */
export async function closeSharedBrowser(): Promise<void> {
  if (cached) {
    await cached.close().catch(() => {});
    cached = null;
  }
}
