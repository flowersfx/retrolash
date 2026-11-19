// Quick checks for the pure helpers in shared/. Run: npx tsx scripts/selftest.ts
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PACKS, emojiOnly, parsePreviousItems, places, planRounds, promptsEach } from "../shared/types";
import { GameRoom, groupPlayers, type Connection, type Room } from "../server/game";
import { prompts, sprintPrompts } from "../shared/prompts";
import { titledPlan } from "../shared/i18n";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AzureSpeech } from "../server/tts";
import { Meter, summarizeMeter } from "../server/meter";
import { FileStorage } from "../server/storage";
import { parseUsage, summarize } from "../server/usage";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
// Player ids are public and server-made; the device id is the phone's secret.
const aId = game.pidOf(players[0])!;
assert.ok(aId && aId !== "a", "player ids are not device ids");
const impostor = connect(aId);
say(impostor, { t: "helloPlayer", name: "" });
assert.equal(impostor.sent.at(-1)?.t, "error", "a public player id is not a login");
assert.equal(game.pidOf(impostor), null, "and gets no player");
say(host, { t: "settings", settings: { rounds: ["warmup"] } });
say(host, { t: "start" });
assert.equal(game.state.phase, "roundIntro");
game.advance(); // answering
const round = game.state.rounds[0];
for (const m of round.matchups.filter((x) => x.playerIds.includes(aId)))
  say(players[0], { t: "answer", matchupId: m.id, text: "A real answer" });
game.advance(); // time's up: fill in, then the first playable matchup
assert.equal(round.matchups.filter((m) => m.auto).length, 2, "both of a's opponents got an auto-answer");
assert.equal(round.matchups.filter((m) => m.answers.every((x) => x === null)).length, 1, "the matchup nobody answered stays empty");
assert.equal(game.state.phase, "matchupIntro");
const m = round.matchups[game.state.matchupIndex];
assert.ok(m.auto && m.answers.every((x) => x !== null), "the played matchup has a real and an auto answer");
game.advance(); // voting
const autoSide = m.auto![0] ? 0 : 1;
const voter = players.find((p) => !m.playerIds.includes(game.pidOf(p)!))!;
say(voter, { t: "vote", matchupId: m.id, choice: autoSide });
assert.equal(game.state.phase, "matchupResult", "the only voter closes the vote");
assert.deepEqual(m.points, autoSide === 0 ? [50, 0] : [0, 50], "an auto-answer earns half its vote points and no win bonus");
assert.equal(game.hostView().matchup?.auto?.[autoSide], true, "the big screen sees which side was automatic");
game.dispose();

// Grouping: everyone gets exactly two prompts, nobody meets themselves, trios kick in for big teams.
for (const n of [3, 4, 7, 8, 9, 10, 11, 16]) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  for (const trios of [false, true]) {
    const groups = groupPlayers(ids, trios);
    const seen = new Map<string, number>();
    for (const g of groups) {
      assert.equal(new Set(g).size, g.length, `n=${n}: someone is in a group twice`);
      g.forEach((id) => seen.set(id, (seen.get(id) ?? 0) + 1));
    }
    assert.ok(ids.every((id) => seen.get(id) === 2), `n=${n} trios=${trios}: not two prompts each`);
    if (!trios) assert.ok(groups.every((g) => g.length === 2) && groups.length === n);
    else assert.ok(groups.filter((g) => g.length === 3).length >= Math.floor((2 * n - 4) / 3), `n=${n}: too few trios`);
  }
}

