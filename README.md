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

This starts the PartyKit game server on `:1999` and Vite on `:5173`. Vite listens on your LAN, so phones on the same Wi-Fi can join via `http://<your-ip>:5173`. The QR code points there automatically when you open the host page by IP instead of `localhost`.

To test without a pile of phones, fill a room with bots:

```bash
node scripts/bots.mjs ABCD 4        # room code, number of bots
```

Type check with `npm run typecheck`.

## Deploy

PartyKit hosts both the game server and the built static site on one URL:

```bash
npx partykit login     # once, GitHub login
npm run deploy         # vite build + partykit deploy
```

You'll get `https://retrolash.<your-github-username>.partykit.dev`. Open it on the meeting-room screen and you're done.

To host the frontend elsewhere (Netlify, Vercel, GitHub Pages), build with `VITE_PARTYKIT_HOST=retrolash.<you>.partykit.dev npm run build` and deploy `dist/`. Routing uses query strings (`?host=ABCD`, `?room=ABCD`), so no SPA rewrites are needed.

### Vercel (frontend) + PartyKit (game server)

Vercel can't run the game server, because it needs long-lived WebSockets and per-room state. So the split is:

1. Deploy the game server once: `npx partykit login`, then `npm run deploy`. Note the host it prints, e.g. `retrolash.<you>.partykit.dev`.
2. Import the GitHub repo in Vercel. `vercel.json` sets the build (typecheck + `vite build`, output `dist`).
3. In Vercel → Settings → Environment Variables, add `VITE_PARTYKIT_HOST` = that host (no `https://`) for **Production and Preview**.
4. Redeploy. Vite bakes the variable in at build time, so changing it always needs a new build.

Redeploy the PartyKit side (`npm run deploy`) whenever `party/` or `shared/` changes. Vercel only rebuilds the frontend.

## Architecture

```
party/server.ts     Authoritative game state machine (one PartyKit room per game)
shared/types.ts     Wire protocol + settings shared by server and client
shared/prompts.ts   Prompt library (warm-up + retro)
src/Host.tsx        Big-screen view
src/Play.tsx        Phone controller
src/net.ts          PartySocket hook, countdown, room codes
scripts/bots.mjs    Bot players for testing
```

The server holds all state and sends each connection its own view. The host sees the matchup; a phone sees only its own prompts and ballots. State is persisted to room storage, so a reload of the big screen or a phone resumes where it was. Phones keep their identity per browser tab.
