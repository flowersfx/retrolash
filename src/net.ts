import { useEffect, useMemo, useRef, useState } from "react";
import PartySocket from "partysocket";
import type { ClientMessage, HostView, PlayerView, ServerMessage } from "../shared/types";

/**
 * Where the PartyKit server lives. When the frontend is hosted elsewhere
 * (e.g. Vercel), VITE_PARTYKIT_HOST is set at build time. Otherwise it is the
 * same origin, because PartyKit serves the app itself.
 */
const configuredHost = (import.meta.env.VITE_PARTYKIT_HOST as string | undefined)
  ?.trim()
  // Tolerate a pasted URL ("https://x.partykit.dev/") as well as a bare host.
  .replace(/^[a-z]+:\/\//i, "")
  .replace(/\/+$/, "");

export const PARTY_HOST: string =
  configuredHost ||
  (import.meta.env.DEV ? `${location.hostname}:1999` : location.host);

if (!configuredHost && !import.meta.env.DEV && location.hostname.endsWith(".vercel.app")) {
  console.error(
    "Retrolash: VITE_PARTYKIT_HOST is not set for this build, so the game server " +
      "cannot be reached. Set it in Vercel's environment variables and redeploy.",
  );
}

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
function deviceId(code: string) {
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

type View = HostView | PlayerView;

export function useRoom<V extends View>(
  code: string | null,
  hello: ClientMessage | null,
) {
  const [view, setView] = useState<V | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<PartySocket | null>(null);
  const helloRef = useRef(hello);
  helloRef.current = hello;
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