// A 9-player game: three-way matchups, "neither" votes, extra screens and rejoining by name.
{
  const conns2: FakeConn[] = [];
  const room2: Room = { id: "trio", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => conns2 };
  const g = new GameRoom(room2);
  await g.onStart();
  const join = (id: string) => {
    const c = new FakeConn(id);
    conns2.push(c);
    g.onConnect(c);
    return c;
  };
  const tell = (c: FakeConn, m: object) => g.onMessage(JSON.stringify(m), c);
  const host2 = join("h");
  tell(host2, { t: "helloHost" });
  const screen = join("tv");
  tell(screen, { t: "helloScreen" });
  assert.equal(screen.sent.at(-1)?.t, "view", "an extra screen gets the big-screen view");
  const ps = Array.from({ length: 9 }, (_, i) => {
    const c = join(`d${i}`);
    tell(c, { t: "helloPlayer", name: `P${i}` });
    return c;
  });
  // A phone sleeps, its tab is gone; the same name on a new device id picks the player up again.
  const gone = ps[8];
  const p8 = g.pidOf(gone)!;
  conns2.splice(conns2.indexOf(gone), 1);
  g.onClose(gone);
  assert.equal(g.player(p8)?.connected, false);
  const back = join("d8-new-tab");
  tell(back, { t: "helloPlayer", name: "p8" });
  assert.equal(g.state.players.filter((p) => !p.audience).length, 9, "no duplicate player on rejoin");
  assert.equal(g.player(p8)?.connected, true, "the old player is connected again");
  assert.equal(g.state.aliases["d8-new-tab"], p8);
  ps[8] = back;
  // A connected name is not taken over: that's a second person with the same name.
  const twin = join("twin");
  tell(twin, { t: "helloPlayer", name: "P1" });
  assert.ok(g.state.players.some((p) => p.name === "P1 2"), "a connected player keeps their name");
  tell(host2, { t: "kick", playerId: g.pidOf(twin)! });

  tell(screen, { t: "start" });
  assert.equal(g.state.phase, "lobby", "an extra screen cannot start the game");
  tell(host2, { t: "settings", settings: { rounds: ["warmup"] } });
  tell(host2, { t: "start" });
  g.advance(); // answering
  const r = g.state.rounds[0];
  assert.equal(r.matchups.length, 6, "9 players in trios: 6 matchups instead of 9");
  assert.ok(r.matchups.every((m) => m.playerIds.length === 3));
  for (const m of r.matchups)
    m.playerIds.forEach((pid, i) => tell(ps.find((c) => g.pidOf(c) === pid)!, { t: "answer", matchupId: m.id, text: `answer ${pid} ${i}` }));
  assert.equal(g.state.phase, "matchupIntro", "all answers in: on to the first matchup");
  g.advance(); // voting
  const m = r.matchups[g.state.matchupIndex];
  const voters = ps.filter((c) => !m.playerIds.includes(g.pidOf(c)!));
  assert.equal(voters.length, 6);
  tell(voters[0], { t: "vote", matchupId: m.id, choice: 2 });
  tell(voters[1], { t: "vote", matchupId: m.id, choice: 2 });
  tell(voters[2], { t: "vote", matchupId: m.id, choice: 0 });
  tell(voters[3], { t: "vote", matchupId: m.id, choice: 0 });
  tell(voters[3], { t: "vote", matchupId: m.id, choice: null }); // changed their mind: neither
  tell(voters[4], { t: "vote", matchupId: m.id, choice: 7 }); // invalid: ignored
  assert.equal(g.state.phase, "voting");
  const pv = g.playerView(g.pidOf(voters[3])!);
  assert.equal(pv.vote?.skipped, true);
  assert.equal(pv.vote?.myChoice, null);
  assert.equal(pv.vote?.answers.length, 3, "phones get all three answers");
  tell(voters[4], { t: "vote", matchupId: m.id, choice: null });
  tell(voters[5], { t: "vote", matchupId: m.id, choice: 1 });
  assert.equal(g.state.phase, "matchupResult", "a skip counts as voted");
  assert.deepEqual(m.points, [100, 100, 300], "2 votes + win bonus for side 2, 1 vote each for the others");
  const view = g.hostView().matchup!;
  assert.deepEqual(view.votes, [1, 1, 2]);
  assert.equal(view.skips, 2);
  assert.equal(view.authorPlates?.length, 3);
  const loser = g.playerView(m.playerIds[0]).myResult;
  assert.ok(loser?.kind === "author" && loser.won === false && loser.votes.join() === "1,2,1", "my votes first, then the others");
  assert.equal(screen.sent.at(-1)?.t, "view", "the extra screen follows along");
  g.dispose();
}

