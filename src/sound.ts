// Big-screen sound effects and a background loop, synthesised with Web Audio
// (no audio files). Browsers only allow audio after a user gesture, so the
// context is created lazily and resumed on the first click or key press.

const KEY = "retrolash:sound";
const MUSIC_KEY = "retrolash:music";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let voiceBus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "off";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}

function readVolume(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return localStorage.getItem(key) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  } catch {
    return fallback;
  }
}

let enabled = readFlag(KEY, true);
let musicOn = readFlag(MUSIC_KEY, true);
/** User volume per channel, 0..1. */
const volume = {
  music: readVolume("retrolash:vol:music", 0.6),
  sfx: readVolume("retrolash:vol:sfx", 1),
  voice: readVolume("retrolash:vol:voice", 1),
};
type Channel = keyof typeof volume;
const listeners = new Set<() => void>();

function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = volume.sfx;
    sfxBus.connect(master);
    voiceBus = ctx.createGain();
    voiceBus.gain.value = volume.voice;
    voiceBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  audio();
  if (musicOn) startMusic();
}

export function soundEnabled() {
  return enabled;
}

export function soundReady() {
  return !!ctx && ctx.state === "running";
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  writeFlag(KEY, on);
  if (on) {
    audio();
    if (musicOn) startMusic();
  } else void ctx?.suspend();
  listeners.forEach((l) => l());
}

export function musicEnabled() {
  return musicOn;
}

export function setMusicEnabled(on: boolean) {
  musicOn = on;
  writeFlag(MUSIC_KEY, on);
  if (on) startMusic();
  else stopMusic();
  listeners.forEach((l) => l());
}

export function onSoundChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function tone(
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType = "sine",
  vol = 1,
  slideTo?: number,
  dest: AudioNode | null = sfxBus,
  attack = 0.01,
) {
  const c = audio();
  if (!c || !dest) return;
  const t = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(start: number, dur: number, vol = 0.5, from = 800, to = 4000, dest: AudioNode | null = sfxBus, type: BiquadFilterType = "bandpass") {
  const c = audio();
  if (!c || !dest || !noiseBuf) return;
  const t = c.currentTime + start;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

/** Briefly lower the music so a sound effect cuts through. */
function duck(seconds = 0.8) {
  if (!ctx || !musicBus || !musicOn) return;
  const t = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(t);
  musicBus.gain.setTargetAtTime(musicLevel() * 0.35, t, 0.03);
  musicBus.gain.setTargetAtTime(musicLevel(), t + seconds, 0.4);
}

export const sfx = {
  /** Last seconds of a timer. */
  tick: (urgent = false) => tone(urgent ? 1400 : 1000, 0, 0.05, "square", 0.25),
  /** A card sliding in or out. */
  whoosh: (delay = 0) => noise(delay, 0.35, 0.4, 400, 3000),
  /** One vote landing; pitch climbs with the count. */
  blip: (i: number, delay = 0) => tone(440 * Math.pow(2, Math.min(i, 14) / 12), delay, 0.12, "triangle", 0.6),
  /** Something got revealed. */
  sting: (delay = 0) => {
    duck();
    tone(523, delay, 0.18, "sawtooth", 0.35);
    tone(784, delay + 0.08, 0.3, "sawtooth", 0.35);
  },
  /** Big win / clean sweep. */
  fanfare: (delay = 0) => {
    duck(1.6);
    [523, 659, 784, 1047].forEach((f, i) => tone(f, delay + i * 0.11, 0.35, "square", 0.3));
    tone(1047, delay + 0.45, 0.7, "triangle", 0.5);
  },
  /** A tense roll before a reveal. */
  drumroll: (dur = 1.2) => {
    duck(dur + 0.4);
    for (let t = 0; t < dur; t += 0.05) noise(t, 0.05, 0.15 + (t / dur) * 0.35, 150, 300);
  },
  /** Round intro. */
  intro: () => {
    duck(1);
    tone(196, 0, 0.25, "sawtooth", 0.3, 392);
    tone(392, 0.25, 0.5, "triangle", 0.5);
  },
  /** Rising tension before a matchup. */
  riser: (dur = 2.4, delay = 0) => {
    tone(180, delay, dur, "sawtooth", 0.12, 720, sfxBus, dur * 0.8);
    noise(delay, dur, 0.18, 300, 6000, sfxBus, "highpass");
  },
  /** A heavy hit: the matchup number slams in. */
  boom: (delay = 0) => {
    duck(0.6);
    tone(110, delay, 0.5, "sine", 0.9, 40);
    noise(delay, 0.25, 0.4, 2000, 200, sfxBus, "lowpass");
  },
  /** RETROLASH: a crash and a big chord. */
  retrolash: (delay = 0) => {
    duck(2.5);
    noise(delay, 1.2, 0.6, 8000, 1500, sfxBus, "highpass");
    tone(65, delay, 0.8, "sine", 0.9, 35);
    [523, 659, 784].forEach((f) => tone(f, delay + 0.05, 1.1, "sawtooth", 0.18));
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, delay + 0.35 + i * 0.09, 0.3, "square", 0.22));
  },
  /** A card getting knocked out. */
  knockout: (delay = 0) => {
    noise(delay, 0.5, 0.45, 2500, 200, sfxBus, "bandpass");
    tone(300, delay, 0.4, "triangle", 0.3, 80);
  },
  /** A reaction bubble from a phone. */
  pop: () => tone(900 + Math.random() * 500, 0, 0.06, "sine", 0.25),
  /** Time is up. */
  buzzer: () => tone(140, 0, 0.45, "sawtooth", 0.35, 90),
};

