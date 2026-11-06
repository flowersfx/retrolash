import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { joinUrl, useCountdown, useRoom } from "./net";
import { summaryToMarkdown } from "./summary";
import {
  MIN_PLAYERS,
  ROUND_TITLES,
  type ClientMessage,
  type HostView,
  type MatchupView,
  type PublicPlayer,
  type RoundKind,
  type Settings,
} from "../shared/types";

const ROUND_BLURBS: Record<RoundKind, string> = {
  warmup: "Pure nonsense to get the brain going. Answer the prompts on your phone — funniest answer wins.",
  retro: "Same game, but about the sprint. Be honest, be funny. We'll pause to talk after each matchup.",
  lastlash: "Everyone answers the same prompt. Then vote for the ideas we should actually do.",
};

export default function Host({ code }: { code: string }) {
  const hello = useMemo<ClientMessage>(() => ({ t: "helloHost" }), []);
  const { view, receivedAt, connected, send } = useRoom<HostView>(code, hello);
  const seconds = useCountdown(view?.remainingMs, receivedAt);

  // Space / → advances, like a presenter clicker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === " " || e.key === "ArrowRight") && view && view.phase !== "lobby") {
        e.preventDefault();
        send({ t: "next" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, send]);

  if (!view) {
    return (
      <main className="host center">
        <p className="muted">{connected ? "Setting up room…" : "Connecting…"}</p>
      </main>
    );
  }

  return (
    <main className={`host phase-${view.phase} kind-${view.roundKind ?? "none"}`}>
      <header className="host-header">
        <div className="logo small">
          Retro<span>lash</span>
        </div>
        {view.phase !== "lobby" && view.phase !== "summary" && (
          <div className="round-pill">
            Round {view.roundNumber}/{view.roundCount} · {view.roundTitle}
          </div>
        )}
        <div className="header-right">
          {seconds !== null && <Timer seconds={seconds} />}
          <div className="code-chip" title={joinUrl(code)}>
            {location.host}/?room=<b>{code}</b>
          </div>
          {!connected && <span className="offline">reconnecting…</span>}
        </div>
      </header>

      <section className="host-body">
        <Stage view={view} send={send} />
      </section>

      {view.phase !== "lobby" && (
        <footer className="host-footer">
          <PlayerStrip view={view} />
          <div className="controls">
            {view.phase === "summary" ? (
              <button className="btn ghost" onClick={() => send({ t: "restart" })}>
                Back to lobby
              </button>
            ) : (
              <button className="btn" onClick={() => send({ t: "next" })}>
                {nextLabel(view)} <kbd>space</kbd>
              </button>
            )}
            <FullscreenButton />
          </div>
        </footer>
      )}
    </main>
  );
}

function nextLabel(v: HostView) {
  switch (v.phase) {
    case "answering":
    case "voting":
    case "lashVoting":
      return "Skip timer";
    case "matchupResult":
      return v.matchupNumber === v.matchupCount ? "Finish round" : "Next matchup";
    case "roundResult":
    case "lashResult":
      return v.roundNumber === v.roundCount ? "Show summary" : "Next round";
    default:
      return "Next";
  }
}

function Stage({ view, send }: { view: HostView; send: (m: ClientMessage) => void }) {
  switch (view.phase) {
    case "lobby":
      return <Lobby view={view} send={send} />;
    case "roundIntro":
      return (
        <div className="intro">
          <div className="intro-num">Round {view.roundNumber}</div>
          <h1 className="intro-title">{view.roundTitle}</h1>
          <p className="intro-blurb">{view.roundKind && ROUND_BLURBS[view.roundKind]}</p>
        </div>
      );
    case "answering":
      return (
        <div className="answering">
          <h1 className="huge">Answer on your phones 📱</h1>
          {view.roundKind === "lastlash" ? (
            <p className="prompt-big">{view.lashPrompt}</p>
          ) : (
            <p className="muted big-text">
              Everyone gets two prompts. Your answers go head-to-head with someone else's.
            </p>
          )}
          <DoneGrid view={view} />
        </div>
      );
    case "voting":
    case "matchupResult":
      return view.matchup ? (
        <Matchup
          m={view.matchup}
          reveal={view.phase === "matchupResult"}
          number={view.matchupNumber!}
          count={view.matchupCount!}
          discuss={view.phase === "matchupResult" && view.roundKind === "retro"}
        />
      ) : null;
    case "roundResult":
      return <RoundResult view={view} />;
    case "lashVoting":
    case "lashResult":
      return <Lash view={view} />;
    case "summary":
      return <Summary view={view} />;
  }
}