// A phone that blinks offline mid-answer is still waited for (grace period), then the round goes on.
{
  const cs: FakeConn[] = [];
  const g = new GameRoom({ id: "grce", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => cs }, 0.002);
  await g.onStart();
  const join = (id: string) => {
    const c = new FakeConn(id);
    cs.push(c);
    g.onMessage(JSON.stringify(id === "h" ? { t: "helloHost" } : { t: "helloPlayer", name: id }), c);
    return c;
  };
  const h = join("h");
  const [a, b, c] = ["a", "b", "c"].map(join);
  g.onMessage(JSON.stringify({ t: "settings", settings: { rounds: ["warmup"] } }), h);
  g.onMessage(JSON.stringify({ t: "start" }), h);
  g.advance(); // answering
  const r = g.state.rounds[0];
  // c's phone drops (screen off) before answering; a and b answer everything.
  const cId = g.pidOf(c)!;
  cs.splice(cs.indexOf(c), 1);
  g.onClose(c);
  for (const [conn, id] of [[a, g.pidOf(a)!], [b, g.pidOf(b)!]] as const)
    for (const m of r.matchups.filter((x) => x.playerIds.includes(id)))
      g.onMessage(JSON.stringify({ t: "answer", matchupId: m.id, text: `from ${id}` }), conn);
  assert.equal(g.state.phase, "answering", "a player who just dropped is still waited for");
  assert.ok(g.hostView().expectedIds.includes(cId));
  await new Promise((res) => setTimeout(res, 150)); // grace is 45 s × 0.002 = 90 ms
  assert.notEqual(g.state.phase, "answering", "after the grace period the round goes on without them");
  g.dispose();
}

// Leaving from the phone: lobby only; the player is gone and the big screens are told.
{
  const cs: FakeConn[] = [];
  const g = new GameRoom({ id: "lv", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => cs });
  await g.onStart();
  const join = (id: string, hello: object) => {
    const c = new FakeConn(id);
    cs.push(c);
    g.onMessage(JSON.stringify(hello), c);
    return c;
  };
  const h = join("h", { t: "helloHost" });
  const tv = join("tv", { t: "helloScreen" });
  const ps = ["A", "B", "C", "D"].map((n) => join(n, { t: "helloPlayer", name: n }));
  const [aId, dId] = [g.pidOf(ps[0])!, g.pidOf(ps[3])!];
  g.onMessage(JSON.stringify({ t: "leave" }), ps[3]);
  assert.equal(g.player(dId), undefined, "D left");
  assert.ok(h.sent.some((m) => m.t === "left" && m.name === "D") && tv.sent.some((m) => m.t === "left"), "big screens are told");
  // Two tabs on one identity (a second tab picked up the last one): leaving in one
  // must send the other back to the join form, not leave it on a stale lobby.
  const e1 = join("E", { t: "helloPlayer", name: "E" });
  const e2 = join("E", { t: "helloPlayer", name: "E" });
  assert.equal(g.pidOf(e1), g.pidOf(e2), "same device id, same player");
  g.onMessage(JSON.stringify({ t: "leave" }), e2);
  assert.equal(e1.sent.at(-1)?.t, "error", "the other tab on that player is told it's gone");
  assert.notEqual(e2.sent.at(-1)?.t, "error", "the tab that left just goes back to the form");
  cs.splice(cs.indexOf(e1), 1);
  cs.splice(cs.indexOf(e2), 1);
  g.onMessage(JSON.stringify({ t: "settings", settings: { rounds: ["warmup"] } }), h);
  g.onMessage(JSON.stringify({ t: "start" }), h);
  g.onMessage(JSON.stringify({ t: "leave" }), ps[0]);
  assert.ok(g.player(aId), "can't leave mid-game");
  g.dispose();
}

