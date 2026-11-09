// Big-screen sound effects, synthesised with Web Audio (no audio files).
// Browsers only allow audio after a user gesture, so the context is created
// lazily and resumed on the first click or key press.

const KEY = "retrolash:sound";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
})();
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
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  audio();
}

export function soundEnabled() {
  return enabled;
}

export function soundReady() {
  return !!ctx && ctx.state === "running";
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  if (on) audio();
  else void ctx?.suspend();
  listeners.forEach((l) => l());
}

export function onSoundChange(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", vol = 1, slideTo?: number) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(start: number, dur: number, vol = 0.5, from = 800, to = 4000) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + start;
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  /** Last seconds of a timer. */
  tick: (urgent = false) => tone(urgent ? 1400 : 1000, 0, 0.05, "square", 0.25),
  /** A card sliding in. */
  whoosh: (delay = 0) => noise(delay, 0.35, 0.4, 400, 3000),
  /** One vote landing; pitch climbs with the count. */
  blip: (i: number, delay = 0) => tone(440 * Math.pow(2, Math.min(i, 14) / 12), delay, 0.12, "triangle", 0.6),
  /** Something got revealed. */
  sting: (delay = 0) => {
    tone(523, delay, 0.18, "sawtooth", 0.35);
    tone(784, delay + 0.08, 0.3, "sawtooth", 0.35);
  },
  /** Big win / clean sweep. */
  fanfare: (delay = 0) => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, delay + i * 0.11, 0.35, "square", 0.3));
    tone(1047, delay + 0.45, 0.7, "triangle", 0.5);
  },
  /** A tense roll before a reveal. */
  drumroll: (dur = 1.2) => {
    for (let t = 0; t < dur; t += 0.05) noise(t, 0.05, 0.15 + (t / dur) * 0.35, 150, 300);
  },
  /** Round intro. */
  intro: () => {
    tone(196, 0, 0.25, "sawtooth", 0.3, 392);
    tone(392, 0.25, 0.5, "triangle", 0.5);
  },
  /** A reaction bubble from a phone. */
  pop: () => tone(900 + Math.random() * 500, 0, 0.06, "sine", 0.25),
  /** Time is up. */
  buzzer: () => tone(140, 0, 0.45, "sawtooth", 0.35, 90),
};
