import { loadEnv } from "./config/env.js";
import { logger } from "./logger.js";
import { startApp } from "./app.js";
import type { Signal } from "./core/shutdown.js";

/**
 * Entry point. The composition itself lives in app.ts so it can be exercised
 * without a process to kill; what belongs here is only what a process owns:
 * loading the environment, translating signals, and setting the exit code.
 */
async function main(): Promise<void> {
  const app = await startApp(loadEnv());

  const shutdown = async (signal: Signal) => {
    await app.shutdown(signal);
    process.exit(0);
  };
  process.on("SIGINT", (sig) => void shutdown(sig as Signal));
  process.on("SIGTERM", (sig) => void shutdown(sig as Signal));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
