import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { joinUrl, useCountdown, useRoom, type RoomEvent } from "./net";
import { summaryToMarkdown } from "./summary";
import {
  onSoundChange,
  setSoundEnabled,
  sfx,
  soundEnabled,
  soundReady,
  unlockAudio,
} from "./sound";
import {
  FOLLOWUP_OPTIONS,
  MIN_PLAYERS,
  MOODS,
  ROUND_TITLES,
  TOGGLEABLE_ROUNDS,
  autoSprintRounds,
  isHeadToHead,
  parsePreviousItems,
  type ClientMessage,
  type FollowupItemView,
  type HostView,
  type LashAnswerView,
  type MatchupView,
  type PublicPlayer,
  type RoundKind,
  type Settings,
} from "../shared/types";
import { COMMENTARY, DISCUSSION_QUESTIONS, pick } from "../shared/prompts";

type Send = (m: ClientMessage) => void;

const ROUND_BLURBS: Record<RoundKind, string> = {
  checkin: "Quick weather report: how did this sprint feel? Pick one on your phone. It's anonymous.",
  followup: "Before we look ahead: did we actually do last retro's action items?",
  warmup: "Pure nonsense to get the brain going. Answer the prompts on your phone. Funniest answer wins.",
  emoji: "Words are banned. Answer with emoji only. 🤐",
  retro: "Same game, but about the sprint. Be honest, be funny. We'll pause to talk after each matchup.",
  lastlash: "Everyone answers the same prompt. Then vote for the ideas we should actually do.",
};

interface FloatingReaction {
  id: number;
  emoji: string;
  avatar?: string;
  x: number;
}

export default function Host({ code }: { code: string }) {
  const hello = useMemo<ClientMessage>(() => ({ t: "helloHost" }), []);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const nextId = useRef(0);
  const lastPop = useRef(0);
  const onEvent = useCallback((e: RoomEvent) => {
    if (e.t !== "reaction") return;
    const id = nextId.current++;
    setReactions((r) => [...r.slice(-40), { id, emoji: e.emoji, avatar: e.avatar, x: 5 + Math.random() * 90 }]);
    setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3200);
    if (Date.now() - lastPop.current > 150) {
      lastPop.current = Date.now();
      sfx.pop();
    }
  }, []);
  const { view, receivedAt, connected, send } = useRoom<HostView>(code, hello, onEvent);
  const seconds = useCountdown(view?.remainingMs, receivedAt);

  // Browsers only allow sound after a gesture: unlock on the first click/key.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Space / → advances (presenter clicker). P holds the timer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!view || view.phase === "lobby") return;
      if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        send({ t: "next" });
      } else if (e.key === "p" || e.key === "P") {
        send({ t: "hold" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, send]);

  usePhaseSounds(view, seconds);

  if (!view) {
    return (
      <main className="host center">
        <p className="muted">{connected ? "Setting up room…" : "Connecting…"}</p>
      </main>
    );
  }

  const paused = view.pausedMs !== null;
  const canHold = view.remainingMs !== null || paused;

  return (
    <main className={`host phase-${view.phase} kind-${view.roundKind ?? "none"}`}>
      <header className="host-header">
        <div className="logo small">
          Retro<span>lash</span>
        </div>
        {view.phase !== "lobby" && view.phase !== "summary" && (
          <div className="round-pill" key={view.roundTitle}>
            Round {view.roundNumber}/{view.roundCount} · {view.roundTitle}
          </div>
        )}
        <div className="header-right">
          {paused ? (
            <div className="timer paused" title="On hold (press P to resume)">
              ⏸ {Math.ceil((view.pausedMs ?? 0) / 1000)}
            </div>
          ) : (
            seconds !== null &&
            view.phase !== "roundIntro" && (
              <Timer seconds={seconds} urgent={["answering", "voting", "lashVoting"].includes(view.phase)} />
            )
          )}
          <div className="code-chip" title={joinUrl(code)}>
            {location.host}/?room=<b>{code}</b>
          </div>
          <SoundToggle />
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
              <>
                {canHold && (
                  <button className="btn ghost" onClick={() => send({ t: "hold" })}>
                    {paused ? "▶ Resume" : "⏸ Hold"} <kbd>P</kbd>
                  </button>
                )}
                <button className="btn" onClick={() => send({ t: "next" })}>
                  {nextLabel(view)} <kbd>space</kbd>
                </button>
              </>
            )}
            <FullscreenButton />
          </div>
        </footer>
      )}

      <div className="reaction-layer" aria-hidden>
        {reactions.map((r) => (
          <span key={r.id} className="float-reaction" style={{ left: `${r.x}%` }}>
            {r.emoji}
            {r.avatar && <small>{r.avatar}</small>}
          </span>
        ))}
      </div>
    </main>
  );
}

