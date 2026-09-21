import { afterEach, describe, expect, it, vi } from "vitest";
import { runShutdown, SHUTDOWN_TIMEOUT_MS, type ShutdownSteps } from "../src/core/shutdown.js";

function makeSteps(
  overrides: Partial<ShutdownSteps> = {},
  calls: string[] = [],
): ShutdownSteps & { calls: string[] } {
  const steps = {
    calls,
    stopPolling: vi.fn(() => calls.push("stopPolling")),
    stopCatchUp: vi.fn(async () => calls.push("stopCatchUp")),
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
      "stopCatchUp",
      "closeNotifier",
      "closeDashboard",
      "closeBrowser",
      "closeDispatcher",
      "closeStore",
    ]);
  });

  it("does not close the store until the catch-up has stopped", async () => {
    let release!: () => void;
    const stopping = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const s = makeSteps(
      {
        stopCatchUp: async () => {
          calls.push("stopCatchUp:begin");
          await stopping;
          calls.push("stopCatchUp:end");
        },
        closeStore: () => void calls.push("closeStore"),
      },
      calls,
    );

    const run = runShutdown(s, "SIGINT");
    // One turn: the sequence must be parked inside stopCatchUp with the store
    // still open — that wait is the difference between a clean stop and the
    // database being closed under a live writer.
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(["stopPolling", "stopCatchUp:begin"]);

    release();
    await run;
    expect(calls).toEqual([
      "stopPolling",
      "stopCatchUp:begin",
      "stopCatchUp:end",
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
