// Spoken prompts: Azure AI Speech, generated on demand and cached on disk.
//
// - Lines are identified by a hash of voice + text, so the same prompt is only
//   ever synthesised once. "lib" lines (built-in prompts, round titles) are kept
//   for good; "room" lines (custom prompts, later answers) are deleted with the
//   saved games, since they can contain real retro content.
// - The game asks for lines ahead of time (prefetch) and only uses clips that are
//   already on disk, so a slow or failing Speech service never holds the game up.
// - Clients can only download clips the server made; they can't submit text.
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Speech, SpeechClip, SpeechLine, SpeechOptions } from "./game";
import type { Lang } from "../shared/types";

/** 48 kbit/s constant bitrate, so a clip's length follows from its size. */
const FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const BYTES_PER_MS = 48_000 / 8 / 1000;
const CONCURRENCY = 2;
const RETRY_FAILED_MS = 10 * 60_000;
/** A slotted line (a player's answer or kudos) waits this long for edits before it is made. */
const SLOT_DELAY_MS = 3000;
export const CLIP_PATH = /^\/tts\/(lib|room)\/([a-f0-9]{32})\.mp3$/;

type Entry = { state: "ready"; ms: number } | { state: "pending" } | { state: "failed"; at: number };
type Job = { id: string; line: SpeechLine; slot?: string; budget?: SpeechOptions["budget"] };

export interface SpeechConfig {
  dir: string;
  region?: string;
  key?: string;
  voices: Record<Lang, string>;
  /** Speaking style per language, e.g. "cheerful" (only for voices that support it). */
  styles?: Partial<Record<Lang, string>>;
  /** Called with the billable characters of each clip made (for the free-tier meter). */
  onSynthesized?: (chars: number) => void;
  /** False stops new room clips (player and facilitator text) server-wide, e.g. near the monthly free tier. */
  roomAllowed?: () => boolean;
  slotDelayMs?: number;
  /** Test hook: write fake clips instead of calling Azure. */
  fake?: boolean;
  log: (...args: unknown[]) => void;
}

export class AzureSpeech implements Speech {
  readonly enabled: boolean;
  private index = new Map<string, Entry>();
  private queue: Job[] = [];
  private running = 0;
  /** Slotted jobs still waiting out their delay, by clip id. */
  private delayed = new Map<string, { job: Job; timer: ReturnType<typeof setTimeout> }>();
  /** The clip id each slot currently wants. */
  private slots = new Map<string, string>();
  /** Billable room characters spent per budget key (a game). */
  private spent = new Map<string, { chars: number; at: number }>();
  /** Budget keys already logged as over, and whether the monthly guard was logged. */
  private overLogged = new Set<string>();
  private guardLogged = false;

  constructor(private readonly cfg: SpeechConfig) {
    this.enabled = !!cfg.fake || !!(cfg.key && cfg.region);
  }

  /** Load what's already cached, so a restart doesn't re-synthesise anything. */
  async init() {
    if (!this.enabled) return;
    for (const scope of ["lib", "room"] as const) {
      const dir = path.join(this.cfg.dir, scope);
      await mkdir(dir, { recursive: true });
      for (const name of await readdir(dir)) {
        const m = /^([a-f0-9]{32})\.mp3$/.exec(name);
        if (!m) continue;
        const info = await stat(path.join(dir, name)).catch(() => null);
        if (info?.size) this.index.set(`${scope}/${m[1]}`, { state: "ready", ms: info.size / BYTES_PER_MS });
      }
    }
    this.cfg.log(`speech: ${this.cfg.fake ? "fake" : this.cfg.region}, ${this.index.size} cached clip(s)`);
  }

  id(line: SpeechLine) {
    const voice = this.cfg.voices[line.lang] ?? this.cfg.voices.en;
    const style = this.cfg.styles?.[line.lang];
    // The style is part of the id only when set, so unstyled clips keep their cache.
    const key = `${voice}|${FORMAT}|${style ? `${style}|` : ""}${line.text}`;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return `${line.scope}/${hash}`;
  }

  get(line: SpeechLine, opts: SpeechOptions = {}): SpeechClip | null {
    if (!this.enabled) return null;
    const id = this.id(line);
    const e = this.index.get(id);
    if (e?.state !== "ready") {
      // Needed now: no slot delay.
      this.prefetch([line], { budget: opts.budget });
      return null;
    }
    return { id, url: `/tts/${id}.mp3`, ms: Math.round(e.ms) };
  }

  /**
   * Start making these in the background. With a slot, a newer line for the same
   * slot replaces one that hasn't started yet, and waits a moment for further
   * edits: resubmitting an answer over and over costs one clip, not one per edit.
   */
  prefetch(lines: SpeechLine[], opts: SpeechOptions = {}) {
    if (!this.enabled) return;
    for (const line of lines) {
      if (!line.text.trim()) continue;
      const id = this.id(line);
      if (opts.slot) this.replaceSlot(opts.slot, id);
      const e = this.index.get(id);
      if (e?.state === "ready") continue;
      if (e?.state === "pending") {
        // Someone needs a delayed clip without delay (answering is over): make it now.
        if (!opts.slot) this.release(id);
        continue;
      }
      if (e?.state === "failed" && Date.now() - e.at < RETRY_FAILED_MS) continue;
      this.index.set(id, { state: "pending" });
      const job: Job = { id, line, slot: opts.slot, budget: opts.budget };
      if (opts.slot) {
        this.slots.set(opts.slot, id);
        const timer = setTimeout(() => this.release(id), this.cfg.slotDelayMs ?? SLOT_DELAY_MS);
        timer.unref?.();
        this.delayed.set(id, { job, timer });
      } else {
        this.queue.push(job);
      }
    }
    this.pump();
  }

