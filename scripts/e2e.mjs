// End-to-end check: starts the built server with fast timers, fills a room with
// 4 bot players + 1 audience bot, and plays a whole game. A scripted VIP phone
// (audience) presses "next" where the game waits for one (Last Lash results),
// so this also checks the VIP remote and that everything else advances by itself.
// The game runs in Swedish with the Sailboat pack, so translations and packs are exercised.
//
//   npm run build && node scripts/e2e.mjs [en|sv]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LANG = process.argv[2] ?? "sv";
const PORT = 2990 + Math.floor(Math.random() * 9);
const CODE = "ZQXE";
const fail = (msg) => {
  console.error(`E2E FAIL: ${msg}`);
  process.exit(1);
};

const server = spawn(process.execPath, ["dist-server/main.js"], {
  env: { ...process.env, PORT: String(PORT), TIME_SCALE: "0.1", DATA_DIR: mkdtempSync(path.join(tmpdir(), "retrolash-e2e-")) },
  stdio: ["ignore", "ignore", "inherit"],
});
const bots = () =>
  spawn(process.execPath, ["scripts/bots.mjs", CODE, "4", `localhost:${PORT}`, "1"], { stdio: "ignore" });
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

// The VIP phone: joins as audience, gets VIP from the host, presses next at lashResult.
const vip = new WebSocket(url("vip-phone"));
const vipSend = (m) => vip.send(JSON.stringify(m));
let vipView = null;
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

const ws = new WebSocket(url("host"));
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => {
  send({ t: "helloHost" });
  send({
    t: "settings",
    settings: {
      lang: LANG,
      pack: "sailboat",
      answerSeconds: 20,
      voteSeconds: 10,
      discussionSeconds: 15,
      previousItems: ["Fix the flaky tests", "Shorter standups"],
    },
  });
  botProc = bots();
};
let last = "";
let lashTitle = "";
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
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
    if (players === 4 && audience.length === 2 && vipPlayer?.vip) {
      started = true;
      console.log("plan:", v.plan.map((r) => r.title).join(" → "));
      // The VIP starts the game from their phone.
      vipSend({ t: "start" });
    }
  }
  if (v.phase === "lashResult") lashTitle = v.roundTitle;
  if (v.phase === "summary") check(v);
};

function check(v) {
  if (!started) fail("game never started (VIP start didn't work?)");
  if (vipPresses !== 1) fail(`expected the VIP to press next once, got ${vipPresses}`);
  for (const p of ["matchupIntro", "podium"]) if (!phases.includes(p)) fail(`never saw phase ${p}`);
  const kinds = v.summary.map((r) => r.kind);
  const sprints = kinds.filter((k) => k === "retro").length;
  if (sprints < 2) fail(`expected >= 2 Sprint rounds, got ${sprints}`);
  for (const k of ["checkin", "followup", "warmup", "emoji", "kudos", "lastlash"])
    if (!kinds.includes(k)) fail(`missing round ${k}`);
  if (LANG === "sv" && !v.summary.some((r) => r.title.startsWith("Sprinten · del"))) fail("Swedish round titles missing");
  if (LANG === "sv" && !lashTitle.includes("Åtgärder")) fail(`Swedish Last Lash title missing: ${lashTitle}`);
  const mood = v.summary.find((r) => r.kind === "checkin").moodCounts;
  if (mood.reduce((a, b) => a + b, 0) !== 4) fail(`expected 4 moods (audience excluded), got ${mood}`);
  const fu = v.summary.find((r) => r.kind === "followup").followupItems;
  if (fu.length !== 2 || fu.some((f) => f.counts.reduce((a, b) => a + b, 0) !== 4)) fail(`follow-up tallies wrong: ${JSON.stringify(fu)}`);
  const kudos = v.summary.find((r) => r.kind === "kudos").kudos;
  if (kudos.length !== 4) fail(`expected 4 kudos, got ${kudos.length}`);
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
  console.log(`\nE2E OK (${LANG}) in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${phases.length} screens, ${vipPresses} VIP press, ${sprints} Sprint rounds, ${kudos.length} kudos`);
  process.exit(0);
}

setTimeout(() => fail(`timeout. Last screens: ${phases.slice(-5).join(" / ")}`), 240_000);