// ---------- background music ----------
// A mellow four-chord loop: soft pads, a walking bass, brushed hats and a
// little arpeggio. Scheduled a few hundred ms ahead so it never stutters.

const BPM = 96;
const EIGHTH = 60 / BPM / 2;
// Am7, Dm9, G7, Cmaj7 as MIDI notes.
const CHORDS = [
  [57, 60, 64, 67],
  [50, 57, 60, 64],
  [55, 59, 62, 65],
  [48, 55, 59, 64],
];
const ARP = [0, 2, 1, 3, 2, 1, 3, 0];
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

let level = 0.5;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let nextTime = 0;
let step = 0;

function scheduleMusic() {
  const c = ctx;
  if (!c || !musicBus) return;
  while (nextTime < c.currentTime + 0.3) {
    const at = nextTime - c.currentTime;
    const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
    const inBar = step % 8;
    if (inBar === 0) chord.forEach((n) => tone(midi(n), at, EIGHTH * 8, "triangle", 0.05, undefined, musicBus, 0.4));
    if (inBar % 2 === 0) {
      const bass = chord[0] - 12 + (inBar === 6 ? 7 : 0);
      tone(midi(bass), at, EIGHTH * 1.8, "sine", 0.22, undefined, musicBus, 0.02);
    }
    if (inBar % 2 === 1) noise(at, 0.05, 0.05, 7000, 9000, musicBus, "highpass");
    if (inBar === 4) noise(at, 0.12, 0.08, 1800, 1200, musicBus, "bandpass");
    if (Math.floor(step / 32) % 2 === 1 || inBar % 3 === 0) {
      tone(midi(chord[ARP[inBar]] + 12), at, EIGHTH * 0.9, "sine", 0.05, undefined, musicBus, 0.01);
    }
    nextTime += EIGHTH;
    step++;
  }
}

function startMusic() {
  const c = audio();
  if (!c || !musicBus || musicTimer) return;
  nextTime = c.currentTime + 0.1;
  step = 0;
  musicBus.gain.setTargetAtTime(musicLevel(), c.currentTime, 1.5);
  musicTimer = setInterval(scheduleMusic, 100);
}

function stopMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = null;
  if (ctx && musicBus) musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
}

/** Music level by context: full in the lobby, quiet while people talk. */
export function setMusicMood(mood: "full" | "low" | "talk") {
  level = mood === "full" ? 0.5 : mood === "low" ? 0.3 : 0.12;
  if (ctx && musicBus && musicTimer) musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.8);
}

/** Music gain: the mood level scaled by the user's music volume. */
function musicLevel() {
  return level * volume.music;
}

export function getVolume(kind: Channel) {
  return volume[kind];
}

export function setVolume(kind: Channel, v: number) {
  volume[kind] = Math.min(1, Math.max(0, v));
  try {
    localStorage.setItem(`retrolash:vol:${kind}`, String(volume[kind]));
  } catch {
    /* private mode */
  }
  if (ctx && kind === "sfx" && sfxBus) sfxBus.gain.setTargetAtTime(volume.sfx, ctx.currentTime, 0.05);
  if (ctx && kind === "voice" && voiceBus) voiceBus.gain.setTargetAtTime(volume.voice, ctx.currentTime, 0.05);
  if (ctx && kind === "music" && musicBus && musicTimer) musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.1);
  listeners.forEach((l) => l());
}

// ---------- spoken prompts ----------
// Clips come from the game server (/tts/...). They play through their own
// channel, and the music ducks underneath while someone is talking.

const clipCache = new Map<string, Promise<AudioBuffer | null>>();
let voiceToken = 0;
let voiceSource: AudioBufferSourceNode | null = null;

function loadClip(url: string): Promise<AudioBuffer | null> {
  let p = clipCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => audio()?.decodeAudioData(buf) ?? null)
      .catch(() => {
        clipCache.delete(url);
        return null;
      });
    clipCache.set(url, p);
  }
  return p;
}

/**
 * Say these clips in order. A clip with `at` waits until that many ms after the
 * call (e.g. the winner's name as first place appears). A new call interrupts.
 */
export async function sayClips(clips: { url: string; at?: number }[]) {
  const c = audio();
  if (!c || !voiceBus || volume.voice === 0 || clips.length === 0) return;
  stopVoice();
  const token = voiceToken;
  const t0 = performance.now();
  clips.forEach((clip) => void loadClip(clip.url)); // fetch all now, so later ones are ready on time
  for (const clip of clips) {
    const buf = await loadClip(clip.url);
    if (token !== voiceToken) return;
    if (!buf) continue;
    if (clip.at !== undefined) {
      const wait = clip.at - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (token !== voiceToken) return;
    }
    duck(buf.duration + 0.6);
    await new Promise<void>((resolve) => {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(voiceBus!);
      src.onended = () => resolve();
      voiceSource = src;
      src.start();
    });
    if (token !== voiceToken) return;
  }
  voiceSource = null;
}

export function stopVoice() {
  voiceToken++;
  try {
    voiceSource?.stop();
  } catch {
    /* already stopped */
  }
  voiceSource = null;
}