// ---------- lobby ----------

function Lobby({ view, send }: { view: HostView; send: (m: ClientMessage) => void }) {
  const url = joinUrl(view.code);
  const connectedCount = view.players.filter((p) => p.connected).length;
  const canStart = connectedCount >= MIN_PLAYERS && view.settings.rounds.length > 0;
  return (
    <div className="lobby">
      <div className="join-panel">
        <p className="join-label">Join on your phone</p>
        <div className="qr">
          <QRCodeSVG value={url} size={260} marginSize={2} />
        </div>
        <p className="join-url">{location.host}</p>
        <p className="join-label">Room code</p>
        <div className="room-code">{view.code}</div>
      </div>

      <div className="lobby-main">
        <h2>
          Players <span className="muted">({connectedCount})</span>
        </h2>
        <div className="player-grid">
          {view.players.length === 0 && (
            <p className="muted">Waiting for people to join…</p>
          )}
          {view.players.map((p) => (
            <div key={p.id} className={`player-tile ${p.connected ? "" : "dim"}`}>
              <span className="avatar">{p.avatar}</span>
              <span className="pname">{p.name}</span>
              <button
                className="kick"
                title="Remove player"
                onClick={() => send({ t: "kick", playerId: p.id })}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <SettingsPanel settings={view.settings} send={send} />

        <div className="start-row">
          <button
            className="btn big"
            disabled={!canStart}
            onClick={() => send({ t: "start" })}
          >
            Start the retro
          </button>
          {connectedCount < MIN_PLAYERS && (
            <span className="muted">Need at least {MIN_PLAYERS} players</span>
          )}
          <FullscreenButton />
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  send,
}: {
  settings: Settings;
  send: (m: ClientMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(settings.customPrompts.join("\n"));
  const [lash, setLash] = useState(settings.lashPrompt);
  useEffect(() => setLash(settings.lashPrompt), [settings.lashPrompt]);

  const update = (s: Partial<Settings>) => send({ t: "settings", settings: s });
  const order: RoundKind[] = ["warmup", "retro", "lastlash"];
  const toggleRound = (k: RoundKind) => {
    const has = settings.rounds.includes(k);
    const next = order.filter((r) => (r === k ? !has : settings.rounds.includes(r)));
    update({ rounds: next });
  };

  return (
    <div className="settings">
      <div className="settings-summary">
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.anonymous}
            onChange={(e) => update({ anonymous: e.target.checked })}
          />
          <span>
            <b>Anonymous mode</b> — hide authors and scores
          </span>
        </label>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>
          {open ? "Hide settings" : "More settings"}
        </button>
      </div>
      <div className="rounds-row">
        {order.map((k) => (
          <label key={k} className={`round-chip ${settings.rounds.includes(k) ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={settings.rounds.includes(k)}
              onChange={() => toggleRound(k)}
            />
            {ROUND_TITLES[k]}
          </label>
        ))}
      </div>
      {open && (
        <div className="settings-grid">
          <label>
            Answer time (s)
            <input
              type="number"
              min={20}
              max={300}
              value={settings.answerSeconds}
              onChange={(e) => update({ answerSeconds: +e.target.value })}
            />
          </label>
          <label>
            Vote time (s)
            <input
              type="number"
              min={10}
              max={120}
              value={settings.voteSeconds}
              onChange={(e) => update({ voteSeconds: +e.target.value })}
            />
          </label>
          <label>
            Action-item answers per person
            <input
              type="number"
              min={1}
              max={3}
              value={settings.lashMaxAnswers}
              onChange={(e) => update({ lashMaxAnswers: +e.target.value })}
            />
          </label>
          <label>
            Action-item votes per person
            <input
              type="number"
              min={1}
              max={5}
              value={settings.lashVotes}
              onChange={(e) => update({ lashVotes: +e.target.value })}
            />
          </label>
          <label className="wide">
            Final round prompt
            <input
              value={lash}
              onChange={(e) => setLash(e.target.value)}
              onBlur={() => update({ lashPrompt: lash })}
            />
          </label>
          <label className="wide">
            Your own retro prompts (one per line, used first in “The Sprint”)
            <textarea
              rows={4}
              value={custom}
              placeholder={"Our release process, as a horror movie title\nThe one ticket that haunted us"}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() =>
                update({
                  customPrompts: custom
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------- in-game pieces ----------

function Timer({ seconds }: { seconds: number }) {
  return <div className={`timer ${seconds <= 10 ? "urgent" : ""}`}>{seconds}</div>;
}

function DoneGrid({ view }: { view: HostView }) {
  const done = new Set(view.doneIds);
  const players = view.players.filter((p) => view.expectedIds.includes(p.id));
  return (
    <div className="done-grid">
      {players.map((p) => (
        <div key={p.id} className={`done-tile ${done.has(p.id) ? "done" : ""}`}>
          <span className="avatar">{p.avatar}</span>
          <span className="pname">{p.name}</span>
          <span className="check">{done.has(p.id) ? "✓" : "…"}</span>
        </div>
      ))}
    </div>
  );
}

function PlayerStrip({ view }: { view: HostView }) {
  const done = new Set(view.doneIds);
  const expected = new Set(view.expectedIds);
  return (
    <div className="player-strip">
      {view.players.map((p) => (
        <span
          key={p.id}
          className={`strip-av ${!p.connected ? "dim" : ""} ${
            expected.has(p.id) ? (done.has(p.id) ? "done" : "waiting") : ""
          }`}
          title={p.name}
        >
          {p.avatar}
        </span>
      ))}
    </div>
  );
}

function Matchup({
  m,
  reveal,
  number,
  count,
  discuss,
}: {
  m: MatchupView;
  reveal: boolean;
  number: number;
  count: number;
  discuss: boolean;
}) {
  const total = (m.votes?.[0] ?? 0) + (m.votes?.[1] ?? 0);
  const winner =
    reveal && m.votes && m.votes[0] !== m.votes[1] ? (m.votes[0] > m.votes[1] ? 0 : 1) : null;
  return (
    <div className="matchup">
      <div className="matchup-count muted">
        Matchup {number} of {count}
      </div>
      <h1 className="prompt-big">{m.prompt}</h1>
      <div className="versus">
        {[0, 1].map((i) => {
          const votes = m.votes?.[i] ?? 0;
          const pct = total ? Math.round((votes / total) * 100) : 0;
          return (
            <div
              key={i}
              className={`answer-card side-${i} ${reveal ? "revealed" : ""} ${
                winner === i ? "winner" : ""
              } ${winner !== null && winner !== i ? "loser" : ""}`}
            >
              <p className="answer-text">
                {m.answers[i] || <span className="muted">🦗 no answer</span>}
              </p>
              {reveal && (
                <div className="result">
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="result-line">
                    <b>{votes}</b> vote{votes === 1 ? "" : "s"} · {pct}%
                    {m.points && <span className="points">+{m.points[i]}</span>}
                  </div>
                  {m.authors && <div className="author">— {m.authors[i]}</div>}
                  {m.voterNames && m.voterNames[i].length > 0 && (
                    <div className="voters muted">{m.voterNames[i].join(", ")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="vs">VS</div>
      </div>
      {reveal && m.unanimous && <div className="banner">RETROLASH! 💥</div>}
      {!reveal && <p className="muted big-text">Vote on your phone for your favourite</p>}
      {discuss && <p className="discuss">💬 Anything to talk about here? Hit next when you're ready.</p>}
    </div>
  );
}

function RoundResult({ view }: { view: HostView }) {
  const anonymous = view.settings.anonymous;
  const ranked = [...view.players].sort((a, b) => b.score - a.score);
  return (
    <div className="round-result">
      <h1 className="huge">{view.roundTitle} — done!</h1>
      {anonymous ? (
        <p className="muted big-text">
          Anonymous mode is on, so no scores. The answers are saved for the summary.
        </p>
      ) : (
        <Scoreboard players={ranked} />
      )}
    </div>
  );
}

function Scoreboard({ players }: { players: PublicPlayer[] }) {
  const max = Math.max(1, ...players.map((p) => p.score));
  return (
    <ol className="scoreboard">
      {players.map((p, i) => (
        <li key={p.id}>
          <span className="rank">{i + 1}</span>
          <span className="avatar">{p.avatar}</span>
          <span className="pname">{p.name}</span>
          <span className="score-bar">
            <span style={{ width: `${(p.score / max) * 100}%` }} />
          </span>
          <span className="score">{p.score}</span>
        </li>
      ))}
    </ol>
  );
}

function Lash({ view }: { view: HostView }) {
  const reveal = view.phase === "lashResult";
  const answers = view.lashAnswers ?? [];
  const max = Math.max(1, ...answers.map((a) => a.votes ?? 0));
  return (
    <div className="lash">
      <h1 className="prompt-big">{view.lashPrompt}</h1>
      {!reveal && <p className="muted big-text">Pick your favourites on your phone</p>}
      <div className={`lash-list ${reveal ? "ranked" : ""}`}>
        {answers.map((a, i) => (
          <div key={a.id} className={`lash-item ${reveal && i < 3 && (a.votes ?? 0) > 0 ? "top" : ""}`}>
            {reveal && <span className="lash-votes">{a.votes}</span>}
            <span className="lash-text">{a.text}</span>
            {a.author && <span className="author">— {a.author}</span>}
            {reveal && (
              <span className="lash-bar" style={{ width: `${((a.votes ?? 0) / max) * 100}%` }} />
            )}
          </div>
        ))}
      </div>
      {!reveal && <DoneGrid view={view} />}
    </div>
  );
}

function Summary({ view }: { view: HostView }) {
  const [copied, setCopied] = useState(false);
  const md = summaryToMarkdown(view);
  const lash = view.summary?.find((r) => r.kind === "lastlash");
  const actionItems = (lash?.lashAnswers ?? []).filter((a) => (a.votes ?? 0) > 0);
  const retro = view.summary?.find((r) => r.kind === "retro");
  const ranked = [...view.players].sort((a, b) => b.score - a.score);

  const download = () => {
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `retro-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="summary">
      <h1 className="huge">That's a wrap 🎬</h1>
      <div className="summary-cols">
        <section>
          <h2>Action items</h2>
          {actionItems.length === 0 ? (
            <p className="muted">No action-item round this time.</p>
          ) : (
            <ol className="action-list">
              {actionItems.map((a) => (
                <li key={a.id}>
                  <span className="lash-votes">{a.votes}</span> {a.text}
                </li>
              ))}
            </ol>
          )}
          {retro && retro.matchups.length > 0 && (
            <>
              <h2>From the sprint</h2>
              <ul className="sprint-list">
                {retro.matchups.map((m) => (
                  <li key={m.id}>
                    <b>{m.prompt}</b>
                    {m.answers.map((a, i) =>
                      a ? (
                        <div key={i} className="muted">
                          {a} <span className="vote-count">({m.votes?.[i] ?? 0})</span>
                        </div>
                      ) : null,
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        {!view.settings.anonymous && (
          <section>
            <h2>Final scores</h2>
            <Scoreboard players={ranked} />
          </section>
        )}
      </div>
      <div className="start-row">
        <button
          className="btn"
          onClick={async () => {
            await navigator.clipboard.writeText(md);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied ✓" : "Copy as Markdown"}
        </button>
        <button className="btn ghost" onClick={download}>
          Download .md
        </button>
      </div>
    </div>
  );
}

function FullscreenButton() {
  if (!document.fullscreenEnabled) return null;
  return (
    <button
      className="btn ghost small"
      onClick={() =>
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      }
    >
      ⛶ Fullscreen
    </button>
  );
}
