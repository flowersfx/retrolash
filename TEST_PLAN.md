# Retrolash real-device test plan

Goal: confirm Retrolash works on real phones and a real meeting-room screen, over the deployed setup (Azure Container Apps, see `infra/README.md`), before using it in an actual retro.

**Time:** ~45 min. **People:** 1 facilitator + at least 2 others on real phones (bots fill the rest).
**Log every issue** in the table at the bottom, with device, browser, step number and a screenshot if possible.

> Use made-up answers while testing. Saved games sit in Azure Files for 24 h, so don't type real client or project details until that's been cleared (see "Data note" below).

---

## 0. Setup

| # | Step | Expected |
|---|------|----------|
| 0.1 | GitHub Actions run on `main` is green | Image `ghcr.io/flowersfx/retrolash:<sha>` exists and is public |
| 0.2 | `./infra/deploy.ps1 -SubscriptionId <id>` | Prints `https://retrolash.<env>.swedencentral.azurecontainerapps.io` |
| 0.3 | Open `<url>/healthz`, then wait 10 min and open the main URL cold | `ok`. Note the cold-start time on first load after scale-to-zero |
| 0.4 | Open the URL on a laptop, DevTools console open | No red errors |
| 0.5 | Click *Host a retro* | Lobby shows a room code + QR. Network tab shows a `wss://…azurecontainerapps.io/parties/main/<code>` socket with status 101 |

## 1. Devices to cover

Tick each one off at least once during sections 2–5:

