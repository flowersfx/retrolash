// Retrolash runtime: one Node process that serves the built client (dist/)
// and hosts every game room over WebSockets. Designed for a single replica
// (Azure Container Apps with maxReplicas 1). Room state lives in memory and is
// mirrored to DATA_DIR so a restart or scale-to-zero resumes games.
//
// WebSocket URL (what partysocket uses): /parties/main/<room>?_pk=<deviceId>

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GameRoom, type Connection, type Room, type RoomStorage } from "./game";

const PORT = Number(process.env.PORT ?? 1999);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");
/** Saved games older than this are deleted (data minimisation). */
const ROOM_TTL_HOURS = Number(process.env.ROOM_TTL_HOURS ?? 24);
/** Drop a room from memory after this long with nobody connected. */
const IDLE_EVICT_MS = 30 * 60_000;
const MAX_ROOMS = 200;
const STATIC_DIR =
  process.env.STATIC_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const ROOM_PATH = /^\/parties\/main\/([a-z]{4})\/?$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

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

/** File-backed storage for one room. Writes are coalesced and atomic. */
class FileStorage implements RoomStorage {
  private cache = new Map<string, unknown>();
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly file: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (persist && this.cache.size === 0) {
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
      } catch {
        // No saved state yet, or unreadable: start fresh.
      }
    }
    return this.cache.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): Promise<void> {
    // Snapshot now: the game mutates its state object in place.
    this.cache.set(key, structuredClone(value));
    if (!persist) return Promise.resolve();
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
        await rename(tmp, this.file);
      }
    } catch (err) {
      log(`failed to save ${path.basename(this.file)}`, err);
    } finally {
      this.pending = null;
    }
  }
}

async function sweepOldGames() {
  if (!persist) return;
  const cutoff = Date.now() - ROOM_TTL_HOURS * 3_600_000;
  for (const name of await readdir(DATA_DIR).catch(() => [] as string[])) {
    // <id>.json, or a <id>.json.tmp left behind by a crash mid-write.
    const m = /^([a-z]{4})\.json(\.tmp)?$/.exec(name);
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

  constructor(readonly id: string) {
    this.storage = new FileStorage(path.join(DATA_DIR, `${id}.json`));
    this.game = new GameRoom(this);
    this.ready = this.game.onStart();
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
    this.connections.add(conn);
    this.run(() => this.game.onConnect(conn));
  }

  remove(conn: WsConnection) {
    this.connections.delete(conn);
    this.run(() => this.game.onClose(conn));
    if (this.connections.size === 0) {
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

function getRoom(id: string): RoomHost | null {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = new RoomHost(id);
    rooms.set(id, room);
  }
  return room;
}

async function evict(room: RoomHost) {
  if (room.connections.size > 0) return;
  rooms.delete(room.id);
  await room.close();
}

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
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
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

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const match = ROOM_PATH.exec(url.pathname);
  const deviceId = url.searchParams.get("_pk") ?? "";
  const room = match && DEVICE_ID.test(deviceId) ? getRoom(match[1]) : null;
  if (!room) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = new WsConnection(deviceId, ws);
    room.add(conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      room.run(() => room.game.onMessage(text, conn));
    });
    ws.on("close", () => room.remove(conn));
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
}, 25_000);

const sweeper = setInterval(() => void sweepOldGames(), 3_600_000);

async function shutdown(signal: string) {
  log(`${signal}: saving ${rooms.size} room(s) and shutting down`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  http.close();
  for (const ws of wss.clients) ws.close(1012, "Server restarting");
  await Promise.all([...rooms.values()].map((r) => r.close()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await initStorage();
await sweepOldGames();
http.listen(PORT, () => log(`retrolash listening on :${PORT}, static from ${STATIC_DIR}`));
