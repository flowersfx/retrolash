# Retrolash

A Quiplash-style party game for Scrum retrospectives. The meeting-room screen hosts the game; everyone plays on their phone by scanning a QR code. No accounts, no app install.

## How a game runs

1. **Lobby.** The host opens the site on the big screen and clicks *Host a retro*. Players scan the QR code (or enter the 4-letter room code) and type a name. You need at least 3 players.
2. **Warm-up.** This is a pure-fun icebreaker round. Each player gets two silly prompts. Every prompt goes to two players, and their answers go head-to-head on the big screen while everyone else votes.
3. **The Sprint.** Same format, but with retro prompts ("The thing that slowed us down the most", "If this sprint was a movie…"). After each matchup the game pauses so the team can talk about it. The facilitator advances when ready.
4. **Last Lash: Action Items.** Everyone answers the same prompt (default: *"One concrete thing we should change next sprint"*), with up to 2 ideas each. Everyone then gets 3 votes, and the ranked list becomes your action items.
5. **Summary.** Action items, every sprint answer with its vote count, and the scores. Use *Copy as Markdown* to paste it into Confluence, Jira, or Slack, or *Download .md*.

As in Quiplash, answers are anonymous while people vote. After the vote, the screen shows who wrote what and who voted for which answer. You can switch on **Anonymous mode** in the lobby to hide authors, voters, and scores entirely.

### Facilitator controls (big screen)

- **Space** or **→** advances or skips the timer, presenter-clicker style.
- In the lobby you can pick rounds, change timers, change the final-round prompt, and add **your own retro prompts**, one per line. Your own prompts are used first in *The Sprint*.
- Hover over a player in the lobby to kick them.

## Development

```bash
npm install
npm run dev
```

This starts the game server on `:1999` (`tsx watch server/main.ts`) and Vite on `:5173`. Vite listens on your LAN, so phones on the same Wi-Fi can join via `http://<your-ip>:5173`. The QR code points there automatically when you open the host page by IP instead of `localhost`. Saved games go to `./data/` (git-ignored).

To test without a pile of phones, fill a room with bots:

```bash
node scripts/bots.mjs ABCD 4                                  # local dev server
node scripts/bots.mjs ABCD 4 retrolash.<env>.swedencentral.azurecontainerapps.io   # deployed
```

`npm run typecheck` type-checks everything. `npm run build` builds the client to `dist/` and bundles the server to `dist-server/main.js`; `npm start` runs that build on `:1999` (or `$PORT`).

## Deploy (Azure Container Apps)

One container serves both the web app and the game server, on one URL. It scales to zero when nobody is playing, so the expected cost for a few retros a month is close to zero. See [infra/README.md](infra/README.md) for the full setup, costs and how GitHub Actions rolls out new versions.

Short version:

1. Push to `main`. GitHub Actions builds `ghcr.io/flowersfx/retrolash` and pushes it to GitHub's container registry.
2. Once: `./infra/deploy.ps1 -SubscriptionId <id>` creates the Azure resources (shows a what-if preview first).
3. Optional, once: `./infra/setup-github-oidc.ps1 -SubscriptionId <id>` lets every push to `main` roll out automatically.

## Architecture

```
server/game.ts      Authoritative game state machine (one GameRoom per game); transport-agnostic
server/main.ts      Node runtime: static files, WebSockets (/parties/main/<room>), file-backed state
shared/types.ts     Wire protocol + settings shared by server and client
shared/prompts.ts   Prompt library (warm-up + retro)
src/Host.tsx        Big-screen view
src/Play.tsx        Phone controller
src/net.ts          PartySocket (reconnecting WebSocket) hook, countdown, room codes
scripts/bots.mjs    Bot players for testing
infra/              Bicep template + deploy scripts for Azure Container Apps
```

The server holds all state and sends each connection its own view. The host sees the matchup; a phone sees only its own prompts and ballots. State is saved to disk after every change (Azure Files in production), so a reload of the big screen or a phone, or a server restart, resumes where it was. Saved games are deleted after 24 hours. Phones keep their identity per browser tab.

The server runs as a single instance by design: rooms live in memory. That comfortably handles a handful of simultaneous retros.