  /** Billable room characters spent so far under this budget key. */
  used(key: string) {
    return this.spent.get(key)?.chars ?? 0;
  }

  /** Move a delayed job into the queue now. */
  private release(id: string) {
    const d = this.delayed.get(id);
    if (!d) return;
    clearTimeout(d.timer);
    this.delayed.delete(id);
    this.queue.push(d.job);
    this.pump();
  }

  /** The slot now wants this id: drop its previous clip if that hasn't started. */
  private replaceSlot(slot: string, id: string) {
    const prev = this.slots.get(slot);
    if (!prev || prev === id) return;
    this.slots.delete(slot);
    const d = this.delayed.get(prev);
    if (d) {
      clearTimeout(d.timer);
      this.delayed.delete(prev);
    } else {
      const i = this.queue.findIndex((j) => j.id === prev);
      if (i < 0) return; // already being made
      this.queue.splice(i, 1);
    }
    if (this.index.get(prev)?.state === "pending") this.index.delete(prev);
  }

  /** May this room clip be made? Checks the monthly guard and the game's budget. */
  private affordable(job: Job, billable: number) {
    if (job.line.scope !== "room") return true;
    if (this.cfg.roomAllowed && !this.cfg.roomAllowed()) {
      if (!this.guardLogged) this.cfg.log("speech: room clips paused (monthly free-tier guard)");
      this.guardLogged = true;
      return false;
    }
    this.guardLogged = false;
    const b = job.budget;
    if (!b) return true;
    if (this.used(b.key) + billable <= b.chars) return true;
    if (!this.overLogged.has(b.key)) this.cfg.log(`speech: game ${b.key} is over its budget of ${b.chars} characters`);
    this.overLogged.add(b.key);
    return false;
  }

  /** Path on disk for a clip URL, or null if it isn't one of ours. */
  file(urlPath: string): { file: string; scope: "lib" | "room" } | null {
    const m = CLIP_PATH.exec(urlPath);
    if (!m) return null;
    const id = `${m[1]}/${m[2]}`;
    if (this.index.get(id)?.state !== "ready") return null;
    return { file: path.join(this.cfg.dir, m[1], `${m[2]}.mp3`), scope: m[1] as "lib" | "room" };
  }

  /** Delete room clips older than the saved-game TTL. Library clips stay. */
  async sweep(maxAgeMs: number) {
    if (!this.enabled) return;
    const old = Date.now() - maxAgeMs;
    for (const [key, v] of this.spent) if (v.at < old) this.spent.delete(key);
    this.overLogged.clear();
    const dir = path.join(this.cfg.dir, "room");
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(file).catch(() => {});
        this.index.delete(`room/${name.replace(/\.mp3$/, "")}`);
      }
    }
  }

  private pump() {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.slot && this.slots.get(job.slot) === job.id) this.slots.delete(job.slot);
      const { ssml, billable } = this.ssml(job.line);
      if (!this.affordable(job, billable)) {
        // Not made; a later request may try again (and be refused again, quietly).
        if (this.index.get(job.id)?.state === "pending") this.index.delete(job.id);
        continue;
      }
      if (job.budget && job.line.scope === "room") {
        const prev = this.spent.get(job.budget.key) ?? { chars: 0, at: 0 };
        this.spent.set(job.budget.key, { chars: prev.chars + billable, at: Date.now() });
      }
      this.running++;
      void this.synthesize(job.id, job.line, ssml, billable).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async synthesize(id: string, line: SpeechLine, ssml: string, billable: number) {
    try {
      const audio = this.cfg.fake ? fakeClip(line.text) : await this.callAzure(ssml);
      this.cfg.onSynthesized?.(billable);
      const [scope, hash] = id.split("/");
      await writeFile(path.join(this.cfg.dir, scope, `${hash}.mp3`), audio);
      this.index.set(id, { state: "ready", ms: audio.length / BYTES_PER_MS });
    } catch (err) {
      this.index.set(id, { state: "failed", at: Date.now() });
      this.cfg.log(`speech: failed to synthesise a ${line.scope} line`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * The request body, and what Azure bills for it: every character inside
   * <voice>, markup included (only the <speak> and <voice> tags are free).
   */
  ssml(line: SpeechLine) {
    const voice = this.cfg.voices[line.lang] ?? this.cfg.voices.en;
    const xmlLang = voice.split("-").slice(0, 2).join("-");
    const style = this.cfg.styles?.[line.lang];
    const body = `<prosody rate="+4%">${escapeXml(line.text)}</prosody>`;
    const inner = style ? `<mstts:express-as style="${escapeXml(style)}">${body}</mstts:express-as>` : body;
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${xmlLang}">` +
      `<voice name="${voice}">${inner}</voice></speak>`;
    return { ssml, billable: [...inner].length };
  }

  private async callAzure(ssml: string): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://${this.cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.cfg.key!,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": FORMAT,
          "User-Agent": "retrolash",
        },
        body: ssml,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      // The free tier is rate-limited: back off and retry a few times.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      throw new Error(`Speech service returned ${res.status}`);
    }
  }
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Silent stand-in for tests: size matches roughly 70 ms per character. */
function fakeClip(text: string) {
  return Buffer.alloc(Math.round(text.length * 70 * BYTES_PER_MS));
}
