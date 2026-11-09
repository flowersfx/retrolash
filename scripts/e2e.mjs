// End-to-end check: starts the built server with fast timers, fills a room with
// 4 bot players + 1 audience bot, and plays a whole game. The scripted
// facilitator only presses "next" where the game waits for one (Last Lash
// results), so this also checks that everything else advances by itself.
//
//   npm run build && node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

const phases = [];
let started = false;
const t0 = Date.now();
const ws = new WebSocket(`ws://localhost:${PORT}/parties/main/${CODE.toLowerCase()}?_pk=host`);
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => {
  send({ t: "helloHost" });
  send({
    t: "settings",
    settings: {
      answerSeconds: 20,
      voteSeconds: 10,
      discussionSeconds: 15,
      previousItems: ["Fix the flaky tests", "Shorter standups"],
    },
  });
  botProc = bots();
};
let last = "";
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.t !== "view") return;
  const v = msg.view;
  const key = `${v.phase}|${v.roundTitle ?? ""}|${v.matchupNumber ?? ""}`;
  if (key !== last) {
    last = key;
    phases.push(key);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${v.phase.padEnd(13)} ${v.roundTitle ?? ""} ${v.matchupNumber ? `#${v.matchupNumber}` : ""}`);
  }
  if (v.phase === "lobby" && !started) {
    const players = v.players.filter((p) => !p.audience && p.connected).length;
    const audience = v.players.filter((p) => p.audience && p.connected).length;
    if (players === 4 && audience === 1) {
      started = true;
      console.log("plan:", v.plan.map((r) => r.title).join(" → "));
      send({ t: "start" });
    }
  }
  // Only the final part waits for the facilitator. Give bots time to volunteer.
  if (v.phase === "lashResult" && !phases.includes("pressed-lash")) {
    phases.push("pressed-lash");
    setTimeout(() => send({ t: "next" }), 2500);
  }
  if (v.phase === "summary") check(v);
};

function check(v) {
  const kinds = v.summary.map((r) => r.kind);
  const sprints = kinds.filter((k) => k === "retro").length;
  if (sprints < 2) fail(`expected >= 2 Sprint rounds, got ${sprints}`);
  for (const k of ["checkin", "followup", "warmup", "emoji", "lastlash"])
    if (!kinds.includes(k)) fail(`missing round ${k}`);
  const mood = v.summary.find((r) => r.kind === "checkin").moodCounts;
  if (mood.reduce((a, b) => a + b, 0) !== 4) fail(`expected 4 moods (audience excluded), got ${mood}`);
  const fu = v.summary.find((r) => r.kind === "followup").followupItems;
  if (fu.length !== 2 || fu.some((f) => f.counts.reduce((a, b) => a + b, 0) !== 4)) fail(`follow-up tallies wrong: ${JSON.stringify(fu)}`);
  const emoji = v.summary.find((r) => r.kind === "emoji").matchups;
  if (emoji.some((m) => m.answers.some((a) => /[a-z]/i.test(a)))) fail("emoji round contains letters");
  const audienceVoted = v.summary
    .flatMap((r) => r.matchups)
    .some((m) => m.voterNames?.some((names) => names.some((n) => n.startsWith("PO "))));
  if (!audienceVoted) fail("audience votes were not counted");
  const lash = v.summary.find((r) => r.kind === "lastlash").lashAnswers;
  const owners = lash.flatMap((a) => a.owners ?? []);
  console.log(`owners: ${owners.map((o) => o.name).join(", ") || "(none volunteered)"}`);
  if (v.players.some((p) => p.audience && p.score !== 0)) fail("audience scored points");
  const presses = phases.filter((p) => p === "pressed-lash").length;
  console.log(`\nE2E OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${phases.length - presses} screens, ${presses} facilitator press(es), ${sprints} Sprint rounds`);
  process.exit(0);
}

setTimeout(() => fail(`timeout. Last screens: ${phases.slice(-5).join(" / ")}`), 180_000);
