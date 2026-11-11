import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import { joinUrl, makeCode, useCountdown, useRoom, type RoomEvent } from "./net";
import { summaryToMarkdown } from "./summary";
import {
  getVolume,
  musicEnabled,
  setVolume,
  sayClips,
  onSoundChange,
  setMusicEnabled,
  setMusicMood,
  setSoundEnabled,
  sfx,
  soundEnabled,
  soundReady,
  unlockAudio,
} from "./sound";
import { LangContext, REDUCED_MOTION, deviceLang, nextLabel, usePrompts, useT } from "./lang";
import { strings } from "../shared/i18n";
import {
  FOLLOWUP_OPTIONS,
  LANGS,
  MIN_PLAYERS,
  HIGHLIGHT_STEP_MS,
  MOODS,
  PACKS,
  PLATE_COLORS,
  PODIUM_REVEAL,
  places,
  TOGGLEABLE_ROUNDS,
  autoSprintRounds,
  isHeadToHead,
  parsePreviousItems,
  type ClientMessage,
  type FollowupItemView,
  type HostView,
  type KudosView,
  type LashAnswerView,
  type MatchupView,
  type PublicPlayer,
  type RoundKind,
  type Settings,
  type VoterView,
} from "../shared/types";
import { pick } from "../shared/prompts";

type Send = (m: ClientMessage) => void;

interface FloatingReaction {
  id: number;
  emoji: string;
  avatar?: string;
  x: number;
}

/** Ways a card can leave the screen. One is picked per matchup. */
const OUTS = ["fall", "fling", "spin", "rocket", "squash"] as const;
const EXIT_MS = 650;

/**
 * Screens that belong together share a key, so the reveal happens in place.
 * When the key changes, the old screen gets EXIT_MS to animate out first.
 */
function stageKey(v: HostView) {
  switch (v.phase) {
    case "matchupIntro":
    case "voting":
    case "matchupResult":
      return `m:${v.roundNumber}:${v.matchupNumber}`;
    case "lashVoting":
    case "lashResult":
      return `lash:${v.roundNumber}`;
    default:
      return `${v.phase}:${v.roundNumber}`;
  }
}

/** The view the stage shows: lags behind the live view while the old screen exits. */
function useStaged(view: HostView | null) {
  const [shown, setShown] = useState(view);
  const [exiting, setExiting] = useState(false);
  const latest = useRef(view);
  latest.current = view;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!view || timer.current) return; // mid-exit: the latest view is picked up at the end
    if (!shown || stageKey(view) === stageKey(shown) || REDUCED_MOTION) {
      setShown(view);
      return;
    }
    setExiting(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setExiting(false);
      setShown(latest.current);
    }, EXIT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  return { shown: shown ?? view, exiting };
}

