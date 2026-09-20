import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { DiscordNotifier } from "../src/notify/discord.js";

/**
 * Operator alerts are the surface that makes background degradation visible:
 * a refresh streak that only reaches the log is a streak nobody reads. These
 * cover the routing an alert takes when Discord is configured, and the
 * deliberate no-op when it is not.
 */

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swagscout-alert-"));
  store = new Store(path.join(dir, "test.db"));
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("DiscordNotifier.alertOperators", () => {
  it("logs and resolves when no discord surface is configured", async () => {
    const notifier = new DiscordNotifier(store, { allowedChannels: [] });
    await expect(notifier.alertOperators("FX rates are stale", "3 failures")).resolves.toBeUndefined();
  });

  it("posts to the configured webhook", async () => {
    const notifier = new DiscordNotifier(store, {
      webhookUrl: "https://example.test/hook",
      allowedChannels: [],
    });
    const posted: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      posted.push(String(url));
      return { ok: true, status: 204, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      await notifier.alertOperators("FX rates are stale", "3 consecutive failures");
    } finally {
      globalThis.fetch = original;
    }

    expect(posted).toEqual(["https://example.test/hook"]);
  });

  it("survives a failing webhook without throwing", async () => {
    const notifier = new DiscordNotifier(store, {
      webhookUrl: "https://example.test/hook",
      allowedChannels: [],
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    try {
      await expect(notifier.alertOperators("t", "d")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
