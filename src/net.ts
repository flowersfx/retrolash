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

/** Stable per-tab device id, so a reload rejoins as the same player. */
export function deviceId(code: string) {
  const key = `retrolash:id:${code}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Reuse an earlier id in this tab ("Continue as …" after the tab was closed). */
export function setDeviceId(code: string, id: string) {
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
  hello: ClientMessage | null,
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
  const helloKey = hello ? JSON.stringify(hello) : null;

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
      if (helloRef.current) ws.send(JSON.stringify(helloRef.current));
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
    return () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("message", onMessage);
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