- [ ] iPhone, Safari
- [ ] iPhone, Chrome (or another in-app browser, e.g. the camera's QR preview opening a webview)
- [ ] Android, Chrome
- [ ] Android, Samsung Internet (if available)
- [ ] Meeting-room screen: the real laptop → HDMI/USB-C → TV or projector, at its native resolution
- [ ] Phone on **mobile data** (Wi-Fi off), not just office Wi-Fi
- [ ] Phone on **guest Wi-Fi**, if the office has one (corporate networks sometimes block WebSockets)

## 2. Lobby and joining

| # | Step | Expected |
|---|------|----------|
| 2.1 | Scan the QR with the phone's camera app | Opens the join page with the room code prefilled |
| 2.2 | Join by typing the URL + 4-letter code by hand on another phone | Works; lowercase or extra spaces in the code are accepted |
| 2.3 | Enter a name, including one with emoji and one that's 20+ characters | Name shows on the big screen; long names don't break the tile layout |
| 2.4 | Fill the room with bots: `node scripts/bots.mjs ABCD 3 <app-host-without-https>` | Bots appear in the lobby |
| 2.5 | With 2 players, check *Start* | Disabled, with a "need 3 players" hint |
| 2.6 | Hover a player on the big screen and kick them | They disappear from the lobby; their phone shows it was removed |
| 2.7 | Change timers, toggle rounds, add 2 custom retro prompts, edit the Last Lash prompt | Settings stick after reloading the host page |

## 3. Full game, default settings

Play one full game with Warm-up → The Sprint → Last Lash.

| # | Step | Expected |
|---|------|----------|
| 3.1 | Start the game | Round intro on screen; phones show "look at the big screen" or equivalent |
| 3.2 | Answer both prompts on a phone **with the on-screen keyboard open** | Input and submit button stay visible above the keyboard; nothing jumps or zooms (iOS zooms in on inputs under 16px font) |
| 3.3 | Hit the 80-character limit | Input stops or warns; it doesn't silently cut text off after submit |
| 3.4 | Let one player run out the answer timer without answering | Game moves on; their empty slot is handled (placeholder or auto-answer), no crash |
| 3.5 | Voting: authors of the matchup can't vote on it; everyone else can | Phone shows "you're in this one" for the authors |
| 3.6 | Results | Votes, authors and voter names appear after voting, not before |
| 3.7 | The Sprint: after each matchup | Game pauses for discussion; Space or → on the laptop advances |
| 3.8 | Use a presenter clicker, if one is in the room | Clicker's "next" advances (most send → or Page Down; note which) |
| 3.9 | Your custom prompts | Show up first in The Sprint |
| 3.10 | Last Lash: submit 2 ideas, then vote with 3 votes | Can't vote for your own idea; can't use more than 3 votes |
| 3.11 | Summary | Ranked action items, sprint answers with vote counts, scores |
| 3.12 | *Copy as Markdown* → paste into Confluence, Jira and Slack | Formatting survives (headings, lists) |
| 3.13 | *Download .md* | File downloads and opens correctly |

## 4. Anonymous mode

| # | Step | Expected |
|---|------|----------|
| 4.1 | Turn on Anonymous mode in the lobby, play through at least one Sprint matchup and Last Lash | No authors, voter names or scores anywhere: big screen, phones or summary |
| 4.2 | Check the Markdown export | No names in it |

## 5. Resilience (the most likely place for real-world bugs)

| # | Step | Expected |
|---|------|----------|
| 5.1 | During answering, lock a phone for 30 s, then unlock | Reconnects as the same player, typed answers still there or already submitted |
| 5.2 | Switch a phone to another app for 2 min, then back | Same as 5.1 |
| 5.3 | Reload a phone mid-vote | Rejoins as the same player (same tab) and can still vote |
| 5.4 | Close the tab and rejoin from a new tab | Joins as a **new** player. This is expected behaviour (identity is per tab), but note whether it's confusing |
| 5.5 | Switch a phone from Wi-Fi to mobile data mid-round | Reconnects within a few seconds |
| 5.6 | Reload the big screen mid-round | Resumes the same phase and timer |
| 5.7 | Close the big screen for 1 min, then reopen `/?host=ABCD` | Game kept running on the server; host page resumes |
| 5.8 | Leave the room idle for 15 min in the lobby, then start | Still works |
| 5.9 | Two people tap submit or vote at the same time as the timer runs out | No double counting, no stuck phase |
| 5.10 | Leave a game in the Sprint discussion pause for 10 min with phones connected but idle | Game is still there when you press → (checks that open sockets keep the app from scaling to zero) |

## 6. Big-screen readability

| # | Step | Expected |
|---|------|----------|
| 6.1 | Look at the title and answer cards | Bricolage Grotesque is used (rounded, chunky headings), not a fallback font. Check DevTools → Network for `fonts.gstatic.com` 200s |
| 6.2 | Stand at the back of the room | Prompt, answers, timer and room code are readable |
| 6.3 | Long answers (80 chars) on both sides of a matchup | Fit on the cards without overflow |
| 6.4 | Lobby with 10+ players | Player tiles fit without scrolling |
| 6.5 | Projector or washed-out TV | Contrast is still OK; timer colour is visible |
| 6.6 | QR code from 3 m away | Scans on the first try |

## 7. Scale (optional, bots)

| # | Step | Expected |
|---|------|----------|
| 7.1 | 16 players (real + bots) | All join; the 17th is refused with a clear message |
| 7.2 | Time one round with 10+ players | Note how long voting takes. This decides whether "fewer prompts for big teams" is needed next |

---

## 8. v0.3 features

| # | Step | Expected |
|---|------|----------|
| 8.1 | Lobby: paste the previous retro's Markdown export into *Last retro's action items* | "n found" appears; line-up shows *Did we do it?* after Check-in |
| 8.2 | Check-in on phones | Big screen shows the weather chart; nobody's pick is identifiable |
| 8.3 | Emoji Only: try typing letters | Letters are dropped; only emoji get through |
| 8.4 | Tap 🆘 *Help me* | A ready-made answer is filled in and can still be edited |
| 8.5 | 4 players | Line-up has *The Sprint · part 1* and *part 2* |
| 8.6 | Don't touch the laptop from Start until Last Lash results | Everything advances by itself; Sprint pauses count down from 60 s |
| 8.7 | Press **P** during a Sprint discussion, wait, press **P** again | Timer shows ⏸ and freezes, then continues |
| 8.8 | Someone joins mid-game with *Join as audience* | They can vote right away; their vote shows as 🍿 on the card; they're not on the scoreboard; the vote closes a few seconds after the players are done |
| 8.9 | Tap reactions on phones during results | Emoji float up on the big screen (with avatar unless Anonymous mode) |
| 8.10 | Sound | Speaker button shows 🔊 after the first click; intro sting, whooshes, vote blips, fanfare play; mute works |
| 8.11 | Last Lash results: tap *I'll take it* on a phone | Owner chip appears next to the item on the big screen, and in the Markdown export |
| 8.12 | Reveal timing at the back of the room | Votes landing one by one is readable, not too slow; note if it drags with 10+ voters |

## 9. v0.4 features

| # | Step | Expected |
|---|------|----------|
| 9.1 | Join: pick an avatar and a plate colour | Preview plate updates; lobby tile and phone header show the colour. Avatars other players have are greyed out under *Change your look* |
| 9.2 | Before each matchup | Big "Matchup n/m" slams in, the prompt types out, a fuse burns down, then the cards fly in. Phones show "Next up…" with the prompt |
| 9.3 | Between matchups | The old cards leave with one of five exits (fall, fling, spin, rocket, squash); different matchups use different ones |
| 9.4 | Reveal | Voters' name plates line up under the cards, then fly one by one onto the answer they picked, with the rising blip. Readable from the back with 8+ voters? |
| 9.5 | A clean sweep (everyone votes the same way, at least 2 voters) | Losing card is knocked out, the winner slides to the centre and grows, RETROLASH banner + confetti + crash sound |
| 9.6 | Phones after a reveal | Authors see "You won! 3–1 +600" / "Not this time" / RETROLASH; voters see whether they picked the winner |
| 9.7 | Win 3 matchups in a row; or win from last place | "Hat trick" / "Comeback" sticker on the big screen. After a round where the leader changes: "… takes the lead!" |
| 9.8 | Kudos round | Phones pick a teammate (or the whole team) and write a message. Big screen shows the notes one by one, recipient named, author never shown. Kudos in the summary and the Markdown |
| 9.9 | End of the game | Podium: 3rd, 2nd, then a drumroll and 1st with crown and confetti; moves on to the summary by itself. Skipped in Anonymous mode |
| 9.10 | Mid-game, a latecomer scans the corner QR | Small QR in the header works from a few metres away (or at least the code is readable) |
| 9.11 | 🎵 button | Opens music on/off and volume sliders for music and effects. Loop starts after the first click, ducks under sound effects, gets quieter during Sprint discussions; volumes survive a reload |
| 9.12 | Lobby: click 🎛️ on a player to make them VIP | Their phone gets a remote bar: Start in the lobby, then Next / Hold during the game. Works the same as the laptop keys |
| 9.13 | Close the phone tab mid-game, open the QR link again | Join page offers "Continue as <name>"; tapping it rejoins as the same player with the same score |
| 9.14 | Sprint format: pick Sailboat (or 4Ls etc.) | Intro says "Format: Sailboat ⛵"; Sprint prompts come from that pack |
| 9.15 | Language: Svenska | Big screen, phones, prompts, round titles and Markdown export are Swedish. Paste a Swedish export into *Last retro's action items*: items are found |

## 10. Spoken prompts (needs the shared Speech resource)

| # | Step | Expected |
|---|------|----------|
| 10.1 | Lobby | *🗣️ Read prompts aloud* toggle is visible and on |
| 10.2 | Round intro and matchup intro | Title and prompt are read aloud after the first click on the page; music ducks under the voice; intro lasts until the voice is done |
| 10.3 | Svenska | Swedish voice, natural pronunciation of the Swedish prompts |
| 10.4 | A custom Sprint prompt | Is read aloud too (it is generated during the answering phase) |
| 10.5 | 🎵 panel → Voice to 0, or toggle off in the lobby | Silent intros, normal timing |
| 10.6 | Second game with the same prompts | Starts speaking without delay (cached) |

## 11. v0.5

| # | Step | Expected |
|---|------|----------|
| 11.1 | Copy the big screen's `/?host=ABCD` URL to another browser or a phone | "This room already has a big screen" with a *Start a new room* button. The original big screen keeps working, also after a reload |
| 11.2 | Let one player run out the answer timer | Their side shows a 🆘 answer; after the vote the card says *Auto-answer · half points*; their phone says the game answered for them |
| 11.3 | Two players end on the same score | Scoreboard and podium show the same place for both; joint winners both get a crown and "And the winners are…" |
| 11.4 | Round intros (English) | The voice says "Round 2. Warm-up!" in a cheerful tone; Swedish uses Sofie's normal voice |
| 11.5 | Podium with speech on | "And the winner is…" during the drumroll, the winner's name as first place appears |
| 11.6 | After the last round | *Best of the retro*: up to three answers fly in one by one, clean sweeps marked RETROLASH, authors shown unless Anonymous mode |
| 11.7 | After a finished game, download `usage.jsonl` (infra README) and run `node scripts/usage.mjs usage.jsonl` | The game is counted; the file has no names or answers |

## 12. v0.6

| # | Step | Expected |
|---|------|----------|
| 12.1 | Join on a phone, lock it for 2+ minutes in the lobby, unlock | The phone shows *reconnecting…* for at most a few seconds, then the same player. The big screen shows no "Name 2" |
| 12.2 | Join, close the tab (or swipe the browser away), scan the QR code again | Back in as the same player straight away, no join form |
| 12.3 | Join in Safari, then open the link in Chrome on the same phone and type the same name | The same player is picked up once the Safari one has dropped (about 20 s); no duplicate |
| 12.4 | In the lobby on a phone, tap *Not you? Join as someone else* | Join form; joining with a new name adds a new player |
| 12.5 | Vote, then tap **🤷 Neither** | *Skipped ✓*; you count as voted; after the reveal the big screen says how many liked neither |
| 12.6 | Play with 8+ people (or `node scripts/bots.mjs ABCD 9`) | Head-to-head rounds have mostly three cards; phones show three answers plus Neither; a clean sweep knocks two cards out and centres the winner |
| 12.7 | Open `/?screen=ABCD` on a second laptop (or next to a Teams call) | Same screens as the main one, with sound after a click; no buttons; keyboard does nothing; reactions float up |
| 12.8 | Main screen with speech on | Welcome line before round 1, "Phones out!" when writing starts, a nudge on the first vote of each round, a reaction to each result as it lands, "Good work" on the scoreboard, a wrap-up line on the summary |
| 12.9 | Switch *Studio* / *Party* in the lobby | Big screen and phones change look together; readable from the back of the room in both |
| 12.10 | Open the game on an older Windows 10 PC and an Android phone | Avatars, moods and reactions show the same colour emoji everywhere (no empty boxes or black-and-white symbols) |

## 13. v0.7

| # | Step | Expected |
|---|------|----------|
| 13.1 | While answering, watch the avatars in the footer | Not answered yet: dimmed circles. Answered: full colour, lifted, with a ✓. No tall ovals |
| 13.2 | Three players; one locks their phone (or switches app) before answering, the other two answer | The round keeps waiting for the third. It moves on only when they answer, the timer runs out, or ~45 s after their phone went quiet |
| 13.3 | Set *Talk time* to *0 s* and play The Sprint | Each result stays about as long as a Warm-up result, then moves on; no "Let's talk" box, music doesn't dip |
| 13.4 | Tap reactions on a phone | They rise from that player's avatar (the "watching" chip for audience); the avatar bumps |
| 13.5 | Open the landing page | Two illustrations (big screen, phone), no emoji in the card titles |
| 13.7 | Speech on, Warm-up or Sprint vote | After the prompt, the voice reads each answer as the cards land (all of them, or none if a clip wasn't ready). Not in Emoji Only |
| 13.8 | Three tabs as three players; answer in two, wait 20 s, switch to the third | The round still waits for the third |
| 13.9 | On a phone in the lobby, tap *Leave the game* | Asks first; the player disappears from the lobby and the big screens show "👋 Name left the game"; the phone is back at the join form. Not offered mid-game |
| 13.10 | Music through a whole game | Coffee Shop / Golden Hour in the lobby (taking turns), Desk Lamp while writing, Night Bus during matchups, a quiet pad while talking, Golden Hour for highlights/podium/summary. Changes land on a beat; nothing stutters |
| 13.6 | Lobby settings | Labelled rows (Rounds, Sprint format, Language + Look, Options); *More settings* opens an even three-column grid |

## Known gaps to check while testing

- A phone that rejoins from a *different browser* with the same name can only take over once the old connection is gone (up to ~20 s after the phone slept). Until then it gets "Name 2"; remove the stale one in the lobby.

## Data note

Retro answers can include real project or client details, and room state is stored with the hosting provider. Check with the relevant Valtech owner before running real client retros on a third-party host. If it needs to stay in a Valtech-controlled tenant, the game server can be moved to Azure later.

## Issue log

| # | Step | Device / browser | What happened | Severity (blocker / annoying / cosmetic) |
|---|------|------------------|---------------|------------------------------------------|
| 1 |      |                  |               |                                          |
