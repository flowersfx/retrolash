// Retrolash runtime: one Node process that serves the built client (dist/)
// and hosts every game room over WebSockets. Designed for a single replica
// (Azure Container Apps with maxReplicas 1). Room state lives in memory and is
// mirrored to DATA_DIR so a restart or scale-to-zero resumes games.
//
// WebSocket URL (what partysocket uses): /parties/main/<room>?_pk=<deviceId>

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GameRoom, type Connection, type Room } from "./game";
import { FileStorage } from "./storage";
import { parseUsage, summarize, type UsageSummary } from "./usage";
import { AzureSpeech } from "./tts";
import { strings } from "../shared/i18n";

const PORT = Number(process.env.PORT ?? 1999);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");
/** Saved games older than this are deleted (data minimisation). */
const ROOM_TTL_HOURS = Number(process.env.ROOM_TTL_HOURS ?? 24);
/** Drop a room from memory after this long with nobody connected. */
const IDLE_EVICT_MS = 30 * 60_000;
const MAX_ROOMS = 200;
/** New games one address may start per window (an office NAT shares one, so not too low). */
const ROOMS_PER_IP = 10;
const ROOMS_PER_IP_WINDOW_MS = 10 * 60_000;
/** A socket that says nothing this long is closed (every real client says hello at once). */
const HELLO_TIMEOUT_MS = 10_000;
/** Test hook: 0.1 makes every game timer 10x faster. */
const TIME_SCALE = Number(process.env.TIME_SCALE ?? 1) || 1;
const STATIC_DIR =
  process.env.STATIC_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Spoken prompts (optional). The key comes from a Container Apps secret.
const speech = new AzureSpeech({
  dir: path.join(DATA_DIR, "tts"),
  region: process.env.SPEECH_REGION,
  key: process.env.SPEECH_KEY,
  voices: {
    en: process.env.SPEECH_VOICE_EN ?? "en-US-JennyNeural",
    sv: process.env.SPEECH_VOICE_SV ?? "sv-SE-SofieNeural",
  },
  // Jenny has a cheerful style; Sofie has none, so Swedish stays plain unless set.
  styles: { en: process.env.SPEECH_STYLE_EN ?? "cheerful", sv: process.env.SPEECH_STYLE_SV ?? "" },
  fake: process.env.TTS_FAKE === "1",
  log: (...args) => log(...args),
});

/** One JSON line per game start and finish (counts only) in DATA_DIR/usage.jsonl.
 * Console logs vanish when the app scales to zero, so the file is the record. */
function recordUsage(e: Record<string, unknown>) {
  const line = JSON.stringify(e);
  log("usage", line);
  if (persist) void appendFile(path.join(DATA_DIR, "usage.jsonl"), line + "\n").catch((err) => log("usage: write failed", err));
  statsCache = null;
}

const ROOM_PATH = /^\/parties\/main\/([a-z]{4})\/?$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Ids that would collide with Object.prototype keys in the alias table. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
/** Close codes for sockets we turn away (the error message goes first). */
const CLOSE_NO_ROOM = 4404;
const CLOSE_BUSY = 4429;
const CLOSE_SILENT = 4408;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

// ---------- usage summary (landing page) ----------

let statsCache: { at: number; value: UsageSummary } | null = null;

/** The usage summary, re-read at most once a minute. */
async function usageStats(): Promise<UsageSummary> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const text = persist ? await readFile(path.join(DATA_DIR, "usage.jsonl"), "utf8").catch(() => "") : "";
  const value = summarize(parseUsage(text));
  statsCache = { at: Date.now(), value };
  return value;
}

// ---------- storage ----------

let persist = true;

async function initStorage() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, ".write-test");
    await writeFile(probe, "ok");
    await unlink(probe);
    log(`state dir: ${DATA_DIR}`);
  } catch (err) {
    persist = false;
    log(`WARNING: ${DATA_DIR} is not writable, games will not survive a restart.`, err);
  }
}

async function sweepOldGames() {
  if (!persist) return;
  const cutoff = Date.now() - ROOM_TTL_HOURS * 3_600_000;
  for (const name of await readdir(DATA_DIR).catch(() => [] as string[])) {
    // <id>.json, its <id>.json.bak, or a <id>.json.tmp left behind by a crash mid-write.
    const m = /^([a-z]{4})\.json(\.tmp|\.bak)?$/.exec(name);
    if (!m) continue;
    const id = m[1];
    if (rooms.has(id)) continue;
    const file = path.join(DATA_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await unlink(file).catch(() => {});
      log(`deleted expired game ${id.toUpperCase()}`);
    }
  }
}

// ---------- rooms ----------

