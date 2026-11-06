# Retrolash: project context

Quiplash-style party game for Scrum retrospectives. The big meeting-room screen is the host; players join on phones via QR code or a 4-letter room code. See README.md for gameplay and commands.

## Stack
- React 18 + Vite 8 + TypeScript (client, `src/`)
- PartyKit (`party/server.ts`): one room per game, **server-authoritative** state machine
- `shared/`: wire protocol types and prompt library, used by both sides
- No router. Query-string routes: `/?host=ABCD` (big screen), `/?room=ABCD` (phone)
- Deploy target: `npm run deploy`. PartyKit serves both the server and `dist/` on one origin

## Design decisions (agreed with the user)
- Rounds: **Warm-up** (pure-fun icebreaker jokes, required), **The Sprint** (retro prompts, head-to-head, pauses after each matchup for discussion), **Last Lash** (everyone answers one prompt, multi-vote, becomes ranked action items).
- Anonymity works like Quiplash by default: answers are anonymous during voting, then authors and voters are revealed. An optional "Anonymous mode" toggle hides authors, voters and scores entirely.
- Summary exports Markdown (copy / download) so outcomes can go to Jira/Confluence/Slack.
- Min 3 players, max 16. Each player gets 2 prompts per head-to-head round (circular pairing).
- The server sends each connection a tailored view (`HostView` / `PlayerView`); never broadcast secret state.
- State is persisted in room storage; phones keep identity per browser tab (sessionStorage device id passed as PartySocket `id`).

## Dev
- `npm install`, then `npm run dev` (PartyKit :1999 + Vite :5173 on the LAN)
- `node scripts/bots.mjs ABCD 4` fills a room with bot players
- `npm run typecheck`

## Status
- v0.1 works end to end. It has been tested with bots and headless screenshots of the host and phone views.
- Not yet verified on real phones or a real meeting-room screen.
- Display font (Bricolage Grotesque via Google Fonts) hasn't been seen rendered yet.

## Ideas not yet built
- Avatars of voters shown on the answer cards (like Quiplash) instead of names
- Sound effects / music on the big screen
- Swedish prompt set + language toggle
- Fewer prompts per player for big teams (>8) to keep voting rounds short
- Let a "VIP" phone control the game so the facilitator doesn't need the laptop
- Previous retro's action items carried into the next session
