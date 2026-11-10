# Retrolash: project context

Quiplash-style party game for Scrum retrospectives. The big meeting-room screen is the host; players join on phones via QR code or a 4-letter room code. See README.md for gameplay and commands.

## Stack
- React 18 + Vite 8 + TypeScript (client, `src/`)
- Node game server: `server/game.ts` is the **server-authoritative** state machine (one `GameRoom` per game, transport-agnostic); `server/main.ts` is the runtime (static `dist/`, WebSockets on `/parties/main/<room>?_pk=<id>`, state saved as JSON in `DATA_DIR`). Single instance by design.
- Client uses `partysocket` purely as a reconnecting WebSocket; there is no PartyKit dependency any more
- `shared/`: wire protocol types (`types.ts`), screen texts in English + Swedish (`i18n.ts`, `Strings` type keeps them in sync), prompts (`prompts.ts` English + Sprint packs, `prompts-sv.ts` Swedish), used by both sides. Client reads strings via `useT()` in `src/lang.tsx`
- No router. Query-string routes: `/?host=ABCD` (big screen), `/?room=ABCD` (phone)
- Deploy target: Azure Container Apps (consumption, scale to zero, max 1 replica) on the user's Visual Studio/MSDN subscription, image on `ghcr.io/flowersfx/retrolash`. See `infra/README.md`. Always pass `--subscription` explicitly: the user's az default is an unrelated subscription
- Repo: https://github.com/flowersfx/retrolash (public). CI: `.github/workflows/deploy.yml`