// Answers read aloud: quick voters don't cut the reading short. Every clip is 2 s here.
{
  const stub = {
    enabled: true,
    prefetch() {},
    get: (l: { text: string }) => ({ id: "room/x", url: "/tts/room/x.mp3", ms: 2000, text: l.text }),
  };
  const cs: FakeConn[] = [];
  const g = new GameRoom({ id: "rd", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => cs }, 0.01, stub);
  await g.onStart();
  const join = (id: string, hello: object) => {
    const c = new FakeConn(id);
    cs.push(c);
    g.onMessage(JSON.stringify(hello), c);
    return c;
  };
  const h = join("h", { t: "helloHost" });
  const ps = ["Ann", "Bo", "Cy"].map((n) => join(n, { t: "helloPlayer", name: n }));
  g.onMessage(JSON.stringify({ t: "settings", settings: { rounds: ["warmup"] } }), h);
  g.onMessage(JSON.stringify({ t: "start" }), h);
  g.advance(); // answering
  const round = g.state.rounds[g.state.roundIndex];
  for (const c of ps)
    for (const m of round.matchups.filter((x) => x.playerIds.includes(g.pidOf(c)!)))
      g.onMessage(JSON.stringify({ t: "answer", matchupId: m.id, text: `from ${c.id}` }), c);
  assert.equal(g.state.phase, "matchupIntro");
  g.advance(); // voting
  const m = round.matchups[g.state.matchupIndex];
  const at = g.hostView().matchup?.answerAt ?? [];
  assert.equal(at.length, 2, "card times while answers are read");
  assert.ok(at[1] >= at[0] + 2000 + 250 + 2000, "second card after the first answer and the versus line");
  const say = g.state.say ?? [];
  assert.ok(say.some((c) => (c as { text?: string }).text?.match(/^(Versus|Or|Up against)…$/)), "versus between the answers");
  for (const c of ps) if (!m.playerIds.includes(g.pidOf(c)!)) g.onMessage(JSON.stringify({ t: "vote", matchupId: m.id, choice: 0 }), c);
  assert.equal(g.state.phase, "voting", "everyone voted, but the answers are still being read");
  await new Promise((r) => setTimeout(r, 200)); // reading ends at about 7.3 s × 0.01
  assert.notEqual(g.state.phase, "voting", "then the tally");
  const author = ps.find((c) => m.playerIds.includes(g.pidOf(c)!))!;
  const pv = (author.sent.find((x) => x.t === "view" && (x.view as { phase: string }).phase === "matchupResult")?.view ?? {}) as { resultInMs?: number; myResult?: unknown };
  assert.ok(pv.myResult && (pv.resultInMs ?? 0) > 0, "phones hold their result until the big screen's tally");
  g.dispose();
}

// Voice effect: studio by default, radio or off on request, anything else falls back.
{
  const cs: FakeConn[] = [];
  const g = new GameRoom({ id: "fx", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => cs });
  await g.onStart();
  const h = new FakeConn("h");
  cs.push(h);
  g.onMessage(JSON.stringify({ t: "helloHost" }), h);
  assert.equal(g.state.settings.voiceFx, "studio", "studio plate by default");
  g.onMessage(JSON.stringify({ t: "settings", settings: { voiceFx: "radio" } }), h);
  assert.equal(g.state.settings.voiceFx, "radio");
  g.onMessage(JSON.stringify({ t: "settings", settings: { voiceFx: "chipmunk" } }), h);
  assert.equal(g.state.settings.voiceFx, "studio", "unknown effects fall back to studio");
  g.dispose();
}

