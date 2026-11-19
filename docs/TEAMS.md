# Running Retrolash with Microsoft Teams

Proposal for distributed and hybrid retros: people working alone from home, and
whole rooms in different places.

## The problem with screen sharing

Sharing the big screen in a Teams meeting is the obvious way, and the worst one
for this game:

- Teams sends screen shares as video tuned for slides and code: low frame rate
  (often 5 to 15 fps), and the quality drops further when the picture changes a
  lot. Flying cards, confetti and count-ups are exactly what it handles worst.
- Sound only travels if the presenter ticks "Include sound", and then it is
  compressed and mixed with everyone's microphones. Music and the voice get
  ducked by people talking.
- Remote people see everything a second or two late. That is enough to break
  the "everyone gasps at once" moments.

So the plan is to **send the game, not a video of it**. Every location runs
the big screen itself in a browser, and Teams only carries the conversation.

## Recommendation

### 1. Now: every location opens its own screen (built in v0.6)

The game now supports any number of extra big screens per room:
`https://retrolash.flowersfx.com/?screen=ABCD`. The host's lobby shows the
link with a copy button.

An extra screen shows exactly what the main screen shows, live, with its own
animations, music and voice, rendered locally at full frame rate. It cannot
start, skip or pause anything; only the main screen (and VIP phones) can.

| Who | Big screen | Answers on |
| --- | --- | --- |
| Facilitator's room | `?host=ABCD` on the room PC or a laptop on HDMI | phones |
| Another office room | `?screen=ABCD` on that room's PC or laptop | phones |
| Someone working alone | `?screen=ABCD` in a browser window next to Teams | phone, or a second browser tab with `?room=ABCD` |

How to run it:

1. Before the meeting, the facilitator opens `?host=ABCD` and pastes the
   `?screen=` link into the meeting chat.
2. Rooms and remote people open the link (fullscreen with F11) and click once
   anywhere, because browsers only allow sound after a click.
3. In Teams, **don't share the screen**, or share it with video off. Keep
   cameras and microphones on for the talking parts: that's what Teams is good
   at.
4. Remote people turn their own game sound down a bit, or use headphones, so
   the game audio doesn't loop back into their microphone. Teams' echo
   cancellation usually copes, but headphones remove the risk.

What this costs: nothing new to install or approve. Every screen is just a
browser tab. Screens drift by at most a few hundred milliseconds, because they
all follow the same server.

Things to know:

- Anyone with the room code can open a screen. That matches how joining works
  today (the code is on the wall anyway). Screens can't change anything.
- A Teams Rooms device (the meeting room's own Teams console) can't open a web
  page by itself. Plug a laptop into the room display, or use the room's
  "share a laptop" HDMI input, as you would for the main screen.

### 2. Next: a Teams meeting app (stage + side panel)

Teams lets a meeting app put a web page on the **meeting stage** for everyone
in the call, and a **side panel** next to it. Each participant's Teams client
renders the page locally, so it is as smooth as a browser tab, with no screen
share involved.

That fits Retrolash almost one to one:

- **Stage** = the extra screen (`?screen=ABCD`), shared to everyone in the call
  with one click.
- **Side panel** = the phone UI (`?room=ABCD`). Remote people play inside Teams
  without picking up a phone; people in a meeting room keep using their phones.

What it takes:

- A Teams app manifest with a configurable tab for the `meetingStage` and
  `meetingSidePanel` contexts, and the Teams JavaScript SDK (`@microsoft/teams-js`)
  on a small page that calls `meeting.shareAppContentToStage` with the screen URL.
- Pages loaded inside Teams must allow being framed by Teams. Today the server
  sends `X-Frame-Options: DENY`, which would need to become a
  `Content-Security-Policy: frame-ancestors` list with the Teams domains, only for
  the screen and phone routes.
- Getting the app into the tenant: either a Teams admin uploads it to the org
  app catalog, or custom app upload ("sideloading") is allowed for the people
  testing it. In most company tenants that means an admin request. The app also
  needs to be approved in each customer tenant if other teams outside the
  company want it.
- Sound on the stage still needs a click in each client (same autoplay rules).

Estimate: one to two days to build and test, plus however long the admin
approval takes. I'd do it once option 1 has been used in a real hybrid retro,
so the side panel is built for what people actually missed.

### Not recommended

- **Screen sharing the main screen** (above): choppy, delayed, sound mixed into
  the call. Fine as a fallback if someone can't open the link.
- **Teams Live Share SDK**: built for keeping app state in sync between
  participants without a server. Retrolash already has an authoritative game
  server, so Live Share would add a second source of truth for no gain.
- **A Teams bot or message extension**: chat cards can't do the animations or
  timing, and the game would lose the big-screen show entirely.

## Mixed setups, end to end

- **One room + some people at home** (most common): the room runs `?host=`,
  home workers open `?screen=` next to Teams and play on their phones. The room
  joins the Teams call as usual for audio and video.
- **Two or more rooms**: the facilitator's room runs `?host=`, every other room
  runs `?screen=`. Make someone in each room a VIP (🎛️ in the lobby) if they
  should be able to pause for discussion.
- **Everyone remote**: the facilitator runs `?host=` on their own machine (it is
  also their screen), everyone else opens `?screen=`. A VIP phone or the
  facilitator's keyboard drives it.
