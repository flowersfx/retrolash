// Voice FX bench: a page to audition reverb/saturation settings on real game clips.
//   node tools/voice-fx/build.mjs [host]      (default host: retrolash.flowersfx.com)
// Downloads a few stock clips the live server has already made, embeds them in
// template.html and writes tools/voice-fx/voice-fx.html (not in git: it holds audio).
// Open that file in a browser, pick settings, then copy them into
// VOICE_FX_PRESETS in src/sound.ts (same chain, same numbers).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = process.argv[2] ?? "retrolash.flowersfx.com";
const here = path.dirname(fileURLToPath(import.meta.url));
// Must match server/tts.ts (FORMAT, voices and styles in server/main.ts).
const FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const VOICE = { en: "en-US-JennyNeural|" + FORMAT + "|cheerful|", sv: "sv-SE-SofieNeural|" + FORMAT + "|" };
// Keep this order: the bench's "vote sequence" plays 0-2 (English) or 4-6 (Swedish).
const LINES = [
  ["en", "Time to vote! Pick your favourite."],
  ["en", "Versus…"],
  ["en", "Retrolash! A clean sweep!"],
  ["en", "That's a wrap! Great retro, everyone!"],
  ["sv", "Dags att rösta! Välj din favorit."],
  ["sv", "Mot…"],
  ["sv", "Retrolash! Alla röster på ett svar!"],
];

const clips = [];
for (const [lang, text] of LINES) {
  const id = createHash("sha256").update(VOICE[lang] + text).digest("hex").slice(0, 32);
  const res = await fetch(`https://${host}/tts/lib/${id}.mp3`);
  if (!res.ok) throw new Error(`${text}: ${res.status} (the server makes stock clips at start; is speech on?)`);
  clips.push({ lang, text, src: "data:audio/mpeg;base64," + Buffer.from(await res.arrayBuffer()).toString("base64") });
}
const out = path.join(here, "voice-fx.html");
writeFileSync(out, readFileSync(path.join(here, "template.html"), "utf8").replace("/*CLIPS*/[]", JSON.stringify(clips)));
console.log(`wrote ${out} (${clips.length} clips)`);
