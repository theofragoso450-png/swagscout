/**
 * Proxy doctor — diagnoses the BROWSER_PROXY path that Grailed ingest depends
 * on. Run after wiring a residential proxy into .env:
 *
 *   npm run doctor:proxy
 *
 * Checks, in order:
 *   1. BROWSER_PROXY is set (warn-only if not; Grailed needs it off datacenter
 *      IPs, but the rest of the app runs fine without).
 *   2. Direct (no-proxy) egress IP — the baseline your proxy must differ from.
 *   3. Egress IP through the proxy, via a real headless Chromium launch using
 *      the exact proxy config the app uses — proves auth + connectivity, not
 *      just reachability.
 *   4. One live Grailed search through that browser — proves Cloudflare lets
 *      the proxied IP through and rows can actually land.
 *
 * Exit codes: 0 = proxy working end to end; 1 = proxy configured but broken;
 * 2 = not configured (informational only).
 */
import { parseProxyEnv, getSharedBrowser, closeSharedBrowser } from "./core/browser.js";
import { GrailedAdapter } from "./markets/grailed.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

function egressIp(proxy: string | undefined): Promise<{ ip: string | null; cause?: string }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ip: null });
    }, 15_000);
    // undici's own fetch: Node's global fetch ignores the dispatcher option,
    // and ProxyAgent needs a CLEAN uri plus an explicit token — credentials
    // embedded in the uri hang the CONNECT, and are not auto-applied anyway.
    // parseProxyEnv is the same parsing the app ships, so the doctor
    // exercises the real config path.
    const parsed = parseProxyEnv(proxy);
    const agent = parsed
      ? new ProxyAgent({
          uri: parsed.server,
          ...(parsed.username || parsed.password
            ? {
                token: "Basic " +
                  Buffer.from(`${parsed.username ?? ""}:${parsed.password ?? ""}`).toString("base64"),
              }
            : {}),
        })
      : undefined;
    undiciFetch("https://api.ipify.org?format=json", {
      signal: controller.signal,
      ...(agent ? { dispatcher: agent } : {}),
    })
      .then((r) => r.json() as Promise<{ ip?: string }>)
      .then((j) => {
        clearTimeout(timer);
        resolve({ ip: j.ip ?? null });
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        const cause =
          err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
        resolve({ ip: null, cause });
      });
  });
}

async function main(): Promise<number> {
  const raw = process.env.BROWSER_PROXY?.trim() || undefined;
  const parsed = parseProxyEnv(raw);
  if (!raw) {
    console.log("BROWSER_PROXY is not set.");
    console.log("Grailed is Cloudflare IP-sensitive; off a residential IP it shows");
    console.log("'grailed!' (not answering) on the dashboard and no rows land.");
    console.log("Set it in .env, e.g.:  BROWSER_PROXY=http://user:pass@proxy-host:port");
    return 2;
  }
  console.log(`BROWSER_PROXY: ${raw.replace(/\/\/[^@]*@/, "//***@")}`);

  const direct = await egressIp(undefined);
  console.log(`Direct egress IP:   ${direct.ip ?? "(lookup failed)"}`);

  const viaProxy = await egressIp(raw);
  if (!viaProxy.ip) {
    console.log("Proxy egress IP:    (lookup FAILED — proxy unreachable or bad credentials)");
    if (viaProxy.cause) console.log(`  reason: ${viaProxy.cause}`);
    return 1;
  }
  console.log(`Proxy egress IP:    ${viaProxy.ip}`);
  // Keep diagnosing even when suspicious — the browser + Grailed phases below
  // still tell the user whether the chain works; the verdict reflects it.
  const suspiciousEgress = Boolean(direct.ip && viaProxy.ip === direct.ip);
  if (suspiciousEgress) {
    console.log("WARNING: proxy egress equals direct egress — traffic is NOT going through the proxy");
    console.log("(or the proxy exits from your own IP). Continuing diagnostics anyway.");
  } else {
    console.log("Egress differs from direct — proxy is routing traffic. ✓");
  }

  // The same launch path the app uses: proves Playwright accepts the config
  // and that a real browser session works through the proxy.
  let browserOk = false;
  let grailedOk = false;
  let itemCount = 0;
  try {
    await getSharedBrowser();
    browserOk = true;
    console.log("Chromium launches through the proxy. ✓");
  } catch (err) {
    console.log(`Chromium launch FAILED through the proxy: ${err instanceof Error ? err.message : err}`);
  }
  if (browserOk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Grailed adapter never touches HttpClient
      const adapter = new GrailedAdapter({} as never);
      const out = await adapter.search("cdg", { maxItems: 5 });
      itemCount = out.length;
      grailedOk = itemCount > 0;
      console.log(grailedOk
        ? `Grailed answered through the proxy: ${itemCount} listings. ✓✓ Rows will land.`
        : "Grailed answered but returned 0 listings — check your watchlist/brand terms.");
    } catch (err) {
      console.log(`Grailed search FAILED through the proxy: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      console.log("(A 403 here means Cloudflare still blocks this exit IP — try a different proxy region.)");
    }
  }
  await closeSharedBrowser().catch(() => {});

  if (grailedOk) {
    console.log("\nDoctor verdict: HEALTHY — restart the app and watch 'grailed!' flip to 'grailed✓'.");
    return 0;
  }
  if (suspiciousEgress) {
    console.log("\nDoctor verdict: BROKEN — the proxy is not routing traffic (egress equals direct).");
    console.log("Check the proxy URL scheme/port, or whether the provider actually assigned you a remote exit.");
  } else {
    console.log("\nDoctor verdict: proxy works for generic traffic but the Grailed probe did not pass.");
    console.log("Cloudflare may still be challenging this exit IP — try a different proxy region/sticky session.");
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