## Design decisions (agreed with the user)
- Round order (`planRounds` in `shared/types.ts`): **Check-in** (anonymous sprint weather) → **Did we do it?** (only if last retro's action items are pasted in the lobby) → **Warm-up** (pure-fun jokes) → **Emoji Only** → **The Sprint** (retro prompts from a chosen pack: classic mix, Start/Stop/Continue, 4Ls, Sailboat, Mad/Sad/Glad; head-to-head; at least 2 rounds, 3 with 3 players; later rounds score ×3) → **Kudos** (anonymous shout-outs to a teammate or the team, no score) → **Last Lash** (one prompt, multi-vote, ranked action items, people volunteer as owners) → **Podium** (auto, skipped in anonymous mode) → summary.
- Each head-to-head matchup has a server phase `matchupIntro` (3.6 s anticipation) before `voting`. The host lags its stage behind the live view by 650 ms on screen changes so the old screen can animate out (`useStaged` in `src/Host.tsx`); card exits are 5 CSS variants picked per matchup. A unanimous win (RETROLASH) knocks the loser out and centres the winner.
- Everything auto-advances on timers (the Sprint discussion pause defaults to 60 s, P holds it). Only Last Lash results and the summary wait for the facilitator. "Wait for me" (discussionSeconds 0) restores manual Sprint pauses.
- **Audience** role (`audience` flag on the player): votes, reacts, can own action items; never answers, scores, does the check-in, or blocks auto-advance (gets a 5 s grace after players finish voting). Max 40, separate from the 16-player cap.
- Big screen should feel like a show: matchup intros, voters' coloured name plates fly (FLIP) from a pool onto the card they picked, count-ups, streak/comeback/lead-change callouts, confetti, synthesized Web Audio sfx + background music loop (`src/sound.ts`, host only, music ducks under sfx and quietens during discussions; 🎵 panel has music on/off + music/effects volume, stored in localStorage), floating emoji reactions, commentary lines, a mini QR in the header mid-game. Respect `prefers-reduced-motion`.
- Players choose avatar (unique among players) and plate colour (`PLATE_COLORS`). A **VIP** flag (set by the host, 🎛️ in the lobby) makes a phone a remote: start/next/hold. Phones see their own matchup result (`myResult`) and rank.
- Spoken prompts (`server/tts.ts`): Azure AI Speech REST, generated on demand, cached in `DATA_DIR/tts/{lib,room}` by hash of voice+text. lib = built-in text, kept for good; room = custom text, swept with saved games. The game prefetches (titles at start, prompts during answering) and only uses clips already on disk when a phase starts (`spokenPhase` stretches the phase to fit), so speech never blocks. Clients can only fetch clips the server made. Answers aren't read yet: add them via `spokenPhase` on voting + prefetch in `endAnswering`. The Speech account is a **shared lab resource** in `rg-lab-shared` (`infra/lab/`), key wired in via `listKeys()` into a Container Apps secret. `TTS_FAKE=1` fakes it for tests.
- Language (`settings.lang`, en/sv) drives big screen, phones, prompts, server error messages and the Markdown export; `parsePreviousItems` reads both languages.
- Anonymity works like Quiplash by default: answers are anonymous during voting, then authors and voters are revealed. An optional "Anonymous mode" toggle hides authors, voters and scores entirely.
- Summary exports Markdown (copy / download) so outcomes can go to Jira/Confluence/Slack.
- Min 3 players, max 16. Each player gets 2 prompts per head-to-head round (circular pairing).
- The server sends each connection a tailored view (`HostView` / `PlayerView`); never broadcast secret state.
- State is persisted in room storage; phones keep identity per browser tab (sessionStorage device id passed as PartySocket `id`), and remember the last identity per room in localStorage (12 h) so a closed tab can "Continue as …".

## Dev
- `npm install`, then `npm run dev` (game server :1999 via tsx watch + Vite :5173 on the LAN)
- `node scripts/bots.mjs ABCD 4 [host]` fills a room with bot players (wss for non-local hosts)
- `npm run build` = client to `dist/` + server bundle to `dist-server/main.js`; `npm start` runs it
- `npm run typecheck`; `npm test` = helper self-tests + full end-to-end bot game in Swedish and English (`scripts/e2e.mjs sv|en`, `TIME_SCALE=0.1`; a scripted VIP phone starts the game and presses next), also run in CI
- `node scripts/bots.mjs ABCD 4 [host] [audienceCount]` bots cover every round type, audience, reactions and owner claims

## Status
- v0.1 works end to end. It has been tested with bots and headless screenshots of the host and phone views.
- v0.2 moved from PartyKit to the Node server + Azure Container Apps. Verified locally: full bot game, and a hard server kill mid-round resumes from saved state. Real-device test plan: `TEST_PLAN.md`
- Deployed 2026-11-09 to `rg-retrolash` (Sweden Central, MSDN subscription in a non-Valtech tenant): https://retrolash.redwave-9c864cfa.swedencentral.azurecontainerapps.io. Verified: full bot game over wss, saved games land in the Azure Files share, cold start ~40 s. GitHub OIDC auto-deploy not set up yet (rollouts are manual `az containerapp update`)
- 2026-11-09: first real test run on the Azure deployment with 4 human players on phones. Worked end to end. Feedback: too few Sprint rounds for 4 people, should auto-advance, wants more show on the big screen and an audience role.
- v0.3 (built 2026-11-09, deployed the same day as image `423501a`, live smoke test with bots + audience bot passed; not yet tested with humans): check-in, follow-up, emoji round, multi-round Sprint, auto-advance + hold, audience, reactions, sound, staged reveals, commentary, discussion prompts, owners, help button. Verified with e2e bots + headless screenshots of host and phone.
- v0.4 (built and deployed 2026-11-10 as image `ff8d194`, revision `retrolash--0000002`; live smoke test in Swedish with bots + audience passed; not yet tested with humans): matchup intros, card exits, RETROLASH animation, name plates, podium + confetti, corner QR, streak callouts, music, avatar/colour picker, phone results, rejoin, VIP remote, Kudos round, Sprint packs, Swedish. Test plan section 9.
- Spoken prompts deployed 2026-11-10: shared lab Speech `speech-lab-szxyd4hczkgyk` (F0, Sweden Central) in `rg-lab-shared`; Retrolash revision `retrolash--0000003` (image `556a619`) has the `speech-key` secret. Live smoke test: real Swedish clips on round and matchup intros, no synthesis failures. Not yet heard in a room. When running `az` from Git Bash, set `MSYS_NO_PATHCONV=1`, or resource ids starting with `/subscriptions` get mangled into Windows paths (`deploy.ps1` in PowerShell is unaffected).
- Display font (Bricolage Grotesque via Google Fonts) hasn't been seen rendered yet.

## Ideas not yet built
- Fewer prompts per player for big teams (>8) to keep voting rounds short
- Previous retro's action items carried over automatically (today: paste last Markdown export into the lobby)
