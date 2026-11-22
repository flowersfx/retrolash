// End-to-end check: starts the built server with fast timers, fills a room with
// 4 bot players + 1 audience bot, and plays a whole game. A scripted VIP phone
// (audience) presses "next" where the game waits for one (Last Lash results),
// so this also checks the VIP remote and that everything else advances by itself.
// The game runs in Swedish with the Sailboat pack, so translations and packs are exercised.
// Speech runs against a fake backend (TTS_FAKE=1): intros must carry clips the server serves.
//
// With 8+ players (`node scripts/e2e.mjs en 9`) the head-to-head rounds are three-way matchups.
// An extra big screen (helloScreen) watches the whole game.
//
//   npm run build && node scripts/e2e.mjs [en|sv] [players]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LANG = process.argv[2] ?? "sv";
const PLAYERS = Number(process.argv[3] ?? 4);
const PORT = 2990 + Math.floor(Math.random() * 9);
const CODE = "ZQXE";
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "retrolash-e2e-"));
let hostToken = null;
const fail = (msg) => {
  console.error(`E2E FAIL: ${msg}`);
  process.exit(1);
};

const server = spawn(process.execPath, ["dist-server/main.js"], {
  env: { ...process.env, PORT: String(PORT), TIME_SCALE: "0.1", TTS_FAKE: "1", DATA_DIR },
  stdio: ["ignore", "ignore", "inherit"],
});
const bots = () =>
  spawn(process.execPath, ["scripts/bots.mjs", CODE, String(PLAYERS), `localhost:${PORT}`, "1"], { stdio: "ignore" });
let botProc;
const cleanup = () => {
  botProc?.kill();
  server.kill();
};
process.on("exit", cleanup);

await new Promise((r) => setTimeout(r, 800));

const url = (id) => `ws://localhost:${PORT}/parties/main/${CODE.toLowerCase()}?_pk=${id}`;
const phases = [];
let started = false;
let vipPresses = 0;
const t0 = Date.now();

// Before any big screen: a phone (or extra screen) can't conjure up a game for an unknown code.
const refused = (code, hello) =>
  new Promise((resolve) => {
    const s = new WebSocket(`ws://localhost:${PORT}/parties/main/${code}?_pk=nobody`);
    let reply = null;
    s.onopen = () => s.send(JSON.stringify(hello));
    s.onmessage = (ev) => (reply = JSON.parse(ev.data).t);
    s.onclose = (ev) => resolve(`${reply}/${ev.code}`);
  });
for (const hello of [{ t: "helloPlayer", name: "Early" }, { t: "helloScreen" }]) {
  const r = await refused(CODE.toLowerCase(), hello);
  if (r !== "error/4404") fail(`${hello.t} to an unknown room should be refused, got ${r}`);
}

let vip, vipSend, screen;
const tv = { views: 0, reactions: 0, phases: new Set() };
let vipView = null;
/** Once the big screen has made the room: the VIP phone and the extra screen join. */
function joinOthers() {
  // The VIP phone: joins as audience, gets VIP from the host, presses next at lashResult.
  vip = new WebSocket(url("vip-phone"));
  vipSend = (m) => vip.send(JSON.stringify(m));
  vip.onopen = () => vipSend({ t: "helloPlayer", name: "VIP", audience: true });
  vip.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t !== "view") return;
    vipView = msg.view;
    if (vipView.phase === "lashResult" && vipView.vipControls && vipPresses === 0) {
      vipPresses++;
      // Give the bots a moment to volunteer as owners.
      setTimeout(() => vipSend({ t: "next" }), 2500);
    }
  };

  // An extra big screen in "another room": sees the show and the reactions, controls nothing.
  screen = new WebSocket(url("extra-screen"));
  screen.onopen = () => screen.send(JSON.stringify({ t: "helloScreen" }));
  screen.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === "reaction") tv.reactions++;
    if (msg.t === "view") {
      tv.views++;
      tv.phases.add(msg.view.phase);
    }
  };
}

