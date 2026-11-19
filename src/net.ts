import { useEffect, useMemo, useRef, useState } from "react";
import PartySocket from "partysocket";
import type { ClientMessage, HostView, PlayerView, ServerMessage } from "../shared/types";

/**
 * Where the game server lives. In production the Node server serves the app
 * itself, so it's the same origin. In dev, Vite runs on :5173 and the game
 * server on :1999. VITE_GAME_HOST overrides both (bare host or full URL).
 */
const configuredHost = (import.meta.env.VITE_GAME_HOST as string | undefined)
  ?.trim()
  .replace(/^[a-z]+:\/\//i, "")
  .replace(/\/+$/, "");

export const PARTY_HOST: string =
  configuredHost ||
  (import.meta.env.DEV ? `${location.hostname}:1999` : location.host);

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++)
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(s: string) {
  return s.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

/** Who this browser last was in a room, so a new tab (or a phone that dropped the tab) picks up where it left off. */
export type LastIdentity = { id: string; name: string; audience: boolean; avatar?: string; at: number };
export const REJOIN_MAX_AGE = 12 * 3600 * 1000;
const lastKey = (code: string) => `retrolash:last:${code}`;

export function lastIdentity(code: string): LastIdentity | null {
  try {
    const raw = localStorage.getItem(lastKey(code));
    const last = raw ? (JSON.parse(raw) as LastIdentity) : null;
    return last && typeof last.id === "string" && Date.now() - last.at < REJOIN_MAX_AGE ? last : null;
  } catch {
    return null;
  }
}

export function setLastIdentity(code: string, last: LastIdentity | null) {
  try {
    if (last) localStorage.setItem(lastKey(code), JSON.stringify(last));
    else localStorage.removeItem(lastKey(code));
  } catch {
    /* private mode */
  }
}

/** One fallback id per page load when storage is blocked, so reconnects keep the same identity. */
let memoryId: string | null = null;

/**
 * Stable device id, so a reload rejoins as the same player. Per tab (so one
 * browser can test several players), falling back to the last identity in this
 * room when the tab is new: mobile browsers often throw away a sleeping tab.
 */
export function deviceId(code: string) {
  const key = `retrolash:id:${code}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = lastIdentity(code)?.id ?? crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    memoryId ??= lastIdentity(code)?.id ?? crypto.randomUUID();
    return memoryId;
  }
}

/** Reuse an earlier id in this tab ("Continue as …" after the tab was closed). */
export function setDeviceId(code: string, id: string) {
  memoryId = id;
  try {
    sessionStorage.setItem(`retrolash:id:${code}`, id);
  } catch {
    /* private mode */
  }
}

type View = HostView | PlayerView;

export type RoomEvent = Exclude<ServerMessage, { t: "view" } | { t: "error" }>;

export function useRoom<V extends View>(
  code: string | null,
  /** Sent on every (re)connect. A function is called each time, so it can read fresh state (the host token). */
  hello: ClientMessage | (() => ClientMessage) | null,
  onEvent?: (e: RoomEvent) => void,
) {
  const [view, setView] = useState<V | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<PartySocket | null>(null);
  const helloRef = useRef(hello);
  helloRef.current = hello;
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const helloKey = typeof hello === "function" ? "fn" : hello ? JSON.stringify(hello) : null;

  useEffect(() => {
    if (!code || !helloKey) return;
    const ws = new PartySocket({
      host: PARTY_HOST,
      room: code.toLowerCase(),
      id: deviceId(code),
    });
    socketRef.current = ws;
    const onOpen = () => {
      setConnected(true);
      const h = helloRef.current;
      const msg = typeof h === "function" ? h() : h;
      if (msg) ws.send(JSON.stringify(msg));
    };
    const onClose = () => setConnected(false);
    const onMessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.t === "view") {
        setView(msg.view as V);
        setReceivedAt(Date.now());
        setError(null);
      } else if (msg.t === "error") {
        setError(msg.message);
      } else {
        eventRef.current?.(msg);
      }
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("message", onMessage);

    // A phone that slept often keeps a socket that looks open but is dead, and the
    // reconnect backoff may be long by then. Coming back to the page reconnects now.
    // An open-looking socket is checked first instead of being dropped: a needless
    // reconnect briefly makes the player "offline" (switching tabs did that in v0.6).
    let hiddenAt = 0;
    let probe: ReturnType<typeof setTimeout> | null = null;
    const answered = () => {
      if (probe) clearTimeout(probe);
      probe = null;
    };
    ws.addEventListener("message", answered);
    const wake = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      if (ws.readyState !== WebSocket.OPEN) return ws.reconnect();
      if (away < 15_000 || probe) return;
      // Saying hello again is harmless and the server always answers with a view.
      const h = helloRef.current;
      const msg = typeof h === "function" ? h() : h;
      if (!msg) return;
      ws.send(JSON.stringify(msg));
      probe = setTimeout(() => {
        probe = null;
        ws.reconnect();
      }, 4000);
    };
    const onPageShow = (e: PageTransitionEvent) => e.persisted && ws.reconnect();
    const onOnline = () => ws.readyState !== WebSocket.OPEN && ws.reconnect();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("message", answered);
      answered();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      ws.close();
      socketRef.current = null;
    };
  }, [code, helloKey]);

  const send = useMemo(
    () => (msg: ClientMessage) => socketRef.current?.send(JSON.stringify(msg)),
    [],
  );

  return { view, receivedAt, error, connected, send };
}

/** Seconds left on the server timer, ticking locally. */
export function useCountdown(remainingMs: number | null | undefined, receivedAt: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (remainingMs == null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [remainingMs, receivedAt]);
  if (remainingMs == null) return null;
  return Math.max(0, Math.ceil((remainingMs - (now - receivedAt)) / 1000));
}

export function joinUrl(code: string) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

/** An extra big screen for the same game (another room, or someone remote). */
export function screenUrl(code: string) {
  return `${location.origin}${location.pathname}?screen=${code}`;
}
