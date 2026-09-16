import { logger } from "../logger.js";

export type Signal = "SIGINT" | "SIGTERM";

export interface ShutdownSteps {
  /** Stop accepting new poll rounds; safe to call twice. */
  stopPolling: () => void;
  /** Flush/close Discord client. */
  closeNotifier: () => Promise<void>;
  /** Stop the HTTP dashboard. */
  closeDashboard: () => Promise<void>;
  /** Tear down the shared Playwright browser, if any. */
  closeBrowser: () => Promise<void>;
  /** Close the shared undici Agent (h1-pinned dispatcher). */
  closeDispatcher: () => Promise<void>;
  /** Close SQLite. Must run last. */
  closeStore: () => Promise<void> | void;
}

export const SHUTDOWN_TIMEOUT_MS = 8_000;

let inFlight = false;

/**
 * Runs the shutdown sequence exactly once, in dependency order: stop
 * scheduling new work first, then tear down resources from outermost to
 * innermost, with SQLite last. A second signal while the sequence is running
 * is ignored (no re-entrant double-close of half-torn-down resources); if the
 * sequence hangs, a watchdog force-exits after `timeoutMs`, so worst-case
 * exit latency stays bounded below Docker's 10s SIGKILL.
 */
export async function runShutdown(
  steps: ShutdownSteps,
  signal: Signal,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (inFlight) {
    logger.warn({ signal }, "shutdown already in progress; ignoring repeat signal");
    return;
  }
  inFlight = true;
  logger.info({ signal }, "shutting down");

  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs }, "graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, timeoutMs);
  watchdog.unref();

  // Each step is independently contained: a failing step must never prevent
  // later closes (the SQLite close is the one that really must happen).
  const run = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, step: name }, "shutdown step failed");
    }
  };

  try {
    await run("stopPolling", steps.stopPolling);
    await run("closeNotifier", steps.closeNotifier);
    await run("closeDashboard", steps.closeDashboard);
    await run("closeBrowser", steps.closeBrowser);
    await run("closeDispatcher", steps.closeDispatcher);
    await run("closeStore", steps.closeStore);
  } finally {
    clearTimeout(watchdog);
    inFlight = false; // re-arm: a completed sequence must not block a future one
  }
}