class WsConnection implements Connection {
  state: unknown = undefined;
  alive = true;
  constructor(
    readonly id: string,
    readonly ws: WebSocket,
  ) {}
  setState(state: unknown) {
    this.state = state;
  }
  send(data: string) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data);
  }
}

class RoomHost implements Room {
  readonly connections = new Set<WsConnection>();
  readonly storage: FileStorage;
  readonly game: GameRoom;
  readonly ready: Promise<void>;
  /** Serialises hook calls so the game never sees interleaved events. */
  private queue: Promise<void>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the last connection left (0 while someone is connected). */
  idleSince = Date.now();

  constructor(readonly id: string) {
    this.storage = new FileStorage(path.join(DATA_DIR, `${id}.json`), { persist: () => persist, log });
    this.game = new GameRoom(this, TIME_SCALE, speech, recordUsage);
    // If this room was just evicted, let its last save land before loading it again.
    this.ready = (closing.get(id) ?? Promise.resolve()).then(() => this.game.onStart());
    this.queue = this.ready.catch((err) => log(`room ${id} failed to start`, err));
  }

  getConnections() {
    return this.connections;
  }

  run(fn: () => void) {
    this.queue = this.queue.then(fn).catch((err) => log(`room ${this.id} error`, err));
  }

  add(conn: WsConnection) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleSince = 0;
    this.connections.add(conn);
    this.run(() => this.game.onConnect(conn));
  }

  remove(conn: WsConnection) {
    this.connections.delete(conn);
    this.run(() => this.game.onClose(conn));
    if (this.connections.size === 0) {
      this.idleSince = Date.now();
      this.idleTimer = setTimeout(() => void evict(this), IDLE_EVICT_MS);
    }
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.queue;
    this.game.dispose();
    await this.storage.flush();
  }
}

const rooms = new Map<string, RoomHost>();
/** Rooms being saved and dropped from memory, by id. */
const closing = new Map<string, Promise<void>>();
/** Recent room creations per client address. */
const created = new Map<string, number[]>();

/** Is there a saved game for this code on disk (evicted from memory, or from before a restart)? */
async function savedGame(id: string) {
  if (!persist) return false;
  for (const suffix of ["", ".bak", ".tmp"]) {
    const info = await stat(path.join(DATA_DIR, `${id}.json${suffix}`)).catch(() => null);
    if (info?.isFile()) return true;
  }
  return false;
}

/** The room in memory, or loaded from its saved game. Never makes up a new game. */
async function openRoom(id: string): Promise<RoomHost | null> {
  const live = rooms.get(id);
  if (live) return live;
  if (!closing.has(id) && !(await savedGame(id))) return null;
  return rooms.get(id) ?? makeRoom(id);
}

/** A brand new game, for a big screen. Null when this address starts too many, or the server is full. */
function createRoom(id: string, ip: string): RoomHost | null {
  const live = rooms.get(id);
  if (live) return live;
  const now = Date.now();
  const recent = (created.get(ip) ?? []).filter((t) => now - t < ROOMS_PER_IP_WINDOW_MS);
  if (recent.length >= ROOMS_PER_IP) {
    log(`refused a new room for ${ip}: ${recent.length} in the last ${ROOMS_PER_IP_WINDOW_MS / 60_000} min`);
    return null;
  }
  const room = makeRoom(id);
  if (room) created.set(ip, [...recent, now]);
  return room;
}

function makeRoom(id: string): RoomHost | null {
  if (rooms.size >= MAX_ROOMS) {
    // Full: make way by dropping the longest-idle room. It is saved, so it comes back on its next visit.
    const idle = [...rooms.values()].filter((r) => r.connections.size === 0).sort((a, b) => a.idleSince - b.idleSince)[0];
    if (!idle || !persist) {
      log(`refused a room: ${rooms.size} rooms in memory, none idle`);
      return null;
    }
    void evict(idle);
  }
  const room = new RoomHost(id);
  rooms.set(id, room);
  return room;
}

async function evict(room: RoomHost) {
  if (room.connections.size > 0 || rooms.get(room.id) !== room) return;
  rooms.delete(room.id);
  const done: Promise<void> = room.close().finally(() => {
    if (closing.get(room.id) === done) closing.delete(room.id);
  });
  closing.set(room.id, done);
  await done;
}

// Forget old creation counts now and then.
const forgetCreated = setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of created) if (times.every((t) => now - t >= ROOMS_PER_IP_WINDOW_MS)) created.delete(ip);
}, ROOMS_PER_IP_WINDOW_MS);

