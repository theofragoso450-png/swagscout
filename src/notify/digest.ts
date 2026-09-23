import type { Store } from "../core/store.js";
import { rankFinds, findsPool } from "./finds.js";
import { buildFindEmbeds, type EmbedPayload } from "./embeds.js";

/**
 * Daily finds digest: once per scheduled slot (default 08:00 JST), post the
 * top-10 finds of the last 24h to every channel with any subscription.
 *
 * Dedupe lives in the store's meta table keyed by the slot's exact instant,
 * so restarts never double-post and a boot after the slot still delivers the
 * morning post (the schedule runs on every tick; only the slot key gates).
 */

/** Local wall-clock fields for a JST instant, computed without tz databases. */
export function jstFields(now: number): { day: string; hour: number; minute: number } {
  const jst = new Date(now + 9 * 3_600_000);
  return {
    day: jst.toISOString().slice(0, 10),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  };
}

/**
 * The exact instant of today's scheduled slot in JST — even if it already
 * passed (catch-up is the point; the meta dedupe decides whether it sends).
 */
export function dueSlot(now: number, hour = 8): { instant: number; day: string } {
  const { day } = jstFields(now);
  const midnightJst = Date.parse(`${day}T00:00:00Z`) - 9 * 3_600_000;
  return { instant: midnightJst + hour * 3_600_000, day };
}

/** True once today's slot instant has been reached (dedupe is separate). */
export function isDue(now: number, hour = 8): boolean {
  return now >= dueSlot(now, hour).instant;
}

export interface DigestTickResult {
  triggered: boolean;
  sentTo: string[];
  findCount: number;
}

/**
 * One scheduler pass: if the slot is due and not yet sent, rank and post.
 * The meta key records the exact slot instant — idempotent across restarts,
 * and a boot after the slot still delivers the morning post. Snapshot
 * semantics: the digest is whatever the top finds are at send time (an empty
 * or unsendable digest still marks the slot done — no retry all day).
 */
export async function digestTick(
  now: number,
  store: Store,
  send: (embeds: EmbedPayload[], channels: string[]) => Promise<string[]>,
  hour = 8,
): Promise<DigestTickResult> {
  if (!isDue(now, hour)) return { triggered: false, sentTo: [], findCount: 0 };

  const slot = dueSlot(now, hour);
  const sentKey = "digest:lastSent";
  const dayKey = "digest:lastDay";
  if (store.getMeta(sentKey) === String(slot.instant)) {
    return { triggered: false, sentTo: [], findCount: 0 };
  }

  const pool = findsPool(now);
  const velocity = store.sellThroughByBrand(24, now);
  const finds = rankFinds(store.recentDeals(["all"], pool.limit, { since: pool.since }), 24, now, 10, { velocity });
  const channels = [...new Set(store.listSubscriptions().map((s) => s.channelId))];
  let sentTo: string[] = [];
  if (finds.length > 0 && channels.length > 0) {
    sentTo = await send(buildFindEmbeds(finds, velocity), channels);
    if (sentTo.length === 0) return { triggered: false, sentTo: [], findCount: finds.length };
  }
  store.setMeta(sentKey, String(slot.instant));
  store.setMeta(dayKey, slot.day);
  return { triggered: true, sentTo, findCount: finds.length };
}