// Games saved before v0.8.2 used device ids as player ids: those phones still get back in.
{
  const cs: FakeConn[] = [];
  const old = { players: [{ id: "old-phone", name: "Old", avatar: "🦊", connected: true, score: 40 }], aliases: {} };
  const g = new GameRoom({ id: "legc", storage: { get: async () => old as never, put: async () => {} }, getConnections: () => cs });
  await g.onStart();
  const c = new FakeConn("old-phone");
  cs.push(c);
  g.onMessage(JSON.stringify({ t: "helloPlayer", name: "" }), c);
  assert.equal(g.pidOf(c), "old-phone", "an old saved player is picked up by its device");
  assert.equal(g.player("old-phone")?.score, 40);
  g.dispose();
}

// Free-tier meter: two overlapping revisions both land their counts; shares follow the limits.
{
  const file = path.join(mkdtempSync(path.join(tmpdir(), "retrolash-meter-")), "meter.json");
  let t = Date.parse("2026-11-19T10:00:00Z");
  const opts = { persist: () => true, log: () => {}, now: () => t };
  const a = new Meter(file, opts);
  const b = new Meter(file, opts);
  a.start();
  b.start();
  a.speech(1000);
  b.speech(500);
  t += 3_600_000; // an hour later
  await a.flush();
  await b.flush();
  await a.stop();
  await b.stop();
  const m = JSON.parse(readFileSync(file, "utf8"))["2026-11"];
  assert.deepEqual([m.speechChars, m.speechClips, m.starts, m.runtimeSec], [1500, 2, 2, 7200], "both revisions counted");
  const sum = summarizeMeter({ "2026-11": m }, { speechChars: 500_000, runtimeHours: 200, speechStopShare: 0.85 }, new Date(t));
  assert.equal(sum.speech.share, 0.003);
  assert.equal(sum.runtime.hours, 2);
  assert.equal(sum.runtime.share, 0.01);
  assert.equal(sum.speech.paused, false);
  assert.equal(summarizeMeter({ "2026-11": { ...m, speechChars: 425_000 } }, undefined, new Date(t)).speech.paused, true, "85% of the free tier: paused");
  assert.equal(summarizeMeter({ "2026-10": m }, undefined, new Date(t)).speech.chars, 0, "a new month starts at zero");
}

// Billable speech characters: the text plus the markup inside <voice>.
{
  const sp = new AzureSpeech({ dir: tmpdir(), voices: { en: "en-US-JennyNeural", sv: "sv-SE-SofieNeural" }, styles: { en: "cheerful" }, log: () => {} });
  const { ssml, billable } = sp.ssml({ text: "Hi & bye", lang: "en", scope: "lib" });
  const inner = ssml.slice(ssml.indexOf("<voice") , ssml.indexOf("</voice>")).replace(/^<voice[^>]*>/, "");
  assert.equal(billable, inner.length);
  assert.ok(inner.includes("&amp;") && inner.startsWith("<mstts:express-as"), "escaped text and markup both count");
}

