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
- Round order (`planRounds` in `shared/types.ts`): **Check-in** (anonymous sprint weather) → **Did we do it?** (only if last retro's action items are pasted in the lobby) → **Warm-up** (pure-fun jokes) → **Emoji Only** → **The Sprint** (retro prompts, head-to-head; at least 2 rounds, 3 with 3 players; later rounds score ×3) → **Last Lash** (one prompt, multi-vote, ranked action items, people volunteer as owners).
- Everything auto-advances on timers (the Sprint discussion pause defaults to 60 s, P holds it). Only Last Lash results and the summary wait for the facilitator. "Wait for me" (discussionSeconds 0) restores manual Sprint pauses.
- **Audience** role (`audience` flag on the player): votes, reacts, can own action items; never answers, scores, does the check-in, or blocks auto-advance (gets a 5 s grace after players finish voting). Max 40, separate from the 16-player cap.
- Big screen should feel like a show: staged reveals (voter avatars fly onto cards), count-ups, synthesized Web Audio sfx (`src/sound.ts`, host only), floating emoji reactions from phones, commentary lines. Respect `prefers-reduced-motion`.
- Anonymity works like Quiplash by default: answers are anonymous during voting, then authors and voters are revealed. An optional "Anonymous mode" toggle hides authors, voters and scores entirely.
- Summary exports Markdown (copy / download) so outcomes can go to Jira/Confluence/Slack.
- Min 3 players, max 16. Each player gets 2 prompts per head-to-head round (circular pairing).
- The server sends each connection a tailored view (`HostView` / `PlayerView`); never broadcast secret state.
- State is persisted in room storage; phones keep identity per browser tab (sessionStorage device id passed as PartySocket `id`).

## Dev
- `npm install`, then `npm run dev` (game server :1999 via tsx watch + Vite :5173 on the LAN)
- `node scripts/bots.mjs ABCD 4 [host]` fills a room with bot players (wss for non-local hosts)
- `npm run build` = client to `dist/` + server bundle to `dist-server/main.js`; `npm start` runs it
- `npm run typecheck`; `npm test` = helper self-tests + full end-to-end bot game (`scripts/e2e.mjs`, `TIME_SCALE=0.1`), also run in CI
- `node scripts/bots.mjs ABCD 4 [host] [audienceCount]` bots cover every round type, audience, reactions and owner claims

## Status
- v0.1 works end to end. It has been tested with bots and headless screenshots of the host and phone views.
- v0.2 moved from PartyKit to the Node server + Azure Container Apps. Verified locally: full bot game, and a hard server kill mid-round resumes from saved state. Real-device test plan: `TEST_PLAN.md`
- Deployed 2026-11-09 to `rg-retrolash` (Sweden Central, MSDN subscription in a non-Valtech tenant): https://retrolash.redwave-9c864cfa.swedencentral.azurecontainerapps.io. Verified: full bot game over wss, saved games land in the Azure Files share, cold start ~40 s. GitHub OIDC auto-deploy not set up yet (rollouts are manual `az containerapp update`)
- 2026-11-09: first real test run on the Azure deployment with 4 human players on phones. Worked end to end. Feedback: too few Sprint rounds for 4 people, should auto-advance, wants more show on the big screen and an audience role.
- v0.3 (built 2026-11-09, deployed the same day as image `423501a`, live smoke test with bots + audience bot passed; not yet tested with humans): check-in, follow-up, emoji round, multi-round Sprint, auto-advance + hold, audience, reactions, sound, staged reveals, commentary, discussion prompts, owners, help button. Verified with e2e bots + headless screenshots of host and phone.
- Display font (Bricolage Grotesque via Google Fonts) hasn't been seen rendered yet.

## Ideas not yet built
- Background music loop (sfx exist, no music)
- Swedish prompt set + language toggle
- Fewer prompts per player for big teams (>8) to keep voting rounds short
- Let a "VIP" phone control the game so the facilitator doesn't need the laptop
- Previous retro's action items carried over automatically (today: paste last Markdown export into the lobby)
