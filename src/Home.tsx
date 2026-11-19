import { useEffect, useState } from "react";
import { PARTY_HOST, normalizeCode } from "./net";
import { BigScreenArt, PhoneArt } from "./Illustrations";

export default function Home({
  onHost,
  onJoin,
}: {
  onHost: () => void;
  onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <main className="home">
      <h1 className="logo">
        Retro<span>lash</span>
      </h1>
      <p className="tagline">
        A party game for sprint retrospectives. One big screen, everyone's phones.
      </p>
      <div className="home-cards">
        <section className="card">
          <BigScreenArt />
          <h2>On the meeting-room screen</h2>
          <p>Start a room and put it on the big screen. Everyone joins with their phone.</p>
          <button className="btn big" onClick={onHost}>
            Host a retro
          </button>
        </section>
        <section className="card">
          <PhoneArt />
          <h2>On your phone</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 4) onJoin(code);
            }}
          >
            <input
              className="code-input"
              placeholder="ROOM CODE"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
            />
            <button className="btn big" disabled={code.length !== 4}>
              Join
            </button>
          </form>
        </section>
      </div>
      <UsageLine />
    </main>
  );
}

type Meter = {
  speech: { chars: number; free: number; share: number; paused?: boolean };
  runtime: { hours: number; free: number; share: number };
};
type Stats = {
  games: number;
  thisMonth: number;
  players: number;
  minutes: number;
  actionItems: number;
  ownedShare: number;
  kudos: number;
  meter?: Meter;
};

/** 0.0042 → "0.4%", 0.27 → "27%". */
const pct = (share: number) => {
  const p = share * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
};
const num = (n: number) => n.toLocaleString("en-US");

/** Quiet lines with the running totals and this month's free-tier use (from /api/stats). Nothing until there's something to show. */
function UsageLine() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const base = import.meta.env.DEV ? `${location.protocol}//${PARTY_HOST}` : "";
    fetch(`${base}/api/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((x: Stats | null) => x && setS(x))
      .catch(() => {});
  }, []);
  if (!s) return null;
  const games =
    s.games > 0
      ? [
          `${s.games} ${s.games === 1 ? "retro" : "retros"} played`,
          s.thisMonth ? `${s.thisMonth} this month` : null,
          `${Math.round(s.players)} players and ${Math.round(s.minutes)} min on average`,
          s.actionItems ? `${s.actionItems} action items (${Math.round(s.ownedShare * 100)}% owned)` : null,
          s.kudos ? `${s.kudos} kudos` : null,
        ].filter(Boolean)
      : [];
  const m = s.meter;
  const free = m
    ? [
        `${m.runtime.hours.toFixed(1)} h server time (${pct(m.runtime.share)} of the free ${num(m.runtime.free)} h)`,
        m.speech.chars
          ? `${num(m.speech.chars)} speech characters (${pct(m.speech.share)} of the free ${num(m.speech.free)}${m.speech.paused ? "; reading answers aloud is paused until next month" : ""})`
          : null,
      ].filter(Boolean)
    : [];
  return (
    <>
      {games.length > 0 && <p className="usage-line">{games.join(" · ")}</p>}
      {free.length > 0 && <p className="usage-line">This month: {free.join(" · ")}</p>}
    </>
  );
}