// Speech abuse: a resubmitted answer costs one clip, games have a budget, and a monthly guard stops room clips.
{
  const made: number[] = [];
  let roomOk = true;
  const sp = new AzureSpeech({
    dir: mkdtempSync(path.join(tmpdir(), "retrolash-tts3-")),
    voices: { en: "en-US-JennyNeural", sv: "sv-SE-SofieNeural" },
    styles: { en: "cheerful" },
    fake: true,
    slotDelayMs: 40,
    roomAllowed: () => roomOk,
    onSynthesized: (chars) => made.push(chars),
    log: () => {},
  });
  await sp.init();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const room = (text: string) => ({ text, lang: "en" as const, scope: "room" as const });
  const budget = { key: "abcd:g1", chars: 100_000 };

  // 200 edits of one answer in a loop: only the last is made.
  for (let i = 0; i < 200; i++) sp.prefetch([room(`spam answer number ${i}`)], { slot: "abcd:m1:p1", budget });
  await wait(150);
  assert.equal(made.length, 1, "200 edits of one answer make one clip");
  assert.ok(sp.get(room("spam answer number 199")), "the last version is the one made");
  assert.equal(sp.get(room("spam answer number 3")), null, "earlier versions never are");
  assert.equal(sp.used("abcd:g1"), made[0], "the game's budget is charged what Azure bills");

  // Answering is over: a clip still waiting out its delay is made at once.
  made.length = 0;
  sp.prefetch([room("a late answer")], { slot: "abcd:m2:p1", budget });
  sp.prefetch([room("a late answer")], { budget });
  await wait(15);
  assert.equal(made.length, 1, "needed now: no waiting for edits");

  // Budget: room clips stop once a game has spent it; stock lines go on.
  made.length = 0;
  const small = { key: "abcd:g2", chars: 250 };
  for (let i = 0; i < 5; i++) sp.prefetch([room(`budget line ${i}`)], { budget: small });
  sp.prefetch([{ text: "Stock line", lang: "en", scope: "lib" }], { budget: small });
  await wait(50);
  assert.ok(sp.used("abcd:g2") <= 250, `budget kept: ${sp.used("abcd:g2")}`);
  assert.equal(made.length, 3, "two room clips fit the budget, plus the stock line");

  // Monthly guard: no new room clips at all; stock lines still made.
  made.length = 0;
  roomOk = false;
  sp.prefetch([room("over the monthly guard")], { budget });
  sp.prefetch([{ text: "Another stock line", lang: "en", scope: "lib" }]);
  await wait(50);
  assert.equal(made.length, 1, "only the stock line is made past the guard");
  assert.equal(sp.get(room("over the monthly guard")), null);
}

// One prompt each for big teams: everyone in exactly one group, about half as many matchups.
assert.equal(promptsEach(DEFAULT_SETTINGS, 11), 2);
assert.equal(promptsEach(DEFAULT_SETTINGS, 12), 1);
assert.equal(promptsEach({ promptsEach: 2 }, 16), 2, "the facilitator can keep two");
for (const n of [4, 5, 12, 13, 14, 16]) {
  const ids = Array.from({ length: n }, (_, i) => `q${i}`);
  for (const trios of [false, true]) {
    const groups = groupPlayers(ids, trios, 1);
    const all = groups.flat();
    assert.equal(all.length, n, `n=${n} trios=${trios}: one prompt each`);
    assert.equal(new Set(all).size, n);
    assert.ok(groups.every((g) => g.length === 2 || g.length === 3));
  }
}
assert.equal(groupPlayers(Array.from({ length: 12 }, (_, i) => `r${i}`), true, 1).length, 4, "12 players, trios, one each: 4 matchups");

// Saved games: the last good save survives a broken main file.
{
  const dir = mkdtempSync(path.join(tmpdir(), "retrolash-store-"));
  const file = path.join(dir, "abcd.json");
  const opts = { persist: () => true, log: () => {} };
  const a = new FileStorage(file, opts);
  await a.put("state", { n: 1 });
  await a.put("state", { n: 2 });
  await a.flush();
  assert.ok(existsSync(`${file}.bak`), "previous save kept as .bak");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).state, { n: 2 });
  writeFileSync(file, '{"state": {"n": 3'); // a write cut off half-way
  const b = new FileStorage(file, opts);
  assert.ok(((await b.get<{ n: number }>("state"))?.n ?? 0) >= 1, "falls back to the backup");
  writeFileSync(file, "");
  writeFileSync(`${file}.bak`, "garbage");
  writeFileSync(`${file}.tmp`, JSON.stringify({ state: { n: 9 } }));
  assert.deepEqual(await new FileStorage(file, opts).get("state"), { n: 9 }, "then to an unfinished temp file");
}

