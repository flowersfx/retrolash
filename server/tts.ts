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
import type { Speech, SpeechClip, SpeechLine } from "./game";
import type { Lang } from "../shared/types";

/** 48 kbit/s constant bitrate, so a clip's length follows from its size. */
const FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const BYTES_PER_MS = 48_000 / 8 / 1000;
const CONCURRENCY = 2;
const RETRY_FAILED_MS = 10 * 60_000;
export const CLIP_PATH = /^\/tts\/(lib|room)\/([a-f0-9]{32})\.mp3$/;

type Entry = { state: "ready"; ms: number } | { state: "pending" } | { state: "failed"; at: number };

export interface SpeechConfig {
  dir: string;
  region?: string;
  key?: string;
  voices: Record<Lang, string>;
  /** Test hook: write fake clips instead of calling Azure. */
  fake?: boolean;
  log: (...args: unknown[]) => void;
}

export class AzureSpeech implements Speech {
  readonly enabled: boolean;
  private index = new Map<string, Entry>();
  private queue: { id: string; line: SpeechLine }[] = [];
  private running = 0;

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
    const hash = createHash("sha256").update(`${voice}|${FORMAT}|${line.text}`).digest("hex").slice(0, 32);
    return `${line.scope}/${hash}`;
  }

  get(line: SpeechLine): SpeechClip | null {
    if (!this.enabled) return null;
    const id = this.id(line);
    const e = this.index.get(id);
    if (e?.state !== "ready") {
      this.prefetch([line]);
      return null;
    }
    return { id, url: `/tts/${id}.mp3`, ms: Math.round(e.ms) };
  }

  prefetch(lines: SpeechLine[]) {
    if (!this.enabled) return;
    for (const line of lines) {
      if (!line.text.trim()) continue;
      const id = this.id(line);
      const e = this.index.get(id);
      if (e?.state === "ready" || e?.state === "pending") continue;
      if (e?.state === "failed" && Date.now() - e.at < RETRY_FAILED_MS) continue;
      this.index.set(id, { state: "pending" });
      this.queue.push({ id, line });
    }
    this.pump();
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
      this.running++;
      void this.synthesize(job.id, job.line).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async synthesize(id: string, line: SpeechLine) {
    try {
      const audio = this.cfg.fake ? fakeClip(line.text) : await this.callAzure(line);
      const [scope, hash] = id.split("/");
      await writeFile(path.join(this.cfg.dir, scope, `${hash}.mp3`), audio);
      this.index.set(id, { state: "ready", ms: audio.length / BYTES_PER_MS });
    } catch (err) {
      this.index.set(id, { state: "failed", at: Date.now() });
      this.cfg.log(`speech: failed to synthesise a ${line.scope} line`, err instanceof Error ? err.message : err);
    }
  }

  private async callAzure(line: SpeechLine): Promise<Buffer> {
    const voice = this.cfg.voices[line.lang] ?? this.cfg.voices.en;
    const xmlLang = voice.split("-").slice(0, 2).join("-");
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">` +
      `<voice name="${voice}"><prosody rate="+4%">${escapeXml(line.text)}</prosody></voice></speak>`;
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
