import { request, Agent } from "undici";

const MAX_REDIRECTS = 5;

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  rpm?: number;
  retries?: number;
}

export class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number, // max burst
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / this.refillPerSec) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 10)));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

export class HttpClient {
  private limiters = new Map<string, RateLimiter>();

  constructor(private readonly defaultRpm: number = 12) {}

  limiterFor(host: string): RateLimiter {
    let l = this.limiters.get(host);
    if (!l) {
      // bucket of 6 burst, refill at rpm/60 per second
      l = new RateLimiter(6, this.defaultRpm / 60);
      this.limiters.set(host, l);
    }
    return l;
  }

  async getText(url: string, opts: FetchOptions = {}): Promise<string> {
    return this.fetchText(url, opts);
  }

  async getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    const text = await this.fetchText(url, {
      ...opts,
      headers: { Accept: "application/json", ...(opts.headers ?? {}) },
    });
    return JSON.parse(text) as T;
  }

  async postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
    const res = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new Error(`POST ${url} → ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  private async fetchText(url: string, opts: FetchOptions): Promise<string> {
    const host = new URL(url).host;
    const limiter = this.limiterFor(host);
    const retries = opts.retries ?? 2;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await limiter.acquire();
        const res = await this.getWithRedirects(url, opts);
        const text = await res.body.text();
        if (res.statusCode >= 400) {
          throw new Error(`GET ${url} → ${res.statusCode}: ${text.slice(0, 200)}`);
        }
        return text;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          const backoff = 500 * 2 ** attempt + Math.random() * 250;
          await sleep(backoff);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** GET that manually follows 3xx redirects (undici v7 removed maxRedirections). */
  private async getWithRedirects(
    url: string,
    opts: FetchOptions,
    depth = 0,
  ): Promise<{ statusCode: number; body: { text(): Promise<string> } }> {
    const res = await request(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        ...(opts.headers ?? {}),
      },
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    if (
      res.statusCode >= 300 &&
      res.statusCode < 400 &&
      res.headers.location &&
      depth < MAX_REDIRECTS
    ) {
      res.body.dump(); // drain before discarding
      const next = new URL(String(res.headers.location), url).toString();
      return this.getWithRedirects(next, opts, depth + 1);
    }
    return res as unknown as { statusCode: number; body: { text(): Promise<string> } };
  }
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitter(ms: number, fraction = 0.25): number {
  const spread = ms * fraction;
  return ms + (Math.random() * 2 - 1) * spread;
}