// Kudos read aloud: with every clip ready, each card lands with its voice line, spaced to fit.
{
  const sp = new AzureSpeech({ dir: mkdtempSync(path.join(tmpdir(), "retrolash-tts2-")), voices: { en: "en-US-JennyNeural", sv: "sv-SE-SofieNeural" }, fake: true, log: () => {} });
  await sp.init();
  const cs: FakeConn[] = [];
  const g = new GameRoom({ id: "kdos", storage: { get: async () => undefined, put: async () => {} }, getConnections: () => cs }, 0.1, sp);
  await g.onStart();
  const join = (id: string, hello: object) => {
    const c = new FakeConn(id);
    cs.push(c);
    g.onMessage(JSON.stringify(hello), c);
    return c;
  };
  const h = join("h", { t: "helloHost" });
  const ps = ["Ann", "Bo", "Cy"].map((n) => join(n, { t: "helloPlayer", name: n }));
  g.onMessage(JSON.stringify({ t: "settings", settings: { rounds: ["kudos"] } }), h);
  g.onMessage(JSON.stringify({ t: "start" }), h);
  g.advance(); // answering
  const [annId, boId] = [g.pidOf(ps[0])!, g.pidOf(ps[1])!];
  g.onMessage(JSON.stringify({ t: "kudos", to: boId, text: "Thanks for the reviews" }), ps[0]);
  g.onMessage(JSON.stringify({ t: "kudos", to: "team", text: "Great sprint everyone" }), ps[1]);
  await new Promise((r) => setTimeout(r, 300)); // fake speech makes those two clips
  g.onMessage(JSON.stringify({ t: "kudos", to: annId, text: "Saved the demo" }), ps[2]);
  assert.equal(g.state.phase, "answering", "the last note's clip gets a moment before the reveal");
  await new Promise((r) => setTimeout(r, 600)); // the wait is 3 s × 0.1
  assert.equal(g.state.phase, "pollResult");
  const v = g.hostView();
  assert.equal(v.kudos?.length, 3);
  const spoken = (v.say ?? []).filter((c) => c.at !== undefined);
  assert.equal(spoken.length, 3, "every note is read");
  assert.deepEqual(spoken.map((c) => c.at), v.kudosAt, "each card lands as its note is read");
  assert.ok(v.kudosAt![1] - v.kudosAt![0] >= spoken[0].ms, "cards wait for the voice");
  g.dispose();
}

// Usage summary: bot games and short legacy games are tests; abandoned = started, never finished.
{
  const lines = parseUsage(
    [
      { event: "game", at: "2026-11-11T11:00:00Z", players: 4, audience: 1, minutes: 1.7 }, // legacy bot test
      { event: "game", at: "2026-11-14T22:46:00Z", players: 15, audience: 0, minutes: 40 }, // legacy real
      { event: "start", at: "2026-11-20T09:00:00Z", game: "a1", players: 6, audience: 0, bots: 0 },
      { event: "game", at: "2026-11-20T09:35:00Z", game: "a1", players: 6, audience: 0, bots: 0, minutes: 35, active: 5, actionItems: 4, owned: 2, kudos: 5 },
      { event: "start", at: "2026-11-20T10:00:00Z", game: "b2", players: 5, audience: 0, bots: 0 }, // abandoned
      { event: "game", at: "2026-11-20T11:00:00Z", game: "c3", players: 9, audience: 1, bots: 9, minutes: 5 }, // bots
    ]
      .map((e) => JSON.stringify(e))
      .join(String.fromCharCode(10)) + String.fromCharCode(10) + "not json",
  );
  const u = summarize(lines, { now: new Date("2026-11-20T18:00:00Z") });
  assert.equal(u.games, 2);
  assert.equal(u.thisMonth, 2);
  assert.equal(u.players, 10, "active players when known (5), the list otherwise (15)");
  assert.equal(u.abandoned, 1);
  assert.equal(u.tests, 2);
  assert.equal(u.ownedShare, 0.5);
  assert.equal(summarize(lines, { includeTests: true }).games, 4);
}

console.log("selftest OK");