/** Phase-level sounds; the matchup and Last Lash reveals do their own. */
function usePhaseSounds(view: HostView | null, seconds: number | null) {
  const key = view ? `${view.phase}:${view.roundNumber}:${view.matchupNumber ?? ""}` : "";
  useEffect(() => {
    if (!view) return;
    switch (view.phase) {
      case "roundIntro":
        sfx.intro();
        break;
      case "voting":
        sfx.whoosh(0.5);
        sfx.whoosh(1.1);
        break;
      case "answering":
      case "lashVoting":
        sfx.whoosh();
        break;
      case "pollResult":
      case "roundResult":
        sfx.sting(0.2);
        break;
      case "summary":
        sfx.fanfare(0.3);
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const timed = view && ["answering", "voting", "lashVoting"].includes(view.phase);
  useEffect(() => {
    if (timed && seconds !== null && seconds > 0 && seconds <= 5) sfx.tick(seconds <= 3);
  }, [seconds, timed]);
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
    case "pollResult":
    case "lashResult":
      return v.roundNumber === v.roundCount ? "Show summary" : "Next round";
    default:
      return "Next";
  }
}

function Stage({ view, send }: { view: HostView; send: Send }) {
  switch (view.phase) {
    case "lobby":
      return <Lobby view={view} send={send} />;
    case "roundIntro":
      return <Intro view={view} />;
    case "answering":
      return <Answering view={view} />;
    case "voting":
    case "matchupResult":
      return view.matchup ? (
        <Matchup
          key={view.matchup.id}
          m={view.matchup}
          kind={view.roundKind}
          reveal={view.phase === "matchupResult"}
          number={view.matchupNumber!}
          count={view.matchupCount!}
        />
      ) : null;
    case "pollResult":
      return view.roundKind === "checkin" ? (
        <MoodResult counts={view.moodCounts ?? []} />
      ) : (
        <FollowupResult items={view.followupItems ?? []} />
      );
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

function Lobby({ view, send }: { view: HostView; send: Send }) {
  const url = joinUrl(view.code);
  const players = view.players.filter((p) => !p.audience);
  const audience = view.players.filter((p) => p.audience);
  const connectedCount = players.filter((p) => p.connected).length;
  const canStart = connectedCount >= MIN_PLAYERS && view.plan.length > 0;
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
          {players.length === 0 && <p className="muted">Waiting for people to join…</p>}
          {players.map((p) => (
            <div key={p.id} className={`player-tile ${p.connected ? "" : "dim"}`}>
              <span className="avatar bob">{p.avatar}</span>
              <span className="pname">{p.name}</span>
              <button className="kick" title="Remove player" onClick={() => send({ t: "kick", playerId: p.id })}>
                ×
              </button>
            </div>
          ))}
        </div>
        {audience.length > 0 && <AudienceRow audience={audience} send={send} />}

        <PlanPreview plan={view.plan} />
        <SettingsPanel settings={view.settings} players={connectedCount} send={send} />

        <div className="start-row">
          <button className="btn big" disabled={!canStart} onClick={() => send({ t: "start" })}>
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

function AudienceRow({ audience, send }: { audience: PublicPlayer[]; send?: Send }) {
  return (
    <div className="audience-row">
      <span className="muted">Audience</span>
      {audience.map((p) => (
        <span key={p.id} className={`audience-chip ${p.connected ? "" : "dim"}`}>
          {p.avatar} {p.name}
          {send && (
            <button className="kick" title="Remove" onClick={() => send({ t: "kick", playerId: p.id })}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function PlanPreview({ plan }: { plan: HostView["plan"] }) {
  if (plan.length === 0) return <p className="error">Pick at least one round.</p>;
  return (
    <div className="plan">
      <span className="muted">Tonight's line-up</span>
      <ol className="plan-list">
        {plan.map((r, i) => (
          <li key={i} className={`plan-chip kind-${r.kind}`} style={{ animationDelay: `${i * 60}ms` }}>
            {r.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SettingsPanel({ settings, players, send }: { settings: Settings; players: number; send: Send }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(settings.customPrompts.join("\n"));
  const [lash, setLash] = useState(settings.lashPrompt);
  const [previous, setPrevious] = useState(settings.previousItems.join("\n"));
  useEffect(() => setLash(settings.lashPrompt), [settings.lashPrompt]);

  const update = (s: Partial<Settings>) => send({ t: "settings", settings: s });
  const toggleRound = (k: RoundKind) => {
    const has = settings.rounds.includes(k);
    update({ rounds: TOGGLEABLE_ROUNDS.filter((r) => (r === k ? !has : settings.rounds.includes(r))) });
  };
  const parsed = parsePreviousItems(previous);

  return (
    <div className="settings">
      <div className="settings-summary">
        <label className="toggle">
          <input type="checkbox" checked={settings.anonymous} onChange={(e) => update({ anonymous: e.target.checked })} />
          <span>
            <b>Anonymous mode</b>: hide authors and scores
          </span>
        </label>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>
          {open ? "Hide settings" : "More settings"}
        </button>
      </div>
      <div className="rounds-row">
        {TOGGLEABLE_ROUNDS.map((k) => (
          <label key={k} className={`round-chip ${settings.rounds.includes(k) ? "on" : ""}`}>
            <input type="checkbox" checked={settings.rounds.includes(k)} onChange={() => toggleRound(k)} />
            {ROUND_TITLES[k]}
          </label>
        ))}
      </div>
      {open && (
        <div className="settings-grid">
          <label>
            Sprint rounds
            <select value={settings.sprintRounds} onChange={(e) => update({ sprintRounds: +e.target.value })}>
              <option value={0}>Auto ({autoSprintRounds(players)} for {players} players)</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            Talk time after each Sprint matchup
            <select
              value={settings.discussionSeconds}
              onChange={(e) => update({ discussionSeconds: +e.target.value })}
            >
              <option value={0}>Wait for me</option>
              {[30, 60, 90, 120, 180].map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s} s` : `${s / 60} min`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Answer time (s)
            <input type="number" min={20} max={300} value={settings.answerSeconds} onChange={(e) => update({ answerSeconds: +e.target.value })} />
          </label>
          <label>
            Vote time (s)
            <input type="number" min={10} max={120} value={settings.voteSeconds} onChange={(e) => update({ voteSeconds: +e.target.value })} />
          </label>
          <label>
            Action-item answers per person
            <input type="number" min={1} max={3} value={settings.lashMaxAnswers} onChange={(e) => update({ lashMaxAnswers: +e.target.value })} />
          </label>
          <label>
            Action-item votes per person
            <input type="number" min={1} max={5} value={settings.lashVotes} onChange={(e) => update({ lashVotes: +e.target.value })} />
          </label>
          <label className="wide">
            Final round prompt
            <input value={lash} onChange={(e) => setLash(e.target.value)} onBlur={() => update({ lashPrompt: lash })} />
          </label>
          <label className="wide">
            Your own retro prompts (one per line, used first in “The Sprint”)
            <textarea
              rows={3}
              value={custom}
              placeholder={"Our release process, as a horror movie title\nThe one ticket that haunted us"}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => update({ customPrompts: custom.split("\n").map((s) => s.trim()).filter(Boolean) })}
            />
          </label>
          <label className="wide">
            Last retro's action items: paste last time's Markdown export, or one item per line.
            Adds a “Did we do it?” round. {parsed.length > 0 && <b className="ok">{parsed.length} found</b>}
            <textarea
              rows={3}
              value={previous}
              placeholder={"- [ ] Pair on the flaky tests\n- [ ] No meetings on Thursday afternoons"}
              onChange={(e) => setPrevious(e.target.value)}
              onBlur={() => update({ previousItems: parsePreviousItems(previous) })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------- in-game pieces ----------

function Timer({ seconds, urgent }: { seconds: number; urgent: boolean }) {
  const hot = urgent && seconds <= 10;
  return (
    <div key={hot ? seconds : "t"} className={`timer ${hot ? "urgent" : ""} ${urgent ? "" : "calm"}`}>
      {seconds}
    </div>
  );
}

function SoundToggle() {
  const [, force] = useState(0);
  useEffect(() => {
    const off = onSoundChange(() => force((n) => n + 1));
    const t = setInterval(() => force((n) => n + 1), 1000); // reflect unlock state
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  const on = soundEnabled();
  return (
    <button
      className="btn ghost small sound-btn"
      title={on ? (soundReady() ? "Sound on" : "Click anywhere to enable sound") : "Sound off"}
      onClick={() => setSoundEnabled(!on)}
    >
      {on ? (soundReady() ? "🔊" : "🔈") : "🔇"}
    </button>
  );
}

function Intro({ view }: { view: HostView }) {
  return (
    <div className="intro">
      <div className="intro-num">Round {view.roundNumber}</div>
      <h1 className="intro-title">{view.roundTitle}</h1>
      <p className="intro-blurb">{view.roundKind && ROUND_BLURBS[view.roundKind]}</p>
      <ol className="intro-progress">
        {view.plan.map((r, i) => (
          <li
            key={i}
            className={`${i < view.roundNumber - 1 ? "past" : ""} ${i === view.roundNumber - 1 ? "now" : ""} kind-${r.kind}`}
            title={r.title}
          />
        ))}
      </ol>
    </div>
  );
}

function Answering({ view }: { view: HostView }) {
  const kind = view.roundKind;
  return (
    <div className="answering">
      <h1 className="huge drop-in">
        {kind === "checkin" ? "Weather report ☀️⛈️" : kind === "followup" ? "Did we do it? 🤔" : "Answer on your phones 📱"}
      </h1>
      {kind === "lastlash" && <p className="prompt-big">{view.lashPrompt}</p>}
      {kind === "checkin" && <p className="muted big-text">How did this sprint feel? Anonymous, as always.</p>}
      {kind === "followup" && (
        <ul className="followup-preview">
          {(view.followupItems ?? []).map((f, i) => (
            <li key={i} style={{ animationDelay: `${i * 120}ms` }}>
              {f.text}
            </li>
          ))}
        </ul>
      )}
      {isHeadToHead(kind) && (
        <p className="muted big-text">
          {kind === "emoji"
            ? "Two prompts each. Emoji only, no words allowed."
            : "Everyone gets two prompts. Your answers go head-to-head with someone else's."}
        </p>
      )}
      <DoneGrid view={view} />
      {isHeadToHead(kind) && <Commentary line={pick(COMMENTARY.answering, `${view.roundTitle}`)} />}
    </div>
  );
}

function Commentary({ line, delay = 0 }: { line: string; delay?: number }) {
  return (
    <p className="commentary" style={{ animationDelay: `${delay}ms` }}>
      🎙️ {line}
    </p>
  );
}

function DoneGrid({ view }: { view: HostView }) {
  const done = new Set(view.doneIds);
  const players = view.players.filter((p) => view.expectedIds.includes(p.id));
  return (
    <div className="done-grid">
      {players.map((p, i) => (
        <div
          key={p.id}
          className={`done-tile ${done.has(p.id) ? "done" : ""}`}
          style={{ animationDelay: `${i * 70}ms` }}
        >
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
  const audience = view.players.filter((p) => p.audience && p.connected);
  return (
    <div className="player-strip">
      {view.players
        .filter((p) => !p.audience)
        .map((p) => (
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
      {audience.length > 0 && (
        <span className="strip-audience" title={audience.map((p) => p.name).join(", ")}>
          🍿 {audience.length} watching
        </span>
      )}
    </div>
  );
}

/**
 * One head-to-head. While voting, the cards fly in one after the other.
 * On reveal, the votes land one by one as the voters' avatars, then the
 * numbers, authors and winner appear, then (Sprint) the discussion prompt.
 */
function Matchup({
  m,
  kind,
  reveal,
  number,
  count,
}: {
  m: MatchupView;
  kind?: RoundKind;
  reveal: boolean;
  number: number;
  count: number;
}) {
  const order = useMemo(() => voteOrder(m), [m]);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!reveal) return;
    setStep(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const STEP = 330;
    sfx.drumroll(0.6);
    order.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setStep(i + 1);
          sfx.blip(i);
        }, 700 + i * STEP),
      );
    });
    const end = 700 + order.length * STEP + 300;
    timers.push(
      setTimeout(() => {
        setStep(order.length + 1);
        if (m.unanimous) sfx.fanfare();
        else sfx.sting();
      }, end),
    );
    timers.push(setTimeout(() => setStep(order.length + 2), end + 900));
    return () => timers.forEach(clearTimeout);
  }, [reveal, m.id, order]);

  const final = reveal && step > order.length;
  const total = (m.votes?.[0] ?? 0) + (m.votes?.[1] ?? 0);
  const winner = final && m.votes && m.votes[0] !== m.votes[1] ? (m.votes[0] > m.votes[1] ? 0 : 1) : null;
  const landed = order.slice(0, step);
  const line = final ? resultLine(m) : null;
  const emoji = kind === "emoji";

  return (
    <div className="matchup">
      <div className="matchup-count muted">
        Matchup {number} of {count}
      </div>
      <h1 className="prompt-big drop-in">{m.prompt}</h1>
      <div className="versus">
        {[0, 1].map((i) => {
          const votes = m.votes?.[i] ?? 0;
          const pct = total ? Math.round((votes / total) * 100) : 0;
          const tokens = landed.filter((t) => t.side === i);
          return (
            <div
              key={i}
              className={`answer-card side-${i} fly-${i === 0 ? "left" : "right"} ${final ? "revealed" : ""} ${
                winner === i ? "winner" : ""
              } ${winner !== null && winner !== i ? "loser" : ""}`}
            >
              <p className={`answer-text ${emoji ? "emoji-answer" : ""}`}>
                {m.answers[i] || <span className="muted">🦗 no answer</span>}
              </p>
              {reveal && (
                <div className="vote-tokens">
                  {tokens.map((t, j) => (
                    <span key={j} className="vote-token">
                      {t.avatar}
                    </span>
                  ))}
                </div>
              )}
              {final && (
                <div className="result">
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="result-line">
                    <b>
                      <CountUp to={votes} />
                    </b>{" "}
                    vote{votes === 1 ? "" : "s"} · {pct}%
                    {m.points && (
                      <span className="points">
                        +<CountUp to={m.points[i]} />
                      </span>
                    )}
                  </div>
                  {m.authors && <div className="author slide-up">{m.authors[i]}</div>}
                  {m.voterNames && m.voterNames[i].length > 0 && (
                    <div className="voters muted slide-up">{m.voterNames[i].join(", ")}</div>
                  )}
                </div>
              )}
              {winner === i && <div className="winner-badge">🏆</div>}
            </div>
          );
        })}
        <div className="vs">VS</div>
      </div>
      {final && m.unanimous && <div className="banner">RETROLASH! 💥</div>}
      {!reveal && (
        <>
          <p className="muted big-text">Vote on your phone for your favourite</p>
          <Commentary line={pick(COMMENTARY.voting, m.id)} delay={1500} />
        </>
      )}
      {line && !m.unanimous && <Commentary line={line} />}
      {reveal && kind === "retro" && step > order.length + 1 && (
        <div className="discuss slide-up">
          <span className="discuss-label">💬 Let's talk</span>
          {pick(DISCUSSION_QUESTIONS, m.id)}
        </div>
      )}
    </div>
  );
}

/** Votes as tokens, interleaved between the sides so the tension builds. */
function voteOrder(m: MatchupView): { side: 0 | 1; avatar: string }[] {
  const sides: [string[], string[]] = m.voterAvatars ?? [
    Array.from({ length: m.votes?.[0] ?? 0 }, () => "●"),
    Array.from({ length: m.votes?.[1] ?? 0 }, () => "●"),
  ];
  const out: { side: 0 | 1; avatar: string }[] = [];
  for (let i = 0; i < Math.max(sides[0].length, sides[1].length); i++) {
    if (i < sides[0].length) out.push({ side: 0, avatar: sides[0][i] });
    if (i < sides[1].length) out.push({ side: 1, avatar: sides[1][i] });
  }
  return out;
}

function resultLine(m: MatchupView) {
  const [a, b] = m.votes ?? [0, 0];
  if (a === b) return pick(COMMENTARY.tie, m.id);
  if (Math.abs(a - b) === 1) return pick(COMMENTARY.close, m.id);
  return pick(COMMENTARY.blowout, m.id);
}

function CountUp({ to, ms = 900 }: { to: number; ms?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return <>{n}</>;
}

function MoodResult({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="poll-result">
      <h1 className="huge drop-in">The sprint forecast</h1>
      <div className="mood-chart">
        {MOODS.map((m, i) => (
          <div key={m.label} className="mood-col" style={{ animationDelay: `${i * 150}ms` }}>
            <span className="mood-count">{counts[i] ?? 0}</span>
            <div className="mood-track">
              <div className="mood-bar" style={{ height: `${((counts[i] ?? 0) / max) * 100}%`, animationDelay: `${300 + i * 150}ms` }} />
            </div>
            <span className="mood-emoji">{m.emoji}</span>
            <span className="muted">{m.label}</span>
          </div>
        ))}
      </div>
      {total === 0 && <p className="muted">Nobody answered. Mysterious.</p>}
    </div>
  );
}

function FollowupResult({ items }: { items: FollowupItemView[] }) {
  return (
    <div className="poll-result">
      <h1 className="huge drop-in">Did we do it?</h1>
      <div className="followup-results">
        {items.map((f, i) => {
          const total = Math.max(1, f.counts.reduce((a, b) => a + b, 0));
          return (
            <div key={i} className="fu-row" style={{ animationDelay: `${i * 200}ms` }}>
              <span className="fu-text">{f.text}</span>
              <span className="fu-stack">
                {FOLLOWUP_OPTIONS.map((o, v) =>
                  f.counts[v] ? (
                    <span key={v} className={`fu-seg fu-${v}`} style={{ flexGrow: f.counts[v] / total }}>
                      {o.emoji} {f.counts[v]}
                    </span>
                  ) : null,
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoundResult({ view }: { view: HostView }) {
  const ranked = view.players.filter((p) => !p.audience).sort((a, b) => b.score - a.score);
  return (
    <div className="round-result">
      <h1 className="huge drop-in">{view.roundTitle}: done!</h1>
      {view.settings.anonymous ? (
        <p className="muted big-text">Anonymous mode is on, so no scores. The answers are saved for the summary.</p>
      ) : (
        <>
          <Scoreboard players={ranked} />
          <Commentary line={pick(COMMENTARY.roundDone, view.roundTitle ?? "")} delay={1200} />
        </>
      )}
    </div>
  );
}

function Scoreboard({ players }: { players: PublicPlayer[] }) {
  const max = Math.max(1, ...players.map((p) => p.score));
  return (
    <ol className="scoreboard">
      {players.map((p, i) => (
        <li key={p.id} style={{ animationDelay: `${(players.length - i) * 120}ms` }} className={i === 0 ? "leader" : ""}>
          <span className="rank">{i === 0 ? "👑" : i + 1}</span>
          <span className="avatar">{p.avatar}</span>
          <span className="pname">{p.name}</span>
          <span className="score-bar">
            <span style={{ width: `${(p.score / max) * 100}%` }} />
          </span>
          <span className="score">
            <CountUp to={p.score} ms={1200} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Last Lash. Results reveal from the bottom of the ranking up, after a drumroll. */
function Lash({ view }: { view: HostView }) {
  const reveal = view.phase === "lashResult";
  const answers = view.lashAnswers ?? [];
  const max = Math.max(1, ...answers.map((a) => a.votes ?? 0));
  const [shown, setShown] = useState(reveal ? 0 : answers.length);
  useEffect(() => {
    if (!reveal) return;
    setShown(0);
    sfx.drumroll(1.2);
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Reveal lowest first; the top item lands last with a fanfare.
    answers.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setShown(i + 1);
          if (i === answers.length - 1) sfx.fanfare();
          else sfx.blip(i);
        }, 1300 + i * 450),
      );
    });
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const visible = (i: number) => !reveal || i >= answers.length - shown;

  return (
    <div className="lash">
      <h1 className="prompt-big drop-in">{view.lashPrompt}</h1>
      {!reveal && <p className="muted big-text">Pick your favourites on your phone</p>}
      {reveal && shown >= answers.length && (
        <p className="discuss slide-up">🙋 Volunteer on your phone to own an action item</p>
      )}
      <div className={`lash-list ${reveal ? "ranked" : ""}`}>
        {answers.map((a, i) => (
          <LashItem key={a.id} a={a} top={reveal && i < 3 && (a.votes ?? 0) > 0} reveal={reveal} max={max} visible={visible(i)} index={i} />
        ))}
      </div>
      {!reveal && <DoneGrid view={view} />}
    </div>
  );
}

function LashItem({
  a,
  top,
  reveal,
  max,
  visible,
  index,
}: {
  a: LashAnswerView;
  top: boolean;
  reveal: boolean;
  max: number;
  visible: boolean;
  index: number;
}) {
  return (
    <div
      className={`lash-item ${top ? "top" : ""} ${visible ? "" : "hidden"}`}
      style={reveal ? undefined : { animationDelay: `${index * 80}ms` }}
    >
      {reveal && <span className="lash-votes">{a.votes}</span>}
      <span className="lash-text">{a.text}</span>
      {a.owners && a.owners.length > 0 && (
        <span className="owners">
          {a.owners.map((o) => (
            <span key={o.name} className="owner-chip">
              {o.avatar} {o.name}
            </span>
          ))}
        </span>
      )}
      {a.author && <span className="author">{a.author}</span>}
      {reveal && visible && <span className="lash-bar" style={{ width: `${((a.votes ?? 0) / max) * 100}%` }} />}
    </div>
  );
}

function Summary({ view }: { view: HostView }) {
  const [copied, setCopied] = useState(false);
  const md = summaryToMarkdown(view);
  const rounds = view.summary ?? [];
  const lash = rounds.find((r) => r.kind === "lastlash");
  const actionItems = (lash?.lashAnswers ?? []).filter((a) => (a.votes ?? 0) > 0 || a.owners?.length);
  const sprint = rounds.filter((r) => r.kind === "retro").flatMap((r) => r.matchups);
  const mood = rounds.find((r) => r.kind === "checkin")?.moodCounts;
  const followup = rounds.find((r) => r.kind === "followup")?.followupItems;
  const ranked = view.players.filter((p) => !p.audience).sort((a, b) => b.score - a.score);

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
      <h1 className="huge drop-in">That's a wrap 🎬</h1>
      <div className="summary-cols">
        <section>
          <h2>Action items</h2>
          {actionItems.length === 0 ? (
            <p className="muted">No action items this time.</p>
          ) : (
            <ol className="action-list">
              {actionItems.map((a, i) => (
                <li key={a.id} style={{ animationDelay: `${i * 100}ms` }}>
                  <span className="lash-votes">{a.votes}</span>
                  <span className="grow">{a.text}</span>
                  {a.owners?.map((o) => (
                    <span key={o.name} className="owner-chip">
                      {o.avatar} {o.name}
                    </span>
                  ))}
                </li>
              ))}
            </ol>
          )}
          {followup && followup.length > 0 && (
            <>
              <h2>Last time's action items</h2>
              <FollowupResult items={followup} />
            </>
          )}
          {sprint.length > 0 && (
            <>
              <h2>From the sprint</h2>
              <ul className="sprint-list">
                {sprint.map((m) => (
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
        <section>
          {mood && (
            <>
              <h2>Sprint weather</h2>
              <div className="mood-inline">
                {MOODS.map((m, i) => (
                  <span key={m.label} className={mood[i] ? "" : "dim"}>
                    {m.emoji} {mood[i]}
                  </span>
                ))}
              </div>
            </>
          )}
          {!view.settings.anonymous && (
            <>
              <h2>Final scores</h2>
              <Scoreboard players={ranked} />
            </>
          )}
        </section>
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
      onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
    >
      ⛶ Fullscreen
    </button>
  );
}
