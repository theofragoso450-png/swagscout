/**
 * Allowlist gate for URLs that came from outside (marketplace APIs/DOM):
 * only parseable http(s) URLs survive. Everything else — javascript:, data:,
 * garbage — returns null so callers can omit or render inert instead of
 * executing (browser surfaces) or failing validation (Discord embeds).
 */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
