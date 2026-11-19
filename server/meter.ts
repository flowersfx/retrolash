// Monthly meter for the two things with a free tier: Azure AI Speech characters
// and container runtime. Kept in DATA_DIR/meter.json as { "YYYY-MM": counts }.
//
// Counts build up in memory and are added to the file about once a minute
// (read, add, write), so two revisions overlapping during a rollout both land
// their share instead of overwriting each other. A crash loses at most a minute.
import { readFile, rename, writeFile } from "node:fs/promises";

export interface MeterMonth {
  /** Billable characters sent to Azure Speech (text plus markup inside <voice>). */
  speechChars: number;
  speechClips: number;
  /** Seconds this server process was running (scaled to zero = not running). */
  runtimeSec: number;
  /** Process starts (cold starts and rollouts). */
  starts: number;
}

export type MeterData = Record<string, MeterMonth>;

const empty = (): MeterMonth => ({ speechChars: 0, speechClips: 0, runtimeSec: 0, starts: 0 });
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const FLUSH_MS = 60_000;

export class Meter {
  private delta: MeterData = {};
  private lastTick = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly opts: { persist: () => boolean; log: (...args: unknown[]) => void; now?: () => number },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private add(fields: Partial<MeterMonth>, at = this.now()) {
    const m = (this.delta[monthOf(at)] ??= empty());
    for (const [k, v] of Object.entries(fields) as [keyof MeterMonth, number][]) m[k] += v;
  }

  /** Count this process start and keep the runtime ticking. */
  start() {
    this.lastTick = this.now();
    this.add({ starts: 1 });
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  speech(chars: number) {
    this.add({ speechChars: chars, speechClips: 1 });
  }

  private tick() {
    const now = this.now();
    this.add({ runtimeSec: (now - this.lastTick) / 1000 }, now);
    this.lastTick = now;
  }

  /** Saved counts plus what hasn't been written yet. */
  async read(): Promise<MeterData> {
    this.tick();
    const saved = this.opts.persist() ? await readMeter(this.file) : {};
    return merge(saved, this.delta);
  }

  /** Add the in-memory counts to the file. */
  flush(): Promise<void> {
    this.tick();
    this.writing = this.writing.then(async () => {
      if (!this.opts.persist() || Object.keys(this.delta).length === 0) return;
      const delta = this.delta;
      this.delta = {};
      try {
        const body = JSON.stringify(merge(await readMeter(this.file), delta), null, 1);
        await writeFile(`${this.file}.tmp`, body);
        await rename(`${this.file}.tmp`, this.file);
      } catch (err) {
        this.delta = merge(delta, this.delta); // try again next time
        this.opts.log("meter: write failed", err);
      }
    });
    return this.writing;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

function merge(a: MeterData, b: MeterData): MeterData {
  const out: MeterData = {};
  for (const src of [a, b])
    for (const [month, m] of Object.entries(src)) {
      const o = (out[month] ??= empty());
      for (const k of Object.keys(o) as (keyof MeterMonth)[]) o[k] += Number(m[k]) || 0;
    }
  return out;
}

async function readMeter(file: string): Promise<MeterData> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export interface MeterLimits {
  /** Azure Speech F0: 0.5 million neural characters a month. */
  speechChars: number;
  /** Container Apps monthly free grant (180,000 vCPU-s, 360,000 GiB-s) at 0.25 vCPU / 0.5 GiB = 200 h. */
  runtimeHours: number;
}

export const DEFAULT_LIMITS: MeterLimits = { speechChars: 500_000, runtimeHours: 200 };

export interface MeterSummary {
  month: string;
  speech: { chars: number; clips: number; free: number; share: number };
  runtime: { hours: number; starts: number; free: number; share: number };
  total: { speechChars: number; hours: number };
}

export function summarizeMeter(data: MeterData, limits: MeterLimits = DEFAULT_LIMITS, now = new Date()): MeterSummary {
  const month = now.toISOString().slice(0, 7);
  const m = data[month] ?? empty();
  const hours = m.runtimeSec / 3600;
  const all = Object.values(data);
  const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    month,
    speech: { chars: m.speechChars, clips: m.speechClips, free: limits.speechChars, share: round(m.speechChars / limits.speechChars, 4) },
    runtime: { hours: round(hours, 1), starts: m.starts, free: limits.runtimeHours, share: round(hours / limits.runtimeHours, 4) },
    total: {
      speechChars: all.reduce((a, x) => a + x.speechChars, 0),
      hours: round(all.reduce((a, x) => a + x.runtimeSec, 0) / 3600, 1),
    },
  };
}