export default function Host({ code }: { code: string }) {
  // The first big screen of a room gets a token; keep it so this browser stays the host.
  const tokenKey = `retrolash:host:${code}`;
  const hello = useCallback((): ClientMessage => {
    let token: string | null = null;
    try {
      token = localStorage.getItem(tokenKey);
    } catch {
      /* private mode: this tab stays host until it closes */
    }
    return token ? { t: "helloHost", token } : { t: "helloHost" };
  }, [tokenKey]);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const nextId = useRef(0);
  const lastPop = useRef(0);
  const onEvent = useCallback((e: RoomEvent) => {
    if (e.t === "hostToken") {
      try {
        localStorage.setItem(tokenKey, e.token);
      } catch {
        /* private mode */
      }
      return;
    }
    if (e.t !== "reaction") return;
    const id = nextId.current++;
    setReactions((r) => [...r.slice(-40), { id, emoji: e.emoji, avatar: e.avatar, x: 5 + Math.random() * 90 }]);
    setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3200);
    if (Date.now() - lastPop.current > 150) {
      lastPop.current = Date.now();
      sfx.pop();
    }
  }, [tokenKey]);
  const { view, receivedAt, connected, error, send } = useRoom<HostView>(code, hello, onEvent);
  const seconds = useCountdown(view?.remainingMs, receivedAt);
  const { shown, exiting } = useStaged(view);

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

  useEffect(() => {
    if (exiting) sfx.whoosh();
  }, [exiting]);

  usePhaseSounds(shown, seconds);

  // Spoken prompts: play this screen's clips once, when the screen appears.
  const sayKey = shown?.say?.length ? `${stageKey(shown)}:${shown.phase}:${shown.say.map((c) => c.id).join(",")}` : "";
  useEffect(() => {
    if (sayKey && shown?.say) void sayClips(shown.say);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sayKey]);
  useMusicMood(shown);

  if (!view && error) {
    return (
      <main className="host center">
        <div className="taken">
          <div className="logo small">
            Retro<span>lash</span>
          </div>
          <p>{error}</p>
          <button className="btn big" onClick={() => (location.href = `?host=${makeCode()}`)}>
            {strings(deviceLang()).host.newRoom}
          </button>
        </div>
      </main>
    );
  }

  if (!view || !shown) {
    return (
      <main className="host center">
        <p className="muted">{connected ? "…" : "Connecting…"}</p>
      </main>
    );
  }

  const lang = view.settings.lang;
  const paused = view.pausedMs !== null;
  const canHold = view.remainingMs !== null || paused;
  const msLeft =
    shown.remainingMs !== null ? Math.max(0, shown.remainingMs - (Date.now() - receivedAt)) : null;
  const variant = pick(OUTS, shown.matchup?.id ?? stageKey(shown));

  return (
    <LangContext.Provider value={lang}>
      <main className={`host phase-${shown.phase} kind-${shown.roundKind ?? "none"}`}>
        <HostHeader view={view} seconds={seconds} paused={paused} connected={connected} />

        <section className="host-body">
          <div className={`stage ${exiting ? "exiting" : ""} out-${variant}`}>
            <Stage view={shown} send={send} msLeft={msLeft} />
          </div>
        </section>

        {view.phase !== "lobby" && (
          <footer className="host-footer">
            <PlayerStrip view={view} />
            <HostControls view={view} send={send} canHold={canHold} paused={paused} />
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
    </LangContext.Provider>
  );
}

function HostHeader({
  view,
  seconds,
  paused,
  connected,
}: {
  view: HostView;
  seconds: number | null;
  paused: boolean;
  connected: boolean;
}) {
  const t = useT();
  const inGame = view.phase !== "lobby";
  return (
    <header className="host-header">
      <div className="logo small">
        Retro<span>lash</span>
      </div>
      {inGame && !["summary", "podium", "highlights"].includes(view.phase) && (
        <div className="round-pill" key={view.roundTitle}>
          {t.host.roundPill(view.roundNumber, view.roundCount, view.roundTitle ?? "")}
        </div>
      )}
      <div className="header-right">
        {paused ? (
          <div className="timer paused" title={t.host.holdTitle}>
            ⏸ {Math.ceil((view.pausedMs ?? 0) / 1000)}
          </div>
        ) : (
          seconds !== null &&
          !["roundIntro", "matchupIntro"].includes(view.phase) && (
            <Timer seconds={seconds} urgent={["answering", "voting", "lashVoting"].includes(view.phase)} />
          )
        )}
        {inGame && <MiniJoin code={view.code} />}
        <SoundToggle />
        {!connected && <span className="offline">{t.reconnecting}</span>}
      </div>
    </header>
  );
}

function HostControls({
  view,
  send,
  canHold,
  paused,
}: {
  view: HostView;
  send: Send;
  canHold: boolean;
  paused: boolean;
}) {
  const t = useT();
  return (
    <div className="controls">
      {view.phase === "summary" ? (
        <button className="btn ghost" onClick={() => send({ t: "restart" })}>
          {t.host.backToLobby}
        </button>
      ) : (
        <>
          {canHold && (
            <button className="btn ghost" onClick={() => send({ t: "hold" })}>
              {paused ? t.resume : t.hold} <kbd>P</kbd>
            </button>
          )}
          <button className="btn" onClick={() => send({ t: "next" })}>
            {nextLabel(t, { ...view, anonymous: view.settings.anonymous })} <kbd>space</kbd>
          </button>
        </>
      )}
      <FullscreenButton />
    </div>
  );
}

/** A small QR code in the corner so latecomers can join mid-game. */
function MiniJoin({ code }: { code: string }) {
  const t = useT();
  return (
    <div className="mini-join" title={joinUrl(code)}>
      <div className="mini-qr">
        <QRCodeSVG value={joinUrl(code)} size={120} marginSize={1} />
      </div>
      <div className="mini-text">
        <small>
          {t.host.join} · {location.host}
        </small>
        <b>{code}</b>
      </div>
    </div>
  );
}

/** Phase-level sounds; the matchup, podium and Last Lash reveals do their own. */
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
        if (view.leadChange) sfx.fanfare(1.6);
        break;
      case "summary":
        sfx.sting(0.3);
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const timed = view && ["answering", "voting", "lashVoting"].includes(view.phase);
  useEffect(() => {
    if (timed && seconds !== null && seconds > 0 && seconds <= 5) sfx.tick(seconds <= 3);
  }, [seconds, timed]);
}

/** Music sits back while people talk. */
function useMusicMood(view: HostView | null) {
  const talk =
    !!view &&
    ((view.phase === "matchupResult" && view.roundKind === "retro") ||
      view.phase === "lashResult" ||
      (view.phase === "pollResult" && view.roundKind === "followup"));
  const mood = !view ? "full" : talk ? "talk" : ["lobby", "summary"].includes(view.phase) ? "full" : "low";
  useEffect(() => setMusicMood(mood), [mood]);
}

function Stage({ view, send, msLeft }: { view: HostView; send: Send; msLeft: number | null }) {
  switch (view.phase) {
    case "lobby":
      return <Lobby view={view} send={send} />;
    case "roundIntro":
      return <Intro view={view} />;
    case "answering":
      return <Answering view={view} />;
    case "matchupIntro":
    case "voting":
    case "matchupResult":
      return view.matchup ? (
        <Matchup
          key={view.matchup.id}
          m={view.matchup}
          kind={view.roundKind}
          phase={view.phase}
          number={view.matchupNumber!}
          count={view.matchupCount!}
          msLeft={msLeft}
          spoken={!!view.say?.length}
        />
      ) : null;
    case "pollResult":
      if (view.roundKind === "checkin") return <MoodResult counts={view.moodCounts ?? []} />;
      if (view.roundKind === "kudos") return <KudosResult kudos={view.kudos ?? []} />;
      return <FollowupResult items={view.followupItems ?? []} />;
    case "roundResult":
      return <RoundResult view={view} />;
    case "lashVoting":
    case "lashResult":
      return <Lash view={view} />;
    case "highlights":
      return <Highlights view={view} />;
    case "podium":
      return <Podium view={view} />;
    case "summary":
      return <Summary view={view} />;
  }
}

// ---------- shared bits ----------

type PlateData = Pick<VoterView, "name" | "avatar" | "color"> & { audience?: boolean };

/** A name on a coloured backplate. */
const Plate = forwardRef<HTMLSpanElement, { p: PlateData; className?: string; dataI?: number }>(
  function Plate({ p, className = "", dataI }, ref) {
    return (
      <span
        ref={ref}
        className={`plate ${className}`}
        data-i={dataI}
        style={{ "--plate": p.color } as CSSProperties}
      >
        <span className="plate-av">{p.avatar}</span>
        <span className="plate-name">{p.name}</span>
      </span>
    );
  },
);

