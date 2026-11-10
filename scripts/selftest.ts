// Quick checks for the pure helpers in shared/. Run: npx tsx scripts/selftest.ts
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PACKS, emojiOnly, parsePreviousItems, planRounds } from "../shared/types";
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
  voices: { en: "en-US-GuyNeural", sv: "sv-SE-MattiasNeural" },
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
console.log("selftest OK");