// ---------- static files ----------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, SECURITY_HEADERS).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain", ...SECURITY_HEADERS }).end("ok");
    return;
  }
  // Totals and averages for the landing page. Counts only, test games left out.
  if (url.pathname === "/api/stats") {
    const body = JSON.stringify(await usageStats());
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      // The dev client runs on another port; the numbers are public anyway.
      "Access-Control-Allow-Origin": "*",
      ...SECURITY_HEADERS,
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  // Spoken-prompt clips: only ones the server made (see server/tts.ts).
  if (rel.startsWith("/tts/")) {
    const clip = speech.file(rel);
    const info = clip && (await stat(clip.file).catch(() => null));
    if (!clip || !info?.isFile()) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": info.size,
      // Content-addressed, so it never changes. Room clips may hold retro content: keep them private.
      "Cache-Control": clip.scope === "lib" ? "public, max-age=31536000, immutable" : "private, max-age=86400",
      ...SECURITY_HEADERS,
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(clip.file).pipe(res);
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(STATIC_DIR, "." + rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(404, SECURITY_HEADERS).end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY_HEADERS }).end("Not found");
    return;
  }
  const hashed = rel.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

// ---------- server ----------

const http = createServer((req, res) => {
  serveStatic(req, res).catch((err) => {
    log("static error", err);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

/** The client's address. Behind the Container Apps ingress the real one is the last X-Forwarded-For entry. */
function clientIp(req: IncomingMessage) {
  const fwd = req.headers["x-forwarded-for"];
  const last = (Array.isArray(fwd) ? fwd.join(",") : (fwd ?? "")).split(",").pop()?.trim();
  return last || req.socket.remoteAddress || "?";
}

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const match = ROOM_PATH.exec(url.pathname);
  const deviceId = url.searchParams.get("_pk") ?? "";
  if (!match || !DEVICE_ID.test(deviceId) || RESERVED_IDS.has(deviceId)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const id = match[1];
  const ip = clientIp(req);
  // Refusals come before there is a room (and its language), so they follow the browser's.
  const lang = /^sv\b/i.test(req.headers["accept-language"] ?? "") ? "sv" : "en";
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = new WsConnection(deviceId, ws);
    // A socket joins a room only with its first message, and only a big screen's hello may
    // start a new game: scanning codes or holding sockets open can't fill the server with rooms.
    let room: RoomHost | null = null;
    let deciding = false;
    const early: string[] = [];
    const silent = setTimeout(() => ws.close(CLOSE_SILENT, "No hello"), HELLO_TIMEOUT_MS);
    const refuse = (message: string, code: number) => {
      conn.send(JSON.stringify({ t: "error", message }));
      ws.close(code);
    };
    const decide = async (first: string) => {
      let r = await openRoom(id);
      if (!r) {
        let kind: unknown;
        try {
          kind = (JSON.parse(first) as { t?: unknown })?.t;
        } catch {
          /* not JSON */
        }
        if (kind !== "helloHost") return refuse(strings(lang).errors.noRoom, CLOSE_NO_ROOM);
        r = createRoom(id, ip);
        if (!r) return refuse(strings(lang).errors.busy, CLOSE_BUSY);
      }
      if (ws.readyState !== ws.OPEN) return;
      const joined = r;
      room = joined;
      joined.add(conn);
      for (const text of early.splice(0)) joined.run(() => joined.game.onMessage(text, conn));
    };
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      clearTimeout(silent);
      const text = data.toString();
      const r = room;
      if (r) return r.run(() => r.game.onMessage(text, conn));
      if (early.length < 8) early.push(text);
      if (deciding) return;
      deciding = true;
      decide(text).catch((err) => {
        log(`room ${id}: could not open`, err);
        ws.terminate();
      });
    });
    ws.on("close", () => {
      clearTimeout(silent);
      room?.remove(conn);
    });
    ws.on("error", () => ws.terminate());
  });
});

// Drop dead sockets (phones that vanished) and keep proxies from idling us out.
const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const conn of room.connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }
}, 10_000); // short, so a phone that went to sleep shows as gone quickly and can be picked up again

const sweeper = setInterval(() => {
  void sweepOldGames();
  void speech.sweep(ROOM_TTL_HOURS * 3_600_000);
}, 3_600_000);

async function shutdown(signal: string) {
  log(`${signal}: saving ${rooms.size} room(s) and shutting down`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  clearInterval(forgetCreated);
  http.close();
  for (const ws of wss.clients) ws.close(1012, "Server restarting");
  await Promise.all([...rooms.values()].map((r) => r.close()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await initStorage();
await sweepOldGames();
if (persist) await speech.init().catch((err) => log("speech: cache init failed", err));
await speech.sweep(ROOM_TTL_HOURS * 3_600_000);
GameRoom.warmSpeech(speech);
http.listen(PORT, () => log(`retrolash listening on :${PORT}, static from ${STATIC_DIR}`));