const ws = new WebSocket(url("host"));
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => {
  send({ t: "helloHost" });
  send({
    t: "settings",
    settings: {
      lang: LANG,
      pack: "sailboat",
      // Answer and vote time stay at the default: no limit, phases end when everyone is done.
      discussionSeconds: 15,
      previousItems: ["Fix the flaky tests", "Shorter standups"],
    },
  });
};
let last = "";
let lashTitle = "";
const spokenPhases = new Set();
let clipUrl = null;
let maxSides = 0;
let answersRead = 0;
let versusMissing = 0;
let kudosRead = 0;
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.t === "hostToken") {
    hostToken = msg.token;
    joinOthers();
    botProc = bots();
  }
  if (msg.t !== "view") return;
  const v = msg.view;
  const key = `${v.phase}|${v.roundTitle ?? ""}|${v.matchupNumber ?? ""}`;
  if (key !== last) {
    last = key;
    phases.push(v.phase);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${v.phase.padEnd(13)} ${v.roundTitle ?? ""} ${v.matchupNumber ? `#${v.matchupNumber}` : ""}`);
  }
  if (v.phase === "lobby" && !started) {
    const players = v.players.filter((p) => !p.audience && p.connected).length;
    const audience = v.players.filter((p) => p.audience && p.connected);
    const vipPlayer = audience.find((p) => p.name === "VIP");
    if (vipPlayer && !vipPlayer.vip) send({ t: "vip", playerId: vipPlayer.id, on: true });
    if (players === PLAYERS && audience.length === 2 && vipPlayer?.vip) {
      started = true;
      console.log("plan:", v.plan.map((r) => r.title).join(" → "));
      // The VIP starts the game from their phone.
      vipSend({ t: "start" });
    }
  }
  if (v.say?.length) {
    spokenPhases.add(v.phase);
    clipUrl ??= v.say[0].url;
  }
  if (v.matchup) maxSides = Math.max(maxSides, v.matchup.answers.length);
  // Answers read aloud while voting: one clip per answer (plus maybe the "time to vote" nudge).
  if (v.phase === "pollResult" && v.kudos && v.kudosAt) kudosRead = Math.max(kudosRead, (v.say ?? []).filter((c) => c.at !== undefined).length);
  if (v.phase === "voting" && v.roundKind !== "emoji" && (v.say?.length ?? 0) >= v.matchup.answers.length) {
    answersRead++;
    // One card at a time: each lands as its answer is read, with "versus" between them.
    const at = v.matchup.answerAt;
    if (!at || at.length !== v.matchup.answers.length || at.some((x, i) => i > 0 && x <= at[i - 1] + 700))
      fail(`read answers need staggered card times: ${JSON.stringify(at)}`);
    if (v.say.length < 2 * v.matchup.answers.length - 1) versusMissing++;
  }
  if (v.phase === "lashResult") lashTitle = v.roundTitle;
  if (v.phase === "summary") void check(v);
};

async function check(v) {
  if (!started) fail("game never started (VIP start didn't work?)");
  if (vipPresses !== 1) fail(`expected the VIP to press next once, got ${vipPresses}`);
  for (const p of ["matchupIntro", "highlights", "podium"]) if (!phases.includes(p)) fail(`never saw phase ${p}`);
  const kinds = v.summary.map((r) => r.kind);
  const sprints = kinds.filter((k) => k === "retro").length;
  if (sprints < 2) fail(`expected >= 2 Sprint rounds, got ${sprints}`);
  for (const k of ["checkin", "followup", "warmup", "emoji", "kudos", "lastlash"])
    if (!kinds.includes(k)) fail(`missing round ${k}`);
  if (LANG === "sv" && !v.summary.some((r) => r.title.startsWith("Sprinten · del"))) fail("Swedish round titles missing");
  if (LANG === "sv" && !lashTitle.includes("Åtgärder")) fail(`Swedish Last Lash title missing: ${lashTitle}`);
  const mood = v.summary.find((r) => r.kind === "checkin").moodCounts;
  if (mood.reduce((a, b) => a + b, 0) !== PLAYERS) fail(`expected ${PLAYERS} moods (audience excluded), got ${mood}`);
  const fu = v.summary.find((r) => r.kind === "followup").followupItems;
  if (fu.length !== 2 || fu.some((f) => f.counts.reduce((a, b) => a + b, 0) !== PLAYERS)) fail(`follow-up tallies wrong: ${JSON.stringify(fu)}`);
  const kudos = v.summary.find((r) => r.kind === "kudos").kudos;
  if (kudos.length !== PLAYERS) fail(`expected ${PLAYERS} kudos, got ${kudos.length}`);
  const expectSides = PLAYERS >= 8 ? 3 : 2;
  if (maxSides !== expectSides) fail(`expected matchups of up to ${expectSides} answers, saw ${maxSides}`);
  const sprintMatchups = v.summary.filter((r) => r.kind === "retro").flatMap((r) => r.matchups);
  if (PLAYERS >= 8 && !sprintMatchups.some((m) => m.answers.length === 3 && m.voters?.length === 3)) fail("no three-way Sprint matchup in the summary");
  const emoji = v.summary.find((r) => r.kind === "emoji").matchups;
  if (emoji.some((m) => m.answers.some((a) => /[a-z]/i.test(a)))) fail("emoji round contains letters");
  const all = v.summary.flatMap((r) => r.matchups);
  if (!all.some((m) => m.voterNames?.some((names) => names.some((n) => n.startsWith("PO "))))) fail("audience votes were not counted");
  if (!all.every((m) => m.voters && m.authorPlates)) fail("matchups are missing voter/author plates");
  const lash = v.summary.find((r) => r.kind === "lastlash").lashAnswers;
  const owners = lash.flatMap((a) => a.owners ?? []);
  console.log(`owners: ${owners.map((o) => o.name).join(", ") || "(none volunteered)"}`);
  if (v.players.some((p) => p.audience && p.score !== 0)) fail("audience scored points");
  if (v.players.some((p) => !p.color)) fail("a player has no plate colour");
  // Prompts and round titles, plus the host's stock lines between them.
  for (const p of ["roundIntro", "matchupIntro", "answering", "matchupResult", "summary"])
    if (!spokenPhases.has(p)) fail(`no spoken clip during ${p}`);
  const base = `http://localhost:${PORT}`;
  const clip = await fetch(base + clipUrl);
  if (clip.status !== 200 || clip.headers.get("content-type") !== "audio/mpeg") fail(`clip ${clipUrl} not served: ${clip.status}`);
  for (const bad of ["/tts/lib/" + "0".repeat(32) + ".mp3", "/tts/../package.json", "/tts/room/x.mp3"]) {
    const r = await fetch(base + bad);
    if (r.status !== 404) fail(`${bad} should be 404, got ${r.status}`);
  }
  console.log(`speech: clips on ${[...spokenPhases].join(", ")}; answers read aloud in ${answersRead} votes`);
  if (answersRead === 0) fail("answers were never read aloud");
  if (versusMissing > answersRead / 2) fail(`"versus" missing between read answers in ${versusMissing} of ${answersRead} votes`);
  if (kudosRead !== PLAYERS) fail(`expected all ${PLAYERS} kudos read aloud, got ${kudosRead}`);

  // Player ids are public (every view has them) and must not work as a login.
  const victim = v.players.find((p) => !p.audience);
  const impostor = await new Promise((resolve) => {
    const s = new WebSocket(url(victim.id));
    s.onopen = () => s.send(JSON.stringify({ t: "helloPlayer", name: "" }));
    s.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      resolve(m.t === "view" ? `view as ${m.view.you?.name}` : m.t);
      s.close();
    };
  });
  if (impostor !== "error") fail(`connecting with ${victim.name}'s public id should not log in as them, got ${impostor}`);

  // Only the first big screen (or one with its token) may host.
  const hostHello = (token) =>
    new Promise((resolve) => {
      const s = new WebSocket(url(`second-screen-${token ? "ok" : "no"}`));
      s.onopen = () => s.send(JSON.stringify(token ? { t: "helloHost", token } : { t: "helloHost" }));
      s.onmessage = (ev) => {
        resolve(JSON.parse(ev.data).t);
        s.close();
      };
    });
  if (!hostToken) fail("the big screen never got a host token");
  if ((await hostHello(null)) !== "error") fail("a second big screen without the token was let in");
  if ((await hostHello(hostToken)) !== "view") fail("the big screen's token was refused");

  // Usage numbers: one finished game with 4 players, and no names in the file.
  await new Promise((r) => setTimeout(r, 300));
  const usage = readFileSync(path.join(DATA_DIR, "usage.jsonl"), "utf8");
  const games = usage.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "game");
  if (games.length !== 1 || games[0].players !== PLAYERS) fail(`usage file wrong: ${usage}`);
  const g = games[0];
  if (g.bots < PLAYERS || g.active !== PLAYERS || !g.game || g.screens !== 1 || !g.vip) fail(`usage fields wrong: ${JSON.stringify(g)}`);
  const stats = await (await fetch(`${base}/api/stats`)).json();
  if (stats.games !== 0 || stats.tests < 2) fail(`/api/stats should leave the bot game out: ${JSON.stringify(stats)}`);
  const meter = stats.meter;
  if (!(meter?.speech.clips > 0 && meter.speech.chars > meter.speech.clips && meter.runtime.starts === 1 && meter.speech.free === 500000)) fail(`/api/stats meter wrong: ${JSON.stringify(meter)}`);
  console.log(`meter: ${JSON.stringify(meter)}`);
  if (!tv.phases.has("summary") || !tv.phases.has("matchupResult")) fail(`the extra screen missed screens: ${[...tv.phases]}`);
  if (tv.reactions === 0) fail("the extra screen got no reactions");
  console.log(`extra screen: ${tv.views} views, ${tv.reactions} reactions`);
  if (/Ada|Linus|Grace|PO 1/.test(usage)) fail("usage file contains names");
  console.log(`usage: ${JSON.stringify(games[0])}`);
  console.log(`\nE2E OK (${LANG}, ${PLAYERS} players, up to ${maxSides} answers per matchup) in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${phases.length} screens, ${vipPresses} VIP press, ${sprints} Sprint rounds, ${kudos.length} kudos`);
  process.exit(0);
}

setTimeout(() => fail(`timeout. Last screens: ${phases.slice(-5).join(" / ")}`), 240_000);
