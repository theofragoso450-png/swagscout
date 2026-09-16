import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/core/http.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RateLimiter concurrency (politeness must not leak under parallel load)", () => {
  it("a drained limiter with no refill lets NOTHING through, no matter how many waiters", async () => {
    // capacity 3, refill 0: after draining the burst, zero tokens will ever
    // exist — every parallel acquire must stay pending. The historical bug:
    // N slow-path waiters shared one refill snapshot and all passed.
    const limiter = new RateLimiter(3, 0);
    for (let i = 0; i < 3; i++) await limiter.acquire(); // drain fast path

    const results = await Promise.race([
      Promise.allSettled(Array.from({ length: 20 }, () => limiter.acquire())),
      wait(400).then(() => "timeout" as const),
    ]);
    expect(results).toBe("timeout");
  });

  it("parallel acquires are paced one-token-at-a-time (no collective double-spend)", async () => {
    // capacity 1, refill 5/s: 8 parallel acquires = 1 immediate + 7 tokens
    // × 200ms ⇒ ≥ 1400ms total. The double-spend passed all 8 in ~one wait.
    const limiter = new RateLimiter(1, 5);
    const start = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => limiter.acquire()));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1100); // pacing held
    expect(elapsed).toBeLessThan(5000); // sanity: not deadlocked
  }, 15_000);
});
