import { afterEach, describe, expect, it, vi } from "vitest";
import { runShutdown, SHUTDOWN_TIMEOUT_MS, type ShutdownSteps } from "../src/core/shutdown.js";

function makeSteps(overrides: Partial<ShutdownSteps> = {}): ShutdownSteps & { calls: string[] } {
  const calls: string[] = [];
  const steps = {
    calls,
    stopPolling: vi.fn(() => calls.push("stopPolling")),
    closeNotifier: vi.fn(async () => calls.push("closeNotifier")),
    closeDashboard: vi.fn(async () => calls.push("closeDashboard")),
    closeBrowser: vi.fn(async () => calls.push("closeBrowser")),
    closeDispatcher: vi.fn(async () => calls.push("closeDispatcher")),
    closeStore: vi.fn(() => calls.push("closeStore")),
    ...overrides,
  };
  return steps as ShutdownSteps & { calls: string[] };
}

describe("runShutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every step exactly once, in dependency order, store last", async () => {
    const s = makeSteps();
    await runShutdown(s, "SIGINT");
    expect(s.calls).toEqual([
      "stopPolling",
      "closeNotifier",
      "closeDashboard",
      "closeBrowser",
      "closeDispatcher",
      "closeStore",
    ]);
  });

  it("continues the sequence when an intermediate step throws", async () => {
    const s = makeSteps({
      closeDashboard: vi.fn(async () => {
        throw new Error("fastify exploded");
      }),
    });
    await runShutdown(s, "SIGTERM");
    expect(s.calls).toContain("closeDispatcher");
    expect(s.calls).toContain("closeStore"); // SQLite still closed after the failure
  });

  it("ignores a second signal while the sequence is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = makeSteps({ closeDashboard: () => gate });
    const first = runShutdown(s, "SIGINT");
    const second = runShutdown(s, "SIGTERM");
    release();
    await Promise.all([first, second]);
    expect(s.calls.filter((c) => c === "closeStore")).toHaveLength(1); // no double-close
  });

  it("allows a fresh full sequence after a completed one", async () => {
    const s = makeSteps();
    await runShutdown(s, "SIGINT");
    await runShutdown(s, "SIGTERM");
    expect(s.calls.filter((c) => c === "closeStore")).toHaveLength(2);
  });

  it("force-exits when a step hangs, via the watchdog", async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const s = makeSteps({ closeDashboard: () => new Promise<void>(() => {}) }); // never resolves
    const run = runShutdown(s, "SIGINT", 50);
    await vi.advanceTimersByTimeAsync(60);
    await expect(exitSpy).toHaveBeenCalledWith(1);
    // awaiting the never-resolving run would hang; the spy short-circuits nothing here
    void run;
    exitSpy.mockRestore();
  });

  it("exports the production timeout as a deliberate bound", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(8_000); // under Docker's 10s SIGKILL
  });
});
