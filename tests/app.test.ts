import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startApp, type App } from "../src/app.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { normalizeListing } from "../src/core/normalize.js";
import { PIPELINE_VERSION } from "../src/core/pipeline.js";
import { Store } from "../src/core/store.js";
import { runShutdown, type ShutdownSteps } from "../src/core/shutdown.js";

/**
 * The app composition, exercised as it ships. `startApp` boots the real thing —
 * store, notifier, FX, pipeline catch-up, retention, poller, dashboard — against
 * a temporary database, and the shutdown sequence is driven with the app's own
 * `steps`, wrapped only to record the order they ran in. Before app.ts existed
 * this wiring could only be replicated by hand, which is the gap this file
 * closes: drop a step, reorder it, or stop awaiting the catch-up and the
 * assertions below fail, rather than a replica drifting quietly alongside.
 */

/** Everything this file sets; restored after each test regardless of outcome. */
const TOUCHED_ENV = [
  "DB_PATH",
  "FX_REFRESH_HOURS",
  "RETENTION_DAYS",
  "DIGEST_HOUR_JST",
  "DISCORD_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_ALLOWED_CHANNELS",
  "SWAGSCOUT_WATCH",
  "POLL_YAHOO",
  "POLL_GRAILED",
  "POLL_EBAY",
  "POLL_MERCARI",
  "POLL_RAKUMA",
];

let dir: string;
let dbPath: string;
let app: App | undefined;
let saved: Array<[string, string | undefined]>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "app-"));
  dbPath = path.join(dir, "test.db");
  app = undefined;
  saved = TOUCHED_ENV.map((k) => [k, process.env[k]]);

  process.env.DB_PATH = dbPath;
  process.env.FX_REFRESH_HOURS = "0"; // pin the static table: no outbound fetch
  process.env.RETENTION_DAYS = "0"; // the prune job is not what this file is about
  process.env.SWAGSCOUT_WATCH = "cdg";
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DIGEST_HOUR_JST;
  for (const market of ["YAHOO", "GRAILED", "EBAY", "MERCARI", "RAKUMA"]) {
    process.env[`POLL_${market}`] = "3600"; // no poll tick can fire inside a test
  }
});

afterEach(async () => {
  // A test that left the app running would hold the database open, and the temp
  // directory could not be removed. The sequence is idempotent-per-run, so this
  // only fires when the test did not already shut down.
  if (app) {
    await app.shutdown("SIGTERM").catch(() => {});
    app = undefined;
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The env as the entry point loads it, with the dashboard bound where told. */
function bootEnv(port: number): Env {
  const env = loadEnv();
  env.port = port; // 0 lets the OS pick; startApp reports what it actually bound
  return env;
}

/**
 * A port that is genuinely occupied, held until `release()`. Bound to the same
 * wildcard address the dashboard uses — Windows lets a specific-address bind
 * coexist with a wildcard one, so a loopback squatter would not be a conflict.
 */
async function occupiedPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(0, "0.0.0.0", resolve));
  const { port } = squatter.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((resolve) => squatter.close(() => resolve())),
  };
}

/** `n` listings as an older pipeline left them: stale stamp, no derived values. */
function seedBacklog(n: number): void {
  const store = new Store(dbPath);
  for (let i = 0; i < n; i++) {
    store.upsertListing(
      normalizeListing({
        market: "yahoo",
        id: `a${String(i).padStart(4, "0")}`,
        title: "COMME des GARCONS tee",
        price: 3000 + (i % 50) * 10,
        currency: "JPY",
        url: `https://auctions.yahoo.co.jp/jp/auction/a${i}`,
      }),
    );
  }
  store.transaction(() => {
    (
      store as unknown as { db: { prepare: (sql: string) => { run: () => unknown } } }
    ).db
      .prepare("UPDATE listings SET pipelineVersion = 1, brandKey = NULL, size = NULL")
      .run();
  });
  store.close();
}

function count(sql: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe("app composition", () => {
  it("boots the real stack and serves on the port it bound", async () => {
    app = await startApp(bootEnv(0));
    expect(app.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${app.port}/api/health`);
    expect(health.status).toBe(200);

    const page = await fetch(`http://127.0.0.1:${app.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("SwagScout");

    // Nothing is stale, so the background catch-up is a no-op rather than a job.
    const stats = await app.catchUp;
    expect(stats?.scanned).toBe(0);
    expect(stats?.remaining).toBe(0);
  });

  it("stops the catch-up before closing the store, and loses nothing", async () => {
    const backlog = 1500;
    seedBacklog(backlog);

    const running = await startApp(bootEnv(0));
    app = running;

    const order: string[] = [];
    const wrapped = Object.fromEntries(
      Object.entries(running.steps).map(([name, step]) => [
        name,
        async () => {
          order.push(name);
          await (step as () => Promise<void> | void)();
        },
      ]),
    ) as ShutdownSteps;

    const started = Date.now();
    await runShutdown(wrapped, "SIGTERM");
    const elapsed = Date.now() - started;
    app = undefined; // that sequence already closed everything

    expect(order).toEqual([
      "stopPolling",
      "stopCatchUp",
      "closeNotifier",
      "closeDashboard",
      "closeBrowser",
      "closeDispatcher",
      "closeStore",
    ]);

    // It waited for the catch-up to stop, not to finish: 1500 rows take seconds,
    // and closing a connection out from under a live writer must not.
    expect(elapsed).toBeLessThan(3_000);

    // Stopped mid-backlog on purpose — reported as work left, not as an error.
    // 1500 rows take ~7s to rebuild, so a ~0.6s boot window cannot finish them.
    const stats = await running.catchUp;
    expect(stats).toBeDefined();
    expect(stats!.scanned + stats!.remaining).toBe(backlog);
    expect(stats!.remaining).toBeGreaterThan(0);

    // Accounting, on a second connection: every row is stamped or still stale,
    // and what the driver reported is what the database actually holds.
    const stamped = count(`SELECT COUNT(*) AS n FROM listings WHERE pipelineVersion = ${PIPELINE_VERSION}`);
    const stale = count(`SELECT COUNT(*) AS n FROM listings WHERE pipelineVersion < ${PIPELINE_VERSION}`);
    expect(stamped + stale).toBe(backlog);
    expect(stamped).toBe(stats!.scanned);
    expect(stale).toBe(stats!.remaining);

    // And the surface is genuinely down.
    await expect(fetch(`http://127.0.0.1:${running.port}/api/health`)).rejects.toThrow();
  });

  it("tears down a boot that cannot bind, leaving no open store", async () => {
    const taken = await occupiedPort();
    const outcome = await startApp(bootEnv(taken.port)).then(
      (booted) => booted,
      (err: Error) => err,
    );
    await taken.release();

    if (!(outcome instanceof Error)) {
      await outcome.shutdown("SIGTERM");
      throw new Error("startApp resolved despite the port being taken");
    }

    // The store that boot had already opened is closed with it. SQLite drops its
    // WAL sidecars on the last clean close — the platform-portable signal, so CI
    // catches this too. On Windows the stronger one is that the directory can be
    // removed at all: a leaked handle is exactly what a store left open leaves.
    expect(readdirSync(dir)).toEqual(["test.db"]);
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
  });
});
