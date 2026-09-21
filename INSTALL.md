# SwagScout — install it even if you've never written code

This guide assumes **nothing**: not the terminal, not Node, not Docker. Pick **one** of the two paths:

| Path | You install | Best if |
|---|---|---|
| **A. Docker** (recommended) | Docker Desktop only | Fewest commands, keeps running, no other setup |
| **B. Node.js** | Node.js only | You can't or don't want to install Docker |

Both paths take ~15 minutes, and most of that is creating the Discord bot (Part 1) — done once.

---

## Part 1 — Create the Discord bot (~10 minutes, one time)

SwagScout delivers deal alerts through Discord, so first you make a little bot account.

1. **Open <https://discord.com/developers/applications>** in your browser and log in to your Discord account.
2. Click **"New Application"** (top right). Give it a name — e.g. `SwagScout` — and accept.
3. In the left menu click **"Bot"**, then click **"Reset Token"** → **Copy**. This long string is your **bot token**. Treat it like a password — you'll paste it into a file in Part 2, and if you ever leak it, come back here and Reset it again.
4. While still on the Bot page: scroll to **"Public Bot"** and turn it **off** (so only you can invite it). Optional: upload an avatar image for the bot here.
5. In the left menu click **"Installation"** (or "OAuth2" → "URL Generator" on older layouts). Under scopes tick **`bot`** and **`applications.commands`**. No special permissions are needed beyond sending messages. Copy the generated **install link**, open it in a browser, pick your server, and authorize.
6. In your Discord server, **create (or pick) a channel** for alerts. Note the channel's **ID**: enable Developer Mode (Discord → Settings → Advanced → Developer Mode), then right-click the channel → **Copy Channel ID**. If you want to restrict where alerts go, that ID goes into `DISCORD_ALLOWED_CHANNELS` in Part 2.

Use the bot in Discord with slash commands: type `/watch brand:all` in the alert channel to receive everything, `/watch brand:yohji` for just one brand (see `/brands` for the list), `/status` to check health, `/deals` and `/finds` for previews.

---

## Part 2 — Run SwagScout

### Path A — Docker (recommended)

1. **Install Docker Desktop:** download from <https://www.docker.com/products/docker-desktop/>, run the installer, accept the defaults, and start it. Wait until it says "running".
2. **Get SwagScout onto your computer:** on the project's GitHub page click the green **Code** button → **Download ZIP**. Unzip it somewhere you'll find it again (e.g. your Desktop).
3. **Make your settings file:** inside the unzipped `swagscout-main` folder, find the file named `.env.example`. Make a **copy** of it and rename the copy to exactly `.env` (if you don't see file extensions, enable "File name extensions" in the Windows File Explorer View menu). Open `.env` in Notepad:
   - Set `DISCORD_TOKEN=` to the token you copied in Part 1.
   - Set `DISCORD_ALLOWED_CHANNELS=` to your channel ID from Part 1.
   - Everything else can stay as-is to start.
4. **Start it:** open a terminal **in that folder** — on Windows: click the folder's address bar in File Explorer, type `powershell`, press Enter — then run:
   ```powershell
   docker compose up -d --build
   ```
   The first build takes a few minutes. Afterward the bot runs in the background and **starts again by itself** whenever your computer restarts (Docker Desktop must be running).
5. **Look at it:** open <http://localhost:3080> in your browser — that's your live dashboard.

**Handy commands** (same terminal):
```powershell
docker compose logs -f        # see what it's doing (Ctrl+C to stop looking)
docker compose restart        # restart after changing .env
docker compose down           # stop it
```

Your deals database lives in the `data` folder the compose file mounts, so stopping or restarting keeps your history.

### Path B — Node.js (no Docker)

1. **Install Node.js:** download the **23.x (or newer) LTS** installer from <https://nodejs.org/> and accept the defaults. Verify: open a terminal anywhere, type `node -v`, press Enter — you should see `v23.x.x` or higher.
2. **Get SwagScout onto your computer:** same as Path A step 2 (Download ZIP, unzip).
3. **Make your settings file:** same as Path A step 3 (copy `.env.example` to `.env`, fill in `DISCORD_TOKEN=` and optionally `DISCORD_ALLOWED_CHANNELS=`).
4. **Install and start:** open a terminal in the project folder (address bar → type `powershell` → Enter) and run:
   ```powershell
   npm install
   npm run build
   npm start
   ```
5. **Look at it:** open <http://localhost:3080>.

To keep it running after you close the terminal, run it inside [PM2](https://pm2.keymetrics.io/) (`npm install -g pm2`, then `pm2 start dist/index.js --name swagscout`, `pm2 save`) or just leave the window open. To update later: re-download the ZIP, replace the folder's contents (keep your `.env` and `data` folder), then `npm install && npm run build` and start again.

---

## Part 3 — Check it worked

- **Dashboard:** <http://localhost:3080> shows a live deal feed. The header status line shows each market with ✓ (answering), ! (last attempt failed), or ? (never polled/disabled).
- **Discord:** in your alert channel type `/status` — the bot should reply within a second or two with per-market health. Type `/watch brand:all` to start receiving alerts.
- **First deals:** alerts arrive as listings are found; give it an hour. `/finds` shows the day's top 10 ranked finds.

## Something wrong?

| Symptom | Fix |
|---|---|
| `/status` gets no reply | The bot token is wrong or the bot wasn't invited to your server — redo Part 1 steps 3 and 5 |
| Bot replies but no alerts | Add the channel with `/watch brand:all`; check `DISCORD_ALLOWED_CHANNELS` contains that channel's ID |
| Dashboard won't open | The server isn't running — check `docker compose logs -f` (Path A) or the terminal output (Path B) |
| A market shows `!` | That market's site is failing or blocking; it will recover on its own — `?` just means never polled (e.g. eBay needs free API keys, see `.env.example`) |
| Grailed shows ✓ but `0/24h` | Grailed blocks many datacenter/home IPs; it needs a residential proxy via `BROWSER_PROXY` in `.env` (see README) |
| "node is not recognized" (Path B) | Node.js isn't installed or the terminal was open during install — install Node, then open a **new** terminal |

---

*Setting this up for a project you didn't build? The developer-facing README covers configuration, architecture, and how to contribute.*
