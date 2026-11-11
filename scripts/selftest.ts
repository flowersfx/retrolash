// Quick checks for the pure helpers in shared/. Run: npx tsx scripts/selftest.ts
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PACKS, emojiOnly, parsePreviousItems, places, planRounds } from "../shared/types";
import { GameRoom, type Connection, type Room } from "../server/game";
import { prompts, sprintPrompts } from "../shared/prompts";
import { titledPlan } from "../shared/i18n";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AzureSpeech } from "../server/tts";

const md = `# Retro 2026-11-09

## Action items

_One concrete thing we should change next sprint_

- [ ] Pair on flaky tests (3 votes) — owner: Ann, Bob (idea: Cleo)
- [ ] No meetings Thursday (2 votes) (idea: Dan)
- [x] Old style item (1 votes) — Eve

## Sprint weather

☀️ Sunny: 1`;

assert.deepEqual(parsePreviousItems(md), ["Pair on flaky tests", "No meetings Thursday", "Old style item"]);
assert.deepEqual(parsePreviousItems("Fix CI\n1. Write docs\n* Talk to PO\n\n"), ["Fix CI", "Write docs", "Talk to PO"]);

assert.equal(emojiOnly("hi 🔥🐶 x ☕"), "🔥🐶 ☕");
assert.equal(emojiOnly("👍🏽🇸🇪👨‍👩‍👧"), "👍🏽🇸🇪👨‍👩‍👧");
assert.equal(emojiOnly("just words"), "");

assert.deepEqual(planRounds(DEFAULT_SETTINGS, 3), ["checkin", "warmup", "emoji", "retro", "retro", "retro", "kudos", "lastlash"]);
assert.deepEqual(planRounds(DEFAULT_SETTINGS, 4), ["checkin", "warmup", "emoji", "retro", "retro", "kudos", "lastlash"]);
assert.deepEqual(
  planRounds({ ...DEFAULT_SETTINGS, previousItems: ["a"], sprintRounds: 1, rounds: ["retro"] }, 5),
  ["followup", "retro"],
);
// Swedish export reads back too.
const sv = `## Åtgärder

- [ ] Parprogrammera mer (3 röster) — ägare: Ann (idé: Bo)
- [ ] Kortare möten (1 röst)

## Sprintens väder`;
assert.deepEqual(parsePreviousItems(sv), ["Parprogrammera mer", "Kortare möten"]);

// Every pack has enough prompts in both languages, and the lists line up.
for (const lang of ["en", "sv"] as const) {
  for (const pack of PACKS) assert.ok(sprintPrompts(lang, pack).length >= 10, `${lang}/${pack} too small`);
  const p = prompts(lang);
  assert.ok(p.warmup.length >= 20 && p.emoji.length >= 12 && p.safetyQuips.length >= 10);
}
for (const pack of PACKS) assert.equal(sprintPrompts("en", pack).length, sprintPrompts("sv", pack).length);
assert.equal(titledPlan(["retro", "retro"], "sv")[1].title, "Sprinten · del 2");
// Speech cache (fake backend): queue, readiness, duration, and only our own files are served.
const speech = new AzureSpeech({
  dir: mkdtempSync(path.join(tmpdir(), "retrolash-tts-")),
  voices: { en: "en-US-JennyNeural", sv: "sv-SE-SofieNeural" },
  fake: true,
  log: () => {},
});
await speech.init();
const line = { text: "The worst possible commit message", lang: "en" as const, scope: "lib" as const };
assert.equal(speech.get(line), null, "not ready before it is generated");
await new Promise((r) => setTimeout(r, 200));
const clip = speech.get(line)!;
assert.ok(clip && /^\/tts\/lib\/[a-f0-9]{32}\.mp3$/.test(clip.url), "clip url");
assert.ok(Math.abs(clip.ms - line.text.length * 70) < 5, `duration from size: ${clip.ms}`);
assert.equal(speech.id(line), speech.id({ ...line }), "stable ids");
assert.notEqual(speech.id(line), speech.id({ ...line, lang: "sv" }), "voice is part of the id");
assert.ok(speech.file(clip.url), "serves its own clip");
assert.equal(speech.file("/tts/lib/" + "a".repeat(32) + ".mp3"), null, "unknown clip");
assert.equal(speech.file("/tts/lib/../../etc/passwd"), null, "traversal");
// Shared places.
assert.deepEqual(places([3450, 3450, 2000, 2000, 10]), [1, 1, 3, 3, 5]);

// A small in-memory game: host token, auto-answers and their half points.
class FakeConn implements Connection {
  state: unknown = undefined;
  sent: { t: string; [k: string]: unknown }[] = [];
  constructor(readonly id: string) {}
  setState(s: unknown) {
    this.state = s;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
}
const conns: FakeConn[] = [];
const fakeRoom: Room = { id: "unit", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => conns };
const game = new GameRoom(fakeRoom);
await game.onStart();
const connect = (id: string) => {
  const c = new FakeConn(id);
  conns.push(c);
  game.onConnect(c);
  return c;
};
const say = (c: FakeConn, m: object) => game.onMessage(JSON.stringify(m), c);

const host = connect("host-1");
say(host, { t: "helloHost" });
const token = host.sent.find((m) => m.t === "hostToken")?.token as string;
assert.ok(/^[a-f0-9]{48}$/.test(token ?? ""), "first big screen gets a token");
const intruder = connect("host-2");
say(intruder, { t: "helloHost" });
assert.equal(intruder.sent.at(-1)?.t, "error", "a second big screen without the token is refused");
assert.equal(intruder.state, undefined, "and gets no host role");
say(intruder, { t: "helloHost", token: "a".repeat(48) });
assert.equal(intruder.sent.at(-1)?.t, "error", "a wrong token is refused");
const same = connect("host-3");
say(same, { t: "helloHost", token });
assert.equal(same.sent.at(-1)?.t, "view", "the right token gets the host view");
assert.ok(!JSON.stringify(game.hostView()).includes(token), "the token never appears in a view");

const players = ["a", "b", "c"].map((id) => {
  const c = connect(id);
  say(c, { t: "helloPlayer", name: id.toUpperCase() });
  return c;
});
say(host, { t: "settings", settings: { rounds: ["warmup"] } });
say(host, { t: "start" });
assert.equal(game.state.phase, "roundIntro");
game.advance(); // answering
const round = game.state.rounds[0];
for (const m of round.matchups.filter((x) => x.playerIds.includes("a")))
  say(players[0], { t: "answer", matchupId: m.id, text: "A real answer" });
game.advance(); // time's up: fill in, then the first playable matchup
assert.equal(round.matchups.filter((m) => m.auto).length, 2, "both of a's opponents got an auto-answer");
assert.equal(round.matchups.filter((m) => m.answers.every((x) => x === null)).length, 1, "the matchup nobody answered stays empty");
assert.equal(game.state.phase, "matchupIntro");
const m = round.matchups[game.state.matchupIndex];
assert.ok(m.auto && m.answers.every((x) => x !== null), "the played matchup has a real and an auto answer");
game.advance(); // voting
const autoSide = m.auto![0] ? 0 : 1;
const voter = players.find((p) => !m.playerIds.includes(p.id))!;
say(voter, { t: "vote", matchupId: m.id, choice: autoSide });
assert.equal(game.state.phase, "matchupResult", "the only voter closes the vote");
assert.deepEqual(m.points, autoSide === 0 ? [50, 0] : [0, 50], "an auto-answer earns half its vote points and no win bonus");
assert.equal(game.hostView().matchup?.auto?.[autoSide], true, "the big screen sees which side was automatic");
game.dispose();

console.log("selftest OK");
