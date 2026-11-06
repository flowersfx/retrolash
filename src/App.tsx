import { useState } from "react";
import Home from "./Home";
import Host from "./Host";
import Play from "./Play";
import { makeCode, normalizeCode } from "./net";

// Routing via query string so the app works on any static host without SPA rewrites:
//   /             landing page
//   /?host=ABCD   big screen
//   /?room=ABCD   phone
function readRoute() {
  const q = new URLSearchParams(location.search);
  const host = q.get("host");
  const room = q.get("room");
  if (host) return { kind: "host" as const, code: normalizeCode(host) };
  if (room !== null) return { kind: "play" as const, code: normalizeCode(room) };
  return { kind: "home" as const, code: "" };
}

export default function App() {
  const [route, setRoute] = useState(readRoute);

  const go = (kind: "host" | "play", code: string) => {
    const url = kind === "host" ? `?host=${code}` : `?room=${code}`;
    history.pushState(null, "", url);
    setRoute({ kind, code });
  };

  if (route.kind === "host" && route.code.length === 4) return <Host code={route.code} />;
  if (route.kind === "play") return <Play initialCode={route.code} />;
  return (
    <Home
      onHost={() => go("host", makeCode())}
      onJoin={(code) => go("play", code)}
    />
  );
}
