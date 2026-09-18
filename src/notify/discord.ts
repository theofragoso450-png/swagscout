import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import type { Deal, PollResult } from "../types.js";
import { ALL_MARKETS, MARKET_LABEL } from "../types.js";
import { BRANDS } from "../config/brands.js";
import type { Store } from "../core/store.js";
import { logger } from "../logger.js";
import { buildDealEmbed, buildDealEmbeds, buildFindEmbeds, type EmbedPayload } from "./embeds.js";
import { dealMatchesSubscription } from "./matching.js";
import { rankFinds } from "./finds.js";
import { digestTick } from "./digest.js";

export interface NotifierEnv {
  token?: string;
  webhookUrl?: string;
  /** Channel IDs the bot may post into. Empty = no restriction. */
  allowedChannels: string[];
}

/**
 * Discord notifier.
 *  - Bot mode (token): slash commands (/watch /unwatch /brands /status /deals)
 *    and per-channel subscription routing with minScore filtering.
 *  - Webhook mode (webhookUrl): fire-and-forget alerts, no commands.
 */
export class DiscordNotifier {
  private client: Client | null = null;
  private allowed: Set<string>;
  /** Channel ID → webhook URL, resolved lazily in bot mode. */
  private webhookUrls = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly env: NotifierEnv,
  ) {
    this.allowed = new Set(env.allowedChannels);
  }

  /** Start the daily finds digest scheduler (bot mode only). */
  startDigest(hour = 8): void {
    const runTick = (): void => {
      void digestTick(
        Date.now(),
        this.store,
        async (embeds, channels) => this.sendEmbedsToChannels(embeds, channels),
        hour,
      ).catch((err) => logger.error({ err }, "finds digest failed"));
    };
    const timer = setInterval(runTick, 60_000);
    timer.unref?.();
    runTick(); // catch-up: a boot after today's slot still delivers it
  }

  async start(): Promise<void> {
    if (this.env.token) {
      await this.startBot();
    } else if (this.env.webhookUrl) {
      logger.info("discord: webhook-only mode");
    } else {
      logger.warn("discord: no token or webhook configured — alerts will be logged only");
    }
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
  }

  private async startBot(): Promise<void> {
    const token = this.env.token!;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.on(Events.ClientReady, async (c) => {
      logger.info({ user: c.user?.tag, guilds: c.guilds.cache.size }, "discord bot ready");
      const appId = c.application?.id;
      if (appId) {
        await this.registerCommands(token, appId).catch((err) =>
          logger.error({ err }, "failed to register slash commands"),
        );
      }
    });

    client.on(Events.InteractionCreate, async (i) => {
      if (!i.isChatInputCommand()) return;
      try {
        await this.handleCommand(i);
      } catch (err) {
        logger.error({ err }, "command handler error");
        if (!i.replied && !i.deferred) {
          await i.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
        }
      }
    });

    await client.login(token);
    this.client = client;
  }

  private async registerCommands(appToken: string, appId: string): Promise<void> {
    const watchOption = (o: SlashCommandBuilder) =>
      o.addStringOption((so) =>
        so.setName("brand").setDescription("Brand key (see /brands) or 'all'").setRequired(true),
      );

    const commands = [
      watchOption(
        new SlashCommandBuilder()
          .setName("watch")
          .setDescription("Subscribe this channel to deal alerts"),
      ).addNumberOption((o) =>
        o.setName("min_score").setDescription("Minimum deal score 0-100 (default 0)").setRequired(false),
      ).addStringOption((o) =>
        o.setName("size").setDescription("Only alert listings in this size, e.g. M or 28 (default: any)").setRequired(false),
      ),
      watchOption(
        new SlashCommandBuilder().setName("unwatch").setDescription("Remove a watch from this channel"),
      ),
      new SlashCommandBuilder().setName("brands").setDescription("List monitored brands and threshold caps"),
      new SlashCommandBuilder().setName("status").setDescription("Bot health and poll statistics"),
      new SlashCommandBuilder()
        .setName("deals")
        .setDescription("Show recent deals for this channel's watch")
        .addIntegerOption((o) =>
          o.setName("limit").setDescription("Max deals to show (default 5)").setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("finds")
        .setDescription("Top 10 finds of the day — rarest comp-backed deals")
        .addIntegerOption((o) =>
          o.setName("hours").setDescription("Look-back window in hours (default 24)").setRequired(false),
        ),
    ].map((c) => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(appToken);
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    logger.info({ count: commands.length }, "slash commands registered globally");
  }

  private async handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    switch (i.commandName) {
      case "watch":
        return this.cmdWatch(i);
      case "unwatch":
        return this.cmdUnwatch(i);
      case "brands":
        return this.cmdBrands(i);
      case "status":
        return this.cmdStatus(i);
      case "deals":
        return this.cmdDeals(i);
      case "finds":
        return this.cmdFinds(i);
    }
  }

  private channelAllowed(channelId: string): boolean {
    return this.allowed.size === 0 || this.allowed.has(channelId);
  }

  private async cmdWatch(i: ChatInputCommandInteraction): Promise<void> {
    const watch = i.options.getString("brand", true).toLowerCase();
    const minScore = i.options.getNumber("min_score") ?? 0;
    const size = i.options.getString("size")?.trim() || null;
    if (!i.guildId) {
      await i.reply({ content: "Use /watch in a server channel.", ephemeral: true });
      return;
    }
    if (!this.channelAllowed(i.channelId)) {
      await i.reply({ content: "This channel isn't allow-listed via DISCORD_ALLOWED_CHANNELS.", ephemeral: true });
      return;
    }
    this.store.addSubscription({ guildId: i.guildId, channelId: i.channelId, watch, minScore, size });
    const sizeNote = size ? ` in size **${size}**` : "";
    await i.reply({
      content:
        watch === "all"
          ? `✅ Watching **everything**${sizeNote} in this channel.`
          : `✅ Watching **${watch}**${sizeNote} here (min score ${minScore}).`,
      ephemeral: true,
    });
  }

  private async cmdUnwatch(i: ChatInputCommandInteraction): Promise<void> {
    const watch = i.options.getString("brand", true).toLowerCase();
    if (!i.guildId) {
      await i.reply({ content: "Use /unwatch in a server channel.", ephemeral: true });
      return;
    }
    const removed = this.store.removeSubscription(i.guildId, i.channelId, watch);
    await i.reply({
      content: removed ? `🗑 Removed **${watch}** from this channel.` : "No matching watch found here.",
      ephemeral: true,
    });
  }

  private async cmdBrands(i: ChatInputCommandInteraction): Promise<void> {
    const lines = BRANDS.map((b) => `**${b.name}** — \`${b.key}\``);
    await i.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
  }

  private async cmdStatus(i: ChatInputCommandInteraction): Promise<void> {
    const subs = this.store.listSubscriptions().length;
    const tracked = this.store.recentListings(24 * 14).length;
    const deals = this.store.recentDeals(["all"], 1).length;
    await i.reply({
      content: [
        `📡 Markets: ${ALL_MARKETS.map((m) => MARKET_LABEL[m]).join(", ")}`,
        `👀 Subscriptions: ${subs}`,
        `🗂 Listings tracked (14d): ${tracked}`,
        deals > 0 ? "💾 Deal history: available" : "💾 Deal history: empty",
      ].join("\n"),
      ephemeral: true,
    });
  }

  private async cmdDeals(i: ChatInputCommandInteraction): Promise<void> {
    const limit = Math.min(i.options.getInteger("limit") ?? 5, 10);
    const subs = this.store.listSubscriptions().filter((s) => s.channelId === i.channelId);
    const pool = this.store.recentDeals(["all"], 50);
    const deals = pool
      .filter((d) => subs.length === 0 || subs.some((s) => dealMatchesSubscription(d, s)))
      .slice(0, limit);
    if (deals.length === 0) {
      await i.reply({ content: "No recent deals recorded.", ephemeral: true });
      return;
    }
    await i.reply({ embeds: buildDealEmbeds(deals), ephemeral: true });
  }

  private async cmdFinds(i: ChatInputCommandInteraction): Promise<void> {
    const hours = Math.min(Math.max(i.options.getInteger("hours") ?? 24, 1), 168);
    const pool = this.store.recentDeals(["all"], 500);
    const finds = rankFinds(pool, hours);
    if (finds.length === 0) {
      await i.reply({
        content:
          `No comp-backed finds in the last ${hours}h. ` +
          "Deals need cross-market comps to rank — try /deals for the latest regardless.",
        ephemeral: true,
      });
      return;
    }
    const embeds = buildFindEmbeds(finds);
    await i.reply({ embeds, ephemeral: true });
  }

  // ── alert routing ────────────────────────────────────────────────────────

  /** Fan out new deals to subscribed channels (bot mode) or webhook. */
  async sendDeals(results: PollResult[]): Promise<void> {
    const deals = results.flatMap((r) => r.deals);
    if (deals.length === 0) return;

    if (this.client) {
      for (const deal of deals) {
        await this.routeDeal(deal);
      }
    } else if (this.env.webhookUrl) {
      const embeds = buildDealEmbeds(deals.slice(0, 10));
      await this.sendWebhook(this.env.webhookUrl, embeds).catch((err) =>
        logger.warn({ err }, "webhook send failed"),
      );
    } else {
      logger.info({ count: deals.length }, "deals found (no discord configured)");
    }
  }

  private async sendEmbedsToChannels(embeds: EmbedPayload[], channels: string[]): Promise<string[]> {
    const sent: string[] = [];
    for (const channelId of channels) {
      if (!this.channelAllowed(channelId)) continue;
      try {
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          await channel.send({ embeds });
          sent.push(channelId);
        }
      } catch (err) {
        logger.debug({ err, channelId }, "failed to send to channel");
      }
    }
    return sent;
  }

  private async routeDeal(deal: Deal): Promise<void> {
    const subs = this.store.listSubscriptions().filter((s) => dealMatchesSubscription(deal, s));
    const embeds = buildDealEmbeds([deal]);
    await this.sendEmbedsToChannels(embeds, subs.map((s) => s.channelId));
  }

  private async sendWebhook(
    url: string,
    embeds: ReturnType<typeof buildDealEmbeds>,
  ): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds, username: "SwagScout" }),
    });
    if (!res.ok) {
      throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}