/** A plate that flies in from where it was (FLIP), then settles. */
function FlyPlate({ p, from }: { p: PlateData; from?: DOMRect }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !from || REDUCED_MOTION || !el.animate) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(1)` },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 70}px) scale(1.3) rotate(-6deg)`, offset: 0.55 },
        { transform: "translate(0, 0) scale(1)" },
      ],
      { duration: 560, easing: "cubic-bezier(.3,.6,.3,1)" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Plate ref={ref} p={p} className="landed" />;
}

function Confetti({ count = 140 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        dur: 2.4 + Math.random() * 1.8,
        color: PLATE_COLORS[i % PLATE_COLORS.length],
        rot: Math.random() * 720 - 360,
        drift: (Math.random() - 0.5) * 30,
        w: 8 + Math.random() * 9,
      })),
    [count],
  );
  if (REDUCED_MOTION) return null;
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p, i) => (
        <i
          key={i}
          style={
            {
              left: `${p.left}%`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
              background: p.color,
              width: p.w,
              height: p.w * 0.45,
              "--rot": `${p.rot}deg`,
              "--drift": `${p.drift}vw`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

// ---------- lobby ----------

function Lobby({ view, send }: { view: HostView; send: Send }) {
  const t = useT();
  const url = joinUrl(view.code);
  const players = view.players.filter((p) => !p.audience);
  const audience = view.players.filter((p) => p.audience);
  const connectedCount = players.filter((p) => p.connected).length;
  const canStart = connectedCount >= MIN_PLAYERS && view.plan.length > 0;
  return (
    <div className="lobby">
      <div className="join-panel">
        <p className="join-label">{t.lobby.joinOnPhone}</p>
        <div className="qr">
          <QRCodeSVG value={url} size={260} marginSize={2} />
        </div>
        <p className="join-url">{location.host}</p>
        <p className="join-label">{t.lobby.roomCode}</p>
        <div className="room-code">{view.code}</div>
      </div>

      <div className="lobby-main">
        <h2>
          {t.lobby.players} <span className="muted">({connectedCount})</span>
        </h2>
        <div className="player-grid">
          {players.length === 0 && <p className="muted">{t.lobby.waitingJoin}</p>}
          {players.map((p) => (
            <div
              key={p.id}
              className={`player-tile ${p.connected ? "" : "dim"}`}
              style={{ "--plate": p.color } as CSSProperties}
            >
              <span className="avatar bob">{p.avatar}</span>
              <span className="pname">{p.name}</span>
              <VipButton p={p} send={send} />
              <button className="kick" title={t.lobby.remove} onClick={() => send({ t: "kick", playerId: p.id })}>
                ×
              </button>
            </div>
          ))}
        </div>
        {audience.length > 0 && <AudienceRow audience={audience} send={send} />}

        <PlanPreview plan={view.plan} />
        <SettingsPanel settings={view.settings} players={connectedCount} send={send} speechAvailable={view.speechAvailable} />

        <div className="start-row">
          <button className="btn big" disabled={!canStart} onClick={() => send({ t: "start" })}>
            {t.lobby.start}
          </button>
          {connectedCount < MIN_PLAYERS && <span className="muted">{t.lobby.needPlayers(MIN_PLAYERS)}</span>}
          <FullscreenButton />
        </div>
      </div>
    </div>
  );
}

function VipButton({ p, send }: { p: PublicPlayer; send: Send }) {
  const t = useT();
  return (
    <button
      className={`vip-btn ${p.vip ? "on" : ""}`}
      title={p.vip ? t.lobby.vipOn : t.lobby.makeVip}
      onClick={() => send({ t: "vip", playerId: p.id, on: !p.vip })}
    >
      {p.vip ? "🎛️ VIP" : "🎛️"}
    </button>
  );
}

function AudienceRow({ audience, send }: { audience: PublicPlayer[]; send?: Send }) {
  const t = useT();
  return (
    <div className="audience-row">
      <span className="muted">{t.lobby.audience}</span>
      {audience.map((p) => (
        <span key={p.id} className={`audience-chip ${p.connected ? "" : "dim"}`}>
          {p.avatar} {p.name}
          {send && <VipButton p={p} send={send} />}
          {send && (
            <button className="kick" title={t.lobby.remove} onClick={() => send({ t: "kick", playerId: p.id })}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function PlanPreview({ plan }: { plan: HostView["plan"] }) {
  const t = useT();
  if (plan.length === 0) return <p className="error">{t.lobby.pickRound}</p>;
  return (
    <div className="plan">
      <span className="muted">{t.lobby.lineup}</span>
      <ol className="plan-list">
        {plan.map((r, i) => (
          <li key={`${i}-${r.title}`} className={`plan-chip kind-${r.kind}`} style={{ animationDelay: `${i * 60}ms` }}>
            {r.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SettingsPanel({
  settings,
  players,
  send,
  speechAvailable,
}: {
  settings: Settings;
  players: number;
  send: Send;
  speechAvailable: boolean;
}) {
  const t = useT();
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
            <b>{t.settings.anonymous}</b>: {t.settings.anonymousHint}
          </span>
        </label>
        {speechAvailable && (
          <label className="toggle">
            <input type="checkbox" checked={settings.speech} onChange={(e) => update({ speech: e.target.checked })} />
            <span>{t.settings.speech}</span>
          </label>
        )}
        <div className="seg" role="group" aria-label={t.settings.language}>
          {LANGS.map((l) => (
            <button key={l} className={settings.lang === l ? "on" : ""} onClick={() => update({ lang: l })}>
              {l === "en" ? "🇬🇧 English" : "🇸🇪 Svenska"}
            </button>
          ))}
        </div>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>
          {open ? t.settings.hide : t.settings.more}
        </button>
      </div>
      <div className="rounds-row">
        {TOGGLEABLE_ROUNDS.map((k) => (
          <label key={k} className={`round-chip ${settings.rounds.includes(k) ? "on" : ""}`}>
            <input type="checkbox" checked={settings.rounds.includes(k)} onChange={() => toggleRound(k)} />
            {t.rounds[k]}
          </label>
        ))}
        {settings.rounds.includes("retro") && (
          <label className="pack-select">
            {t.settings.format}
            <select value={settings.pack} onChange={(e) => update({ pack: e.target.value as Settings["pack"] })}>
              {PACKS.map((p) => (
                <option key={p} value={p}>
                  {t.packs[p]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {open && (
        <div className="settings-grid">
          <label>
            {t.settings.sprintRounds}
            <select value={settings.sprintRounds} onChange={(e) => update({ sprintRounds: +e.target.value })}>
              <option value={0}>{t.settings.auto(autoSprintRounds(players), players)}</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            {t.settings.talkTime}
            <select value={settings.discussionSeconds} onChange={(e) => update({ discussionSeconds: +e.target.value })}>
              <option value={0}>{t.settings.waitForMe}</option>
              {[30, 60, 90, 120, 180].map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s} s` : `${s / 60} min`}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.settings.answerTime}
            <input type="number" min={20} max={300} value={settings.answerSeconds} onChange={(e) => update({ answerSeconds: +e.target.value })} />
          </label>
          <label>
            {t.settings.voteTime}
            <input type="number" min={10} max={120} value={settings.voteSeconds} onChange={(e) => update({ voteSeconds: +e.target.value })} />
          </label>
          <label>
            {t.settings.lashAnswers}
            <input type="number" min={1} max={3} value={settings.lashMaxAnswers} onChange={(e) => update({ lashMaxAnswers: +e.target.value })} />
          </label>
          <label>
            {t.settings.lashVotes}
            <input type="number" min={1} max={5} value={settings.lashVotes} onChange={(e) => update({ lashVotes: +e.target.value })} />
          </label>
          <label className="wide">
            {t.settings.finalPrompt}
            <input value={lash} onChange={(e) => setLash(e.target.value)} onBlur={() => update({ lashPrompt: lash })} />
          </label>
          <label className="wide">
            {t.settings.customPrompts}
            <textarea
              rows={3}
              value={custom}
              placeholder={t.settings.customPlaceholder}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => update({ customPrompts: custom.split("\n").map((s) => s.trim()).filter(Boolean) })}
            />
          </label>
          <label className="wide">
            {t.settings.previous} {parsed.length > 0 && <b className="ok">{t.settings.found(parsed.length)}</b>}
            <textarea
              rows={3}
              value={previous}
              placeholder={t.settings.previousPlaceholder}
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
  const t = useT();
  const [, force] = useState(0);
  useEffect(() => {
    const off = onSoundChange(() => force((n) => n + 1));
    const timer = setInterval(() => force((n) => n + 1), 1000); // reflect unlock state
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  const on = soundEnabled();
  const music = musicEnabled();
  return (
    <>
      <button
        className="btn ghost small sound-btn"
        title={on ? (soundReady() ? t.host.soundOn : t.host.soundClick) : t.host.soundOff}
        onClick={() => setSoundEnabled(!on)}
      >
        {on ? (soundReady() ? "🔊" : "🔈") : "🔇"}
      </button>
      <VolumePanel music={music} on={on} />
    </>
  );
}

/** 🎵 opens music on/off plus volume sliders for music and sound effects. */
function VolumePanel({ music, on }: { music: boolean; on: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const slider = (kind: "music" | "sfx" | "voice", label: string, disabled = false) => (
    <label className={`vol-row ${disabled ? "dim" : ""}`}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(getVolume(kind) * 100)}
        disabled={disabled}
        onChange={(e) => setVolume(kind, +e.target.value / 100)}
        onPointerUp={() => kind === "sfx" && sfx.blip(4)}
      />
      <b>{Math.round(getVolume(kind) * 100)}</b>
    </label>
  );
  return (
    <div className="vol-wrap" ref={ref}>
      <button
        className={`btn ghost small sound-btn ${music && on ? "" : "off"}`}
        title={t.host.volume}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        🎵
      </button>
      {open && (
        <div className="vol-panel">
          <label className="toggle">
            <input type="checkbox" checked={music} onChange={(e) => setMusicEnabled(e.target.checked)} />
            <span>{music ? t.host.musicOn : t.host.musicOff}</span>
          </label>
          {slider("music", t.host.music, !music)}
          {slider("sfx", t.host.effects)}
          {slider("voice", t.host.voice)}
          {!on && <p className="muted small-print">🔇 {t.host.soundOff}</p>}
        </div>
      )}
    </div>
  );
}

function Intro({ view }: { view: HostView }) {
  const t = useT();
  const kind = view.roundKind;
  return (
    <div className="intro">
      <div className="intro-num">{t.stage.round(view.roundNumber)}</div>
      <h1 className="intro-title">{view.roundTitle}</h1>
      <p className="intro-blurb">{kind && t.blurbs[kind]}</p>
      {kind === "retro" && view.settings.pack !== "mix" && (
        <p className="intro-pack">{t.stage.format(t.packs[view.settings.pack])}</p>
      )}
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
  const t = useT();
  const P = usePrompts();
  const kind = view.roundKind;
  const title =
    kind === "checkin"
      ? t.stage.weather
      : kind === "followup"
        ? t.stage.didWe
        : kind === "kudos"
          ? t.stage.kudosTime
          : t.stage.answerPhones;
  return (
    <div className="answering">
      <h1 className="huge drop-in">{title}</h1>
      {kind === "lastlash" && <p className="prompt-big">{view.lashPrompt}</p>}
      {kind === "checkin" && <p className="muted big-text">{t.stage.checkinSub}</p>}
      {kind === "kudos" && <p className="muted big-text">{t.stage.kudosSub}</p>}
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
        <p className="muted big-text">{kind === "emoji" ? t.stage.emojiSub : t.stage.h2hSub}</p>
      )}
      <DoneGrid view={view} />
      {isHeadToHead(kind) && <Commentary line={pick(P.commentary.answering, `${view.roundTitle}`)} />}
      {kind === "kudos" && <Commentary line={pick(P.commentary.kudos, `${view.roundTitle}`)} />}
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
          style={{ animationDelay: `${i * 70}ms`, "--plate": p.color } as CSSProperties}
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
  const t = useT();
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
            style={{ "--plate": p.color } as CSSProperties}
            title={p.name}
          >
            {p.avatar}
          </span>
        ))}
      {audience.length > 0 && (
        <span className="strip-audience" title={audience.map((p) => p.name).join(", ")}>
          {t.host.watching(audience.length)}
        </span>
      )}
    </div>
  );
}

// ---------- the matchup ----------

/** Reveal the prompt bit by bit, keeping the layout stable. */
function Typewriter({ text, delay, ms }: { text: string; delay: number; ms: number }) {
  const chars = useMemo(() => [...text], [text]);
  const [n, setN] = useState(REDUCED_MOTION ? chars.length : 0);
  useEffect(() => {
    if (REDUCED_MOTION) return;
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - start) / ms));
      setN(Math.round(p * chars.length));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [chars, delay, ms]);
  return (
    <>
      {chars.slice(0, n).join("")}
      <span className="tw-rest">{chars.slice(n).join("")}</span>
    </>
  );
}

/** Anticipation before a matchup: the number slams in, the prompt types out, a fuse burns. */
function MatchupIntro({
  m,
  number,
  count,
  msLeft,
  spoken,
}: {
  m: MatchupView;
  number: number;
  count: number;
  msLeft: number | null;
  spoken: boolean;
}) {
  const t = useT();
  const [ms] = useState(() => Math.max(1200, msLeft ?? 3600));
  useEffect(() => {
    sfx.boom(0.05);
    if (!spoken) sfx.riser(Math.max(0.8, ms / 1000 - 0.9), 0.6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  return (
    <div className="m-intro">
      <div className="m-intro-label">{t.stage.matchup}</div>
      <div className="m-intro-num">
        {number}
        <small>/{count}</small>
      </div>
      <h1 className="prompt-big m-intro-prompt">
        <Typewriter text={m.prompt} delay={700} ms={Math.max(500, Math.min(1500, ms - 1500))} />
      </h1>
      <div className="fuse">
        <span style={{ animationDuration: `${ms}ms` }} />
      </div>
    </div>
  );
}

interface Token {
  side: 0 | 1;
  voter: PlateData | null;
}

/**
 * One head-to-head: intro → cards fly in for voting → the reveal. On reveal,
 * the voters' name plates line up under the cards and fly onto the answer they
 * picked, one by one. Then the numbers, authors and winner appear. A clean
 * sweep is a RETROLASH: the losing card is knocked out and the winner takes
 * centre stage.
 */
function Matchup({
  m,
  kind,
  phase,
  number,
  count,
  msLeft,
  spoken,
}: {
  m: MatchupView;
  kind?: RoundKind;
  phase: "matchupIntro" | "voting" | "matchupResult";
  number: number;
  count: number;
  msLeft: number | null;
  spoken: boolean;
}) {
  const t = useT();
  const P = usePrompts();
  const reveal = phase === "matchupResult";
  const orderKey = JSON.stringify([m.voters, m.votes]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => voteOrder(m), [orderKey]);
  const [step, setStep] = useState(0);
  const poolRef = useRef<HTMLDivElement>(null);
  const rects = useRef<Record<number, DOMRect | undefined>>({});

  useEffect(() => {
    if (!reveal) return;
    setStep(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const n = order.length;
    const STEP = Math.max(170, Math.min(420, 4200 / Math.max(1, n)));
    const START = 900;
    sfx.drumroll(0.8);
    order.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          const el = poolRef.current?.querySelector(`[data-i="${i}"]`);
          rects.current[i] = el?.getBoundingClientRect();
          setStep(i + 1);
          sfx.blip(i);
        }, START + i * STEP),
      );
    });
    const end = START + n * STEP + 400;
    timers.push(
      setTimeout(() => {
        setStep(n + 1);
        if (m.unanimous) {
          sfx.retrolash();
          sfx.knockout(0.15);
        } else sfx.sting();
      }, end),
    );
    timers.push(
      setTimeout(() => {
        setStep(n + 2);
        if (m.callout) sfx.fanfare();
      }, end + (m.unanimous ? 1600 : 1000)),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, m.id, orderKey]);

  if (phase === "matchupIntro") return <MatchupIntro m={m} number={number} count={count} msLeft={msLeft} spoken={spoken} />;

  const final = reveal && step > order.length;
  const extras = reveal && step > order.length + 1;
  const total = (m.votes?.[0] ?? 0) + (m.votes?.[1] ?? 0);
  const winner = final && m.votes && m.votes[0] !== m.votes[1] ? (m.votes[0] > m.votes[1] ? 0 : 1) : null;
  const lash = final && !!m.unanimous && winner !== null;
  const landed = order.slice(0, step);
  const line = final ? resultLine(m, P.commentary) : null;
  const emoji = kind === "emoji";
  const plates = order.some((tk) => tk.voter);
  const out = pick(OUTS, `${m.id}:ko`);

  return (
    <div className="matchup">
      <div className="matchup-count muted">{t.stage.matchupOf(number, count)}</div>
      <h1 className="prompt-big settle">{m.prompt}</h1>
      <div className={`versus ${lash ? "retrolash" : ""}`}>
        {[0, 1].map((i) => {
          const votes = m.votes?.[i] ?? 0;
          const pct = total ? Math.round((votes / total) * 100) : 0;
          const author = m.authorPlates?.[i];
          const isWinner = winner === i;
          const isLoser = winner !== null && winner !== i;
          return (
            <div
              key={i}
              className={[
                "answer-card",
                `side-${i}`,
                reveal ? "" : `fly-${i === 0 ? "left" : "right"}`,
                final ? "revealed" : "",
                isWinner ? "winner" : "",
                isLoser ? "loser" : "",
                lash && isWinner ? "champion" : "",
                lash && isLoser ? `gone out-${out}` : "",
              ].join(" ")}
            >
              <p className={`answer-text ${emoji ? "emoji-answer" : ""}`}>
                {m.answers[i] || <span className="muted">{t.stage.noAnswer}</span>}
              </p>
              {reveal && (
                <div className={`vote-tokens ${order.length > 10 ? "many" : order.length > 5 ? "some" : ""}`}>
                  {landed.map((tk, j) =>
                    tk.side !== i ? null : tk.voter ? (
                      <FlyPlate key={j} p={tk.voter} from={rects.current[j]} />
                    ) : (
                      <span key={j} className="vote-token">
                        ●
                      </span>
                    ),
                  )}
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
                    {t.stage.votes(votes).replace(/^\d+\s*/, "")} · {pct}%
                    {m.points && (
                      <span className="points">
                        +<CountUp to={m.points[i]} />
                      </span>
                    )}
                  </div>
                  {author && <Plate p={author} className="author-plate slide-up" />}
                  {m.auto?.[i] && <div className="auto-tag slide-up">{t.stage.autoAnswer}</div>}
                </div>
              )}
              {isWinner && <div className="winner-badge">🏆</div>}
            </div>
          );
        })}
        <div className="vs">VS</div>
      </div>
      {reveal && plates && !final && (
        <div className={`voter-pool ${order.length > 8 ? "crowd" : ""}`} ref={poolRef}>
          {order.map((tk, i) =>
            tk.voter ? (
              <Plate
                key={i}
                p={tk.voter}
                dataI={i}
                className={`pool-plate ${i < step ? "ghost" : ""}`}
              />
            ) : null,
          )}
        </div>
      )}
      {lash && (
        <>
          <div className="banner retrolash-banner">{t.stage.retrolash} 💥</div>
          <Confetti />
        </>
      )}
      {!reveal && (
        <>
          <p className="muted big-text">{t.stage.voteOnPhone}</p>
          <Commentary line={pick(P.commentary.voting, m.id)} delay={1500} />
        </>
      )}
      {line && <Commentary line={line} delay={lash ? 900 : 0} />}
      {extras && m.callout && (
        <div className="callout">
          {m.callout.kind === "streak" ? t.stage.streak(m.callout.name, m.callout.n) : t.stage.comeback(m.callout.name)}
        </div>
      )}
      {extras && kind === "retro" && (
        <div className="discuss slide-up">
          <span className="discuss-label">{t.stage.letsTalk}</span>
          {pick(P.discussion, m.id)}
        </div>
      )}
    </div>
  );
}

/** Votes as tokens, interleaved between the sides so the tension builds. */
function voteOrder(m: MatchupView): Token[] {
  const sides: [(PlateData | null)[], (PlateData | null)[]] = m.voters ?? [
    Array.from({ length: m.votes?.[0] ?? 0 }, () => null),
    Array.from({ length: m.votes?.[1] ?? 0 }, () => null),
  ];
  const out: Token[] = [];
  for (let i = 0; i < Math.max(sides[0].length, sides[1].length); i++) {
    if (i < sides[0].length) out.push({ side: 0, voter: sides[0][i] });
    if (i < sides[1].length) out.push({ side: 1, voter: sides[1][i] });
  }
  return out;
}

function resultLine(m: MatchupView, c: ReturnType<typeof usePrompts>["commentary"]) {
  const [a, b] = m.votes ?? [0, 0];
  if (m.unanimous) return pick(c.unanimous, m.id);
  if (a === b) return pick(c.tie, m.id);
  if (Math.abs(a - b) === 1) return pick(c.close, m.id);
  return pick(c.blowout, m.id);
}

function CountUp({ to, ms = 900 }: { to: number; ms?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (time: number) => {
      const p = Math.min(1, (time - start) / ms);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return <>{n}</>;
}

// ---------- polls, kudos, scores ----------

function MoodResult({ counts }: { counts: number[] }) {
  const t = useT();
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="poll-result">
      <h1 className="huge drop-in">{t.stage.forecast}</h1>
      <div className="mood-chart">
        {MOODS.map((m, i) => (
          <div key={m.label} className="mood-col" style={{ animationDelay: `${i * 150}ms` }}>
            <span className="mood-count">{counts[i] ?? 0}</span>
            <div className="mood-track">
              <div className="mood-bar" style={{ height: `${((counts[i] ?? 0) / max) * 100}%`, animationDelay: `${300 + i * 150}ms` }} />
            </div>
            <span className="mood-emoji">{m.emoji}</span>
            <span className="muted">{t.moods[i]}</span>
          </div>
        ))}
      </div>
      {total === 0 && <p className="muted">{t.stage.nobody}</p>}
    </div>
  );
}

function FollowupResult({ items, title = true }: { items: FollowupItemView[]; title?: boolean }) {
  const t = useT();
  return (
    <div className="poll-result">
      {title && <h1 className="huge drop-in">{t.rounds.followup}</h1>}
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

function KudosCard({ k, i }: { k: KudosView; i: number }) {
  const t = useT();
  return (
    <div
      className="kudos-card"
      style={{ "--plate": k.color ?? "#ffcf33", "--tilt": `${(i % 2 ? 1 : -1) * (1 + (i % 3))}deg` } as CSSProperties}
    >
      {k.to ? (
        <Plate p={{ name: k.to, avatar: k.avatar ?? "🙂", color: k.color ?? "#ffcf33" }} />
      ) : (
        <span className="plate" style={{ "--plate": "#ffcf33" } as CSSProperties}>
          <span className="plate-av">🙌</span>
          <span className="plate-name">{t.stage.toTeam}</span>
        </span>
      )}
      <p>“{k.text}”</p>
    </div>
  );
}

/** Kudos land on the wall one at a time. */
function KudosResult({ kudos }: { kudos: KudosView[] }) {
  const t = useT();
  const [shown, setShown] = useState(REDUCED_MOTION ? kudos.length : 0);
  useEffect(() => {
    const timers = kudos.map((_, i) =>
      setTimeout(() => {
        setShown(i + 1);
        sfx.blip(i + 3);
      }, 700 + i * 1800),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="kudos-result">
      <h1 className="huge drop-in">{t.stage.kudosTitle}</h1>
      <div className="kudos-wall">
        {kudos.slice(0, shown).map((k, i) => (
          <KudosCard key={i} k={k} i={i} />
        ))}
      </div>
    </div>
  );
}

function RoundResult({ view }: { view: HostView }) {
  const t = useT();
  const P = usePrompts();
  const ranked = view.players.filter((p) => !p.audience).sort((a, b) => b.score - a.score);
  return (
    <div className="round-result">
      <h1 className="huge drop-in">{t.stage.roundDone(view.roundTitle ?? "")}</h1>
      {view.settings.anonymous ? (
        <p className="muted big-text">{t.stage.anonNoScores}</p>
      ) : (
        <>
          <Scoreboard players={ranked} />
          {view.leadChange ? (
            <div className="callout" style={{ animationDelay: "1.4s" }}>
              {t.stage.leadChange(view.leadChange)}
            </div>
          ) : (
            <Commentary line={pick(P.commentary.roundDone, view.roundTitle ?? "")} delay={1200} />
          )}
        </>
      )}
    </div>
  );
}

function Scoreboard({ players }: { players: PublicPlayer[] }) {
  const max = Math.max(1, ...players.map((p) => p.score));
  const place = places(players.map((p) => p.score));
  return (
    <ol className="scoreboard">
      {players.map((p, i) => (
        <li key={p.id} style={{ animationDelay: `${(players.length - i) * 120}ms` }} className={place[i] === 1 ? "leader" : ""}>
          <span className="rank">{place[i] === 1 ? "👑" : place[i]}</span>
          <Plate p={p} />
          <span className="score-bar">
            <span style={{ width: `${(p.score / max) * 100}%`, background: p.color }} />
          </span>
          <span className="score">
            <CountUp to={p.score} ms={1200} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Third, then second, then a drumroll and the winner, with confetti. */
function Podium({ view }: { view: HostView }) {
  const t = useT();
  const ranked = view.players.filter((p) => !p.audience).sort((a, b) => b.score - a.score);
  const place = places(ranked.map((p) => p.score));
  const top = ranked.slice(0, 3);
  // When the winner's name is spoken, a softer sting keeps the crash from drowning it.
  const spoken = !!view.say?.length;
  const [shown, setShown] = useState(REDUCED_MOTION ? 3 : 0);
  useEffect(() => {
    if (REDUCED_MOTION) return;
    const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
    const timers = [
      at(300, () => sfx.drumroll(0.9)),
      at(1300, () => (setShown(1), sfx.sting())),
      at(2800, () => (setShown(2), sfx.sting())),
      at(PODIUM_REVEAL.intro, () => sfx.drumroll(1.6)),
      at(PODIUM_REVEAL.first, () => (setShown(3), spoken ? sfx.fanfare() : sfx.retrolash())),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Columns left to right: 2nd, 1st, 3rd, revealed from 3rd up. Equal scores share a place.
  const slots = [
    { p: top[1], place: place[1], visible: shown >= 2 },
    { p: top[0], place: place[0], visible: shown >= 3 },
    { p: top[2], place: place[2], visible: shown >= 1 },
  ];
  const jointWinners = place.filter((x) => x === 1).length > 1;
  return (
    <div className="podium-stage">
      <h1 className="huge drop-in">{jointWinners ? t.stage.podiumTie : t.stage.podium}</h1>
      <div className="podium">
        {slots.map(({ p, place, visible }, slot) =>
          p ? (
            <div key={slot} className={`podium-col place-${Math.min(place, 3)} ${visible ? "up" : ""}`}>
              {visible && (
                <div className="podium-winner">
                  {place === 1 && <div className="crown">👑</div>}
                  <Plate p={p} className="podium-plate" />
                  <div className="podium-score">
                    <CountUp to={p.score} ms={1200} />
                  </div>
                </div>
              )}
              <div className="podium-block" style={{ "--plate": p.color } as CSSProperties}>
                {place}
              </div>
            </div>
          ) : (
            <div key={slot} className="podium-col empty" />
          ),
        )}
      </div>
      {shown >= 3 && ranked.length > 3 && (
        <ol className="podium-rest">
          {ranked.slice(3).map((p, i) => (
            <li key={p.id}>
              <span className="rest-place">{place[i + 3]}.</span> <Plate p={p} /> {p.score}
            </li>
          ))}
        </ol>
      )}
      {shown >= 3 && <Confetti count={200} />}
    </div>
  );
}

/** The game's best answers, one card at a time, before the podium. */
function Highlights({ view }: { view: HostView }) {
  const t = useT();
  const items = view.highlights ?? [];
  const [shown, setShown] = useState(REDUCED_MOTION ? items.length : 0);
  useEffect(() => {
    const timers = items.map((_, i) =>
      setTimeout(() => {
        setShown(i + 1);
        sfx.whoosh();
        if (i === items.length - 1) sfx.fanfare(0.2);
        else sfx.sting(0.2);
      }, 900 + i * HIGHLIGHT_STEP_MS),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="highlights">
      <h1 className="huge drop-in">{t.stage.highlights}</h1>
      <div className="hl-row">
        {items.map((h, i) => (
          <article
            key={i}
            className={`hl-card ${i < shown ? "in" : ""} ${h.unanimous ? "lash" : ""}`}
            style={{ "--tilt": `${(i - 1) * 2}deg` } as CSSProperties}
          >
            <span className="hl-round">{h.round}</span>
            <p className="hl-prompt">{h.prompt}</p>
            <p className={`hl-answer ${h.emoji ? "emoji-answer" : ""}`}>{h.answer}</p>
            <div className="hl-foot">
              <span className="hl-votes">{t.stage.highlightVotes(h.votes, h.total)}</span>
              {h.unanimous && <span className="hl-badge">{t.stage.retrolash}</span>}
            </div>
            {h.author && <Plate p={h.author} className="hl-author" />}
          </article>
        ))}
      </div>
    </div>
  );
}

// ---------- Last Lash ----------

/** Last Lash. Results reveal from the bottom of the ranking up, after a drumroll. */
function Lash({ view }: { view: HostView }) {
  const t = useT();
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
      {!reveal && <p className="muted big-text">{t.stage.pickFavs}</p>}
      {reveal && shown >= answers.length && <p className="discuss slide-up">{t.stage.volunteer}</p>}
      <div className={`lash-list ${reveal ? "ranked" : ""}`}>
        {answers.map((a, i) => (
          <LashItem key={a.id} a={a} top={reveal && i < 3 && (a.votes ?? 0) > 0} reveal={reveal} max={max} visible={visible(i)} index={i} />
        ))}
      </div>
      {!reveal && <DoneGrid view={view} />}
    </div>
  );
}

function OwnerChips({ owners }: { owners?: LashAnswerView["owners"] }) {
  if (!owners?.length) return null;
  return (
    <span className="owners">
      {owners.map((o) => (
        <span key={o.name} className="owner-chip" style={o.color ? { background: o.color } : undefined}>
          {o.avatar} {o.name}
        </span>
      ))}
    </span>
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
      <OwnerChips owners={a.owners} />
      {a.author && <span className="author">{a.author}</span>}
      {reveal && visible && <span className="lash-bar" style={{ width: `${((a.votes ?? 0) / max) * 100}%` }} />}
    </div>
  );
}

// ---------- summary ----------

function Summary({ view }: { view: HostView }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const md = summaryToMarkdown(view);
  const rounds = view.summary ?? [];
  const lash = rounds.find((r) => r.kind === "lastlash");
  const actionItems = (lash?.lashAnswers ?? []).filter((a) => (a.votes ?? 0) > 0 || a.owners?.length);
  const sprint = rounds.filter((r) => r.kind === "retro").flatMap((r) => r.matchups);
  const mood = rounds.find((r) => r.kind === "checkin")?.moodCounts;
  const followup = rounds.find((r) => r.kind === "followup")?.followupItems;
  const kudos = rounds.find((r) => r.kind === "kudos")?.kudos;
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
      <h1 className="huge drop-in">{t.stage.wrap}</h1>
      <div className="summary-cols">
        <section>
          <h2>{t.stage.actionItems}</h2>
          {actionItems.length === 0 ? (
            <p className="muted">{t.stage.noActions}</p>
          ) : (
            <ol className="action-list">
              {actionItems.map((a, i) => (
                <li key={a.id} style={{ animationDelay: `${i * 100}ms` }}>
                  <span className="lash-votes">{a.votes}</span>
                  <span className="grow">{a.text}</span>
                  <OwnerChips owners={a.owners} />
                </li>
              ))}
            </ol>
          )}
          {followup && followup.length > 0 && (
            <>
              <h2>{t.stage.lastTime}</h2>
              <FollowupResult items={followup} title={false} />
            </>
          )}
          {sprint.length > 0 && (
            <>
              <h2>{t.stage.fromSprint}</h2>
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
              <h2>{t.stage.sprintWeather}</h2>
              <div className="mood-inline">
                {MOODS.map((m, i) => (
                  <span key={m.label} className={mood[i] ? "" : "dim"} title={t.moods[i]}>
                    {m.emoji} {mood[i]}
                  </span>
                ))}
              </div>
            </>
          )}
          {kudos && kudos.length > 0 && (
            <>
              <h2>{t.stage.kudos}</h2>
              <div className="kudos-wall small">
                {kudos.map((k, i) => (
                  <KudosCard key={i} k={k} i={i} />
                ))}
              </div>
            </>
          )}
          {!view.settings.anonymous && (
            <>
              <h2>{t.stage.finalScores}</h2>
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
          {copied ? t.stage.copied : t.stage.copy}
        </button>
        <button className="btn ghost" onClick={download}>
          {t.stage.download}
        </button>
      </div>
    </div>
  );
}

function FullscreenButton() {
  const t = useT();
  if (!document.fullscreenEnabled) return null;
  return (
    <button
      className="btn ghost small"
      onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
    >
      {t.host.fullscreen}
    </button>
  );
}
