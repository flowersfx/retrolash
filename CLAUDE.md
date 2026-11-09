# Retrolash: project context

Quiplash-style party game for Scrum retrospectives. The big meeting-room screen is the host; players join on phones via QR code or a 4-letter room code. See README.md for gameplay and commands.

## Stack
- React 18 + Vite 8 + TypeScript (client, `src/`)
- Node game server: `server/game.ts` is the **server-authoritative** state machine (one `GameRoom` per game, transport-agnostic); `server/main.ts` is the runtime (static `dist/`, WebSockets on `/parties/main/<room>?_pk=<id>`, state saved as JSON in `DATA_DIR`). Single instance by design.
- Client uses `partysocket` purely as a reconnecting WebSocket; there is no PartyKit dependency any more
- `shared/`: wire protocol types and prompt library, used by both sides
- No router. Query-string routes: `/?host=ABCD` (big screen), `/?room=ABCD` (phone)
- Deploy target: Azure Container Apps (consumption, scale to zero, max 1 replica) on the user's Visual Studio/MSDN subscription, image on `ghcr.io/flowersfx/retrolash`. See `infra/README.md`. Always pass `--subscription` explicitly: the user's az default is an unrelated subscription
- Repo: https://github.com/flowersfx/retrolash (public). CI: `.github/workflows/deploy.yml`

## Design decisions (agreed with the user)
- Rounds: **Warm-up** (pure-fun icebreaker jokes, required), **The Sprint** (retro prompts, head-to-head, pauses after each matchup for discussion), **Last Lash** (everyone answers one prompt, multi-vote, becomes ranked action items).
- Anonymity works like Quiplash by default: answers are anonymous during voting, then authors and voters are revealed. An optional "Anonymous mode" toggle hides authors, voters and scores entirely.
- Summary exports Markdown (copy / download) so outcomes can go to Jira/Confluence/Slack.
- Min 3 players, max 16. Each player gets 2 prompts per head-to-head round (circular pairing).
- The server sends each connection a tailored view (`HostView` / `PlayerView`); never broadcast secret state.
- State is persisted in room storage; phones keep identity per browser tab (sessionStorage device id passed as PartySocket `id`).

## Dev
- `npm install`, then `npm run dev` (game server :1999 via tsx watch + Vite :5173 on the LAN)
- `node scripts/bots.mjs ABCD 4 [host]` fills a room with bot players (wss for non-local hosts)
- `npm run build` = client to `dist/` + server bundle to `dist-server/main.js`; `npm start` runs it
- `npm run typecheck`

## Status
- v0.1 works end to end. It has been tested with bots and headless screenshots of the host and phone views.
- v0.2 moved from PartyKit to the Node server + Azure Container Apps. Verified locally: full bot game, and a hard server kill mid-round resumes from saved state. Real-device test plan: `TEST_PLAN.md`
- Deployed 2026-11-09 to `rg-retrolash` (Sweden Central, MSDN subscription in a non-Valtech tenant): https://retrolash.redwave-9c864cfa.swedencentral.azurecontainerapps.io. Verified: full bot game over wss, saved games land in the Azure Files share, cold start ~40 s. GitHub OIDC auto-deploy not set up yet (rollouts are manual `az containerapp update`)
- 2026-11-09: first real test run on the Azure deployment with 4 human players on phones. Worked end to end; the user wants to make it more interesting next (no specifics yet).
- Display font (Bricolage Grotesque via Google Fonts) hasn't been seen rendered yet.

## Ideas not yet built
- Avatars of voters shown on the answer cards (like Quiplash) instead of names
- Sound effects / music on the big screen
- Swedish prompt set + language toggle
- Fewer prompts per player for big teams (>8) to keep voting rounds short
- Let a "VIP" phone control the game so the facilitator doesn't need the laptop
- Previous retro's action items carried into the next session
