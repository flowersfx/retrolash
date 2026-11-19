// File-backed storage for one room. Writes are coalesced and atomic, and the
// previous good save is kept as <file>.bak, so a crash or a broken write never
// loses a game: loading falls back from the file to the backup to an
// unfinished temp file, and only then starts fresh.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomStorage } from "./game";

export interface FileStorageOptions {
  /** False when the data dir isn't writable: keep everything in memory. */
  persist: () => boolean;
  log: (...args: unknown[]) => void;
}

export class FileStorage implements RoomStorage {
  private cache = new Map<string, unknown>();
  private loaded = false;
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly opts: FileStorageOptions,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.loaded && this.opts.persist()) {
      this.loaded = true;
      for (const candidate of [this.file, `${this.file}.bak`, `${this.file}.tmp`]) {
        const raw = await readJson(candidate);
        if (!raw) continue;
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
        if (candidate !== this.file) this.opts.log(`recovered ${path.basename(this.file)} from ${path.basename(candidate)}`);
        break;
      }
    }
    return this.cache.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): Promise<void> {
    // Snapshot now: the game mutates its state object in place.
    this.cache.set(key, structuredClone(value));
    this.loaded = true;
    if (!this.opts.persist()) return Promise.resolve();
    this.dirty = true;
    this.pending ??= this.flushLoop();
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  private async flushLoop() {
    try {
      while (this.dirty) {
        this.dirty = false;
        const body = JSON.stringify(Object.fromEntries(this.cache));
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, body);
        // Keep the last good save before replacing it (missing on the first save).
        await rename(this.file, `${this.file}.bak`).catch(() => {});
        await rename(tmp, this.file);
      }
    } catch (err) {
      this.opts.log(`failed to save ${path.basename(this.file)}`, err);
    } finally {
      this.pending = null;
    }
  }
}

/** The parsed object, or null if the file is missing, empty or broken. */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}
