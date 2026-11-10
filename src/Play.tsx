import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { deviceId, normalizeCode, setDeviceId, useCountdown, useRoom } from "./net";
import { strings } from "../shared/i18n";
import { LangContext, deviceLang, nextLabel, usePrompts, useT } from "./lang";
import {
  AUDIENCE_AVATARS,
  AVATARS,
  FOLLOWUP_OPTIONS,
  KUDOS_TEAM,
  MAX_ANSWER_LENGTH,
  MAX_EMOJI_LENGTH,
  MAX_KUDOS_LENGTH,
  MAX_LASH_LENGTH,
  MOODS,
  PLATE_COLORS,
  REACTIONS,
  emojiOnly,
  isHeadToHead,
  type ClientMessage,
  type PlayerView,
} from "../shared/types";

const NAME_KEY = "retrolash:name";
const LOOK_KEY = "retrolash:look";
/** Last identity per room, so closing the tab doesn't make you someone new. */
const lastKey = (code: string) => `retrolash:last:${code}`;
const REJOIN_MAX_AGE = 12 * 3600 * 1000;
type Send = (m: ClientMessage) => void;
type Look = { avatar: string; color: string };
type LastIdentity = { id: string; name: string; audience: boolean; avatar?: string; at: number };

function readStore<T>(store: "local" | "session", key: string): T | null {
  try {
    const raw = (store === "local" ? localStorage : sessionStorage).getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}
function writeStore(store: "local" | "session", key: string, value: unknown) {
  try {
    const s = store === "local" ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}
const joinedKey = (code: string) => `retrolash:joined:${code}`;

function defaultLook(): Look {
  return (
    readStore<Look>("local", LOOK_KEY) ?? {
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      color: PLATE_COLORS[Math.floor(Math.random() * PLATE_COLORS.length)],
    }
  );
}

export default function Play({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(() => readStore<string>("local", NAME_KEY) ?? "");
  const [look, setLook] = useState<Look>(defaultLook);
  // Rejoin automatically after a reload in the same tab.
  const [joined, setJoined] = useState(() => readStore<string>("session", joinedKey(initialCode)) !== null);
  const [audience, setAudience] = useState(() => readStore<string>("session", joinedKey(initialCode)) === "audience");

  const hello = useMemo<ClientMessage | null>(
    () => (joined ? { t: "helloPlayer", name, audience, avatar: look.avatar, color: look.color } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [joined],
  );
  const { view, receivedAt, error, connected, send } = useRoom<PlayerView>(joined ? code : null, hello);
  const lang = view?.lang ?? deviceLang();

  // Server errors only happen on a failed join or a kick: back to the form.
  useEffect(() => {
    if (!error) return;
    setJoined(false);
    writeStore("session", joinedKey(code), null);
    writeStore("local", lastKey(code), null);
  }, [error, code]);

  // Remember who we are in this room, for "Continue as …" in a new tab.
  useEffect(() => {
    if (!view?.you) return;
    writeStore("local", lastKey(code), {
      id: deviceId(code),
      name: view.you.name,
      audience: !!view.you.audience,
      avatar: view.you.avatar,
      at: Date.now(),
    } satisfies LastIdentity);
  }, [view?.you?.name, view?.you?.avatar, code]); // eslint-disable-line react-hooks/exhaustive-deps

  // A little buzz when there's something to do (Android; iOS ignores it).
  const key = view ? phaseKey(view) : "";
  useEffect(() => {
    if (!view || view.you?.audience) return;
    if (["answering", "voting", "lashVoting"].includes(view.phase)) navigator.vibrate?.(60);
    if (view.myResult?.kind === "author" && view.myResult.won) navigator.vibrate?.([80, 40, 80, 40, 160]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const join = (asAudience: boolean, reuse?: LastIdentity) => {
    if (code.length !== 4 || !(reuse || name.trim())) return;
    if (reuse) {
      setDeviceId(code, reuse.id);
      setName(reuse.name);
    } else {
      writeStore("local", NAME_KEY, name.trim());
      writeStore("local", LOOK_KEY, look);
    }
    writeStore("session", joinedKey(code), asAudience ? "audience" : "player");
    history.replaceState(null, "", `?room=${code}`);
    setAudience(asAudience);
    setJoined(true);
  };

  if (!joined) {
    return (
      <LangContext.Provider value={lang}>
        <JoinForm
          code={code}
          setCode={setCode}
          name={name}
          setName={setName}
          look={look}
          setLook={setLook}
          error={error}
          onJoin={join}
        />
      </LangContext.Provider>
    );
  }

  const vip = !!view?.vipControls;
  return (
    <LangContext.Provider value={lang}>
      <main className={`phone ${vip ? "has-vip" : ""}`}>
        <PhoneHeader view={view} receivedAt={receivedAt} connected={connected} />
        {!view ? <Waiting title={strings(lang).phone.connecting} /> : <PhoneStage key={phaseKey(view)} view={view} send={send} />}
        {view && vip && <VipBar view={view} send={send} />}
      </main>
    </LangContext.Provider>
  );
}

function JoinForm({
  code,
  setCode,
  name,
  setName,
  look,
  setLook,
  error,
  onJoin,
}: {
  code: string;
  setCode: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  look: Look;
  setLook: (l: Look) => void;
  error: string | null;
  onJoin: (asAudience: boolean, reuse?: LastIdentity) => void;
}) {
  const t = useT();
  const ready = code.length === 4 && !!name.trim();
  const last = code.length === 4 ? readStore<LastIdentity>("local", lastKey(code)) : null;
  const canRejoin = !!last && Date.now() - last.at < REJOIN_MAX_AGE;
  return (
    <main className="phone">
      <h1 className="logo">
        Retro<span>lash</span>
      </h1>
      {canRejoin && last && (
        <div className="rejoin">
          <button className="btn big" onClick={() => onJoin(last.audience, last)}>
            {last.avatar} {t.phone.continueAs(last.name)}
          </button>
          <p className="muted small-print">{t.phone.orNew}</p>
        </div>
      )}
      <form
        className="join-form"
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(false);
        }}
      >
        <label>
          {t.phone.roomCode}
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="ABCD"
          />
        </label>
        <label>
          {t.phone.yourName}
          <input
            value={name}
            maxLength={16}
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
            placeholder={t.phone.namePlaceholder}
          />
        </label>
        <div className="look-field">
          <span>{t.phone.pickLook}</span>
          <LookPicker look={look} onPick={setLook} name={name} />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn big" disabled={!ready}>
          {t.phone.join}
        </button>
        <button type="button" className="btn ghost" disabled={!ready} onClick={() => onJoin(true)}>
          {t.phone.joinAudience}
        </button>
        <p className="muted small-print">{t.phone.audienceHint}</p>
      </form>
    </main>
  );
}

/** Avatar grid and plate colours, with a live preview of the name plate. */
function LookPicker({
  look,
  onPick,
  name,
  taken = [],
  audience = false,
}: {
  look: Look;
  onPick: (l: Look) => void;
  name: string;
  taken?: string[];
  audience?: boolean;
}) {
  const avatars = audience ? [...AUDIENCE_AVATARS, ...AVATARS] : AVATARS;
  return (
    <div className="look-picker">
      <span className="plate preview" style={{ "--plate": look.color } as CSSProperties}>
        <span className="plate-av">{look.avatar}</span>
        <span className="plate-name">{name.trim() || "…"}</span>
      </span>
      <div className="avatar-grid">
        {avatars.map((a) => {
          const isTaken = !audience && taken.includes(a) && a !== look.avatar;
          return (
            <button
              key={a}
              type="button"
              className={`av-btn ${look.avatar === a ? "chosen" : ""}`}
              disabled={isTaken}
              onClick={() => onPick({ ...look, avatar: a })}
              aria-label={a}
            >
              {a}
            </button>
          );
        })}
      </div>
      <div className="color-row">
        {PLATE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch ${look.color === c ? "chosen" : ""}`}
            style={{ background: c }}
            onClick={() => onPick({ ...look, color: c })}
            aria-label={c}
          />
        ))}
      </div>
    </div>
  );
}

function PhoneHeader({
  view,
  receivedAt,
  connected,
}: {
  view: PlayerView | null;
  receivedAt: number;
  connected: boolean;
}) {
  const t = useT();
  return (
    <header className="phone-header">
      {view?.you && (
        <span className="plate me" style={{ "--plate": view.you.color } as CSSProperties}>
          <span className="plate-av">{view.you.avatar}</span>
          <span className="plate-name">{view.you.name}</span>
        </span>
      )}
      {view?.you?.audience && <span className="badge">{t.phone.audienceBadge}</span>}
      {view?.you?.vip && <span className="badge vip">{t.phone.vipBadge}</span>}
      <PhoneTimer view={view} receivedAt={receivedAt} />
      {!connected && <span className="offline">{t.reconnecting}</span>}
    </header>
  );
}

// Remount the stage between tasks so local input state resets.
function phaseKey(v: PlayerView) {
  return [v.phase, v.roundTitle, v.vote?.matchupId, v.upNext].join(":");
}

function PhoneTimer({ view, receivedAt }: { view: PlayerView | null; receivedAt: number }) {
  const s = useCountdown(view?.remainingMs, receivedAt);
  if (s === null || view?.phase === "roundIntro" || view?.phase === "matchupIntro") return null;
  return <span className={`timer small ${s <= 10 ? "urgent" : ""}`}>{s}</span>;
}

function Waiting({
  title,
  sub,
  send,
  children,
}: {
  title: string;
  sub?: string;
  send?: Send;
  children?: React.ReactNode;
}) {
  return (
    <div className="waiting">
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
      {children}
      {send && <Reactions send={send} />}
    </div>
  );
}

function Reactions({ send }: { send: Send }) {
  const [last, setLast] = useState<string | null>(null);
  return (
    <div className="reactions">
      {REACTIONS.map((e) => (
        <button
          key={e}
          className={`react-btn ${last === e ? "bump" : ""}`}
          onClick={() => {
            send({ t: "react", emoji: e });
            setLast(e);
            setTimeout(() => setLast(null), 250);
          }}
          aria-label={e}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** The VIP's remote control for the big screen. */
function VipBar({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const c = view.vipControls;
  if (!c || view.phase === "summary") return null;
  return (
    <div className="vip-bar">
      <span className="vip-label">{t.phone.remote}</span>
      {view.phase === "lobby" ? (
        <button className="btn" disabled={!c.canStart} onClick={() => send({ t: "start" })}>
          {t.lobby.start}
        </button>
      ) : (
        <>
          {(c.timed || c.paused) && (
            <button className="btn ghost small" onClick={() => send({ t: "hold" })}>
              {c.paused ? t.resume : t.hold}
            </button>
          )}
          <button className="btn" onClick={() => send({ t: "next" })}>
            {nextLabel(t, { ...c, phase: view.phase, anonymous: view.anonymous })} ▶
          </button>
        </>
      )}
    </div>
  );
}

function PhoneStage({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const audience = !!view.you?.audience;
  const rank = view.myRank ? t.phone.rank(view.myRank.rank, view.myRank.of, view.myRank.score) : undefined;
  switch (view.phase) {
    case "lobby":
      return <LobbyWait view={view} send={send} />;
    case "roundIntro":
      return <Waiting title={view.roundTitle ?? t.phone.getReady} sub={t.phone.lookBigScreen} />;
    case "matchupIntro":
      return (
        <Waiting title={t.phone.upNext} sub={t.phone.lookBigScreen}>
          {view.upNext && <p className="phone-prompt up-next">{view.upNext}</p>}
        </Waiting>
      );
    case "answering":
      if (audience) return <Waiting title={t.phone.audienceWriting} sub={t.phone.audienceWritingSub} send={send} />;
      if (view.roundKind === "checkin") return <Mood view={view} send={send} />;
      if (view.roundKind === "followup") return <Followup view={view} send={send} />;
      if (view.roundKind === "lastlash") return <LashAnswer view={view} send={send} />;
      if (view.roundKind === "kudos") return <Kudos view={view} send={send} />;
      return <Answer view={view} send={send} />;
    case "voting":
      return <Vote view={view} send={send} />;
    case "matchupResult":
      return <MyResultCard view={view} send={send} />;
    case "lashVoting":
      return <LashVote view={view} send={send} />;
    case "lashResult":
      return <Claim view={view} send={send} />;
    case "roundResult":
    case "podium":
      return <Waiting title={t.phone.eyesUp} sub={rank} send={send} />;
    case "summary":
      return <Waiting title={t.phone.thanks} sub={view.anonymous || audience ? undefined : rank} />;
    default:
      return <Waiting title={t.phone.eyesUp} send={send} />;
  }
}

function LobbyWait({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const me = view.you;
  const audience = !!me?.audience;
  if (editing && me)
    return (
      <div className="poll">
        <LookPicker
          look={{ avatar: me.avatar, color: me.color }}
          name={me.name}
          taken={view.takenAvatars}
          audience={audience}
          onPick={(l) => {
            writeStore("local", LOOK_KEY, l);
            send({ t: "profile", avatar: l.avatar, color: l.color });
          }}
        />
        <button className="btn big" onClick={() => setEditing(false)}>
          {t.phone.done}
        </button>
      </div>
    );
  return (
    <Waiting
      title={audience ? t.phone.inAudience : t.phone.youreIn}
      sub={view.playerCount < view.minPlayers ? t.phone.waitingMore(view.playerCount, view.minPlayers) : t.phone.waitingHost}
      send={send}
    >
      <button className="btn ghost small" onClick={() => setEditing(true)}>
        {t.phone.changeLook}
      </button>
    </Waiting>
  );
}

function MyResultCard({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const r = view.myResult;
  if (!r) return <Waiting title={t.phone.eyesUp} send={send} />;
  if (r.kind === "voter") {
    const title = r.pickedWinner === null ? t.phone.tieVoter : r.pickedWinner ? t.phone.pickedWinner : t.phone.pickedLoser;
    return <Waiting title={title} sub={t.phone.lookBigScreen} send={send} />;
  }
  const mood = r.won === null ? "tie" : r.won ? "win" : "lose";
  const title = r.unanimous ? t.phone.retrolash : r.won === null ? t.phone.tie : r.won ? t.phone.won : t.phone.lost;
  return (
    <div className={`my-result ${mood} ${r.unanimous ? "lash" : ""}`}>
      <h2>{title}</h2>
      <div className="big-score">{t.phone.score(r.votes[0], r.votes[1])}</div>
      {r.points !== null && r.points > 0 && <p className="pts">{t.phone.points(r.points)}</p>}
      <Reactions send={send} />
    </div>
  );
}

function Answer({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const P = usePrompts();
  const tasks = view.tasks ?? [];
  const current = tasks.find((x) => x.answer === null);
  const [text, setText] = useState("");
  useEffect(() => setText(""), [current?.matchupId]);
  const emoji = view.roundKind === "emoji";
  const max = emoji ? MAX_EMOJI_LENGTH : MAX_ANSWER_LENGTH;

  if (tasks.length === 0 && isHeadToHead(view.roundKind))
    return <Waiting title={t.phone.sitOut} sub={t.phone.sitOutSub} send={send} />;
  if (!current) return <Waiting title={t.phone.allDone} sub={t.phone.waitOthers} send={send} />;

  const idx = tasks.indexOf(current) + 1;
  const help = () => {
    const list = emoji ? P.safetyEmoji : P.safetyQuips;
    setText(list[Math.floor(Math.random() * list.length)]);
  };
  return (
    <form
      className="answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        send({ t: "answer", matchupId: current.matchupId, text });
      }}
    >
      <p className="muted">
        {t.phone.promptOf(idx, tasks.length)}
        {emoji && t.phone.emojiOnly}
      </p>
      <h2 className="phone-prompt">{current.prompt}</h2>
      <textarea
        autoFocus
        rows={emoji ? 2 : 3}
        maxLength={max}
        value={text}
        className={emoji ? "emoji-input" : ""}
        onChange={(e) => setText(emoji ? emojiOnly(e.target.value) : e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
        }}
        placeholder={emoji ? t.phone.emojiPlaceholder : t.phone.answerPlaceholder}
      />
      <div className="row-between">
        <button type="button" className="btn ghost small" onClick={help}>
          {t.phone.help}
        </button>
        <span className="muted">{emoji ? "" : max - text.length}</span>
        <button className="btn big" disabled={!text.trim()}>
          {t.phone.send}
        </button>
      </div>
    </form>
  );
}

function Mood({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const mine = view.myMood ?? null;
  return (
    <div className="poll">
      <h2 className="phone-prompt">{t.phone.moodQ}</h2>
      <p className="muted">{t.phone.moodAnon}</p>
      <div className="mood-options">
        {MOODS.map((m, i) => (
          <button
            key={m.label}
            className={`mood-btn ${mine === i ? "chosen" : ""} ${mine !== null && mine !== i ? "faded" : ""}`}
            onClick={() => send({ t: "mood", value: i })}
          >
            <span className="mood-emoji">{m.emoji}</span>
            {t.moods[i]}
          </button>
        ))}
      </div>
      {mine !== null && <p className="muted center-text">{t.phone.gotIt}</p>}
    </div>
  );
}

function Followup({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const items = view.followup?.items ?? [];
  const [mine, setMine] = useState<(number | null)[]>(() => view.followup?.mine ?? items.map(() => null));
  const done = mine.every((v) => v !== null);
  const set = (i: number, v: number) => {
    const next = mine.map((x, j) => (j === i ? v : x));
    setMine(next);
    send({ t: "followup", answers: next });
  };
  return (
    <div className="poll">
      <h2 className="phone-prompt">{t.phone.followupQ}</h2>
      <div className="followup-list">
        {items.map((text, i) => (
          <div key={i} className="followup-item">
            <p>{text}</p>
            <div className="followup-options">
              {FOLLOWUP_OPTIONS.map((o, v) => (
                <button key={o.label} className={`fu-btn ${mine[i] === v ? "chosen" : ""}`} onClick={() => set(i, v)}>
                  {o.emoji} {t.followupOptions[v]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {done && <p className="muted center-text">{t.phone.allAnswered}</p>}
    </div>
  );
}

function Kudos({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const form = view.kudosForm!;
  const [to, setTo] = useState<string | null>(form.mine?.to ?? null);
  const [text, setText] = useState(form.mine?.text ?? "");
  const [editing, setEditing] = useState(!form.mine);

  if (!editing && form.mine)
    return (
      <Waiting title={t.phone.kudosSent} send={send}>
        <p className="muted">“{form.mine.text}”</p>
        <button className="btn ghost" onClick={() => setEditing(true)}>
          {t.phone.edit}
        </button>
      </Waiting>
    );

  return (
    <form
      className="answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!to || !text.trim()) return;
        send({ t: "kudos", to, text });
        setEditing(false);
      }}
    >
      <h2 className="phone-prompt">{t.phone.kudosQ}</h2>
      <p className="muted">{t.phone.kudosAnon}</p>
      <div className="kudos-to-grid">
        <button
          type="button"
          className={`plate pick ${to === KUDOS_TEAM ? "chosen" : ""}`}
          style={{ "--plate": "#ffcf33" } as CSSProperties}
          onClick={() => setTo(KUDOS_TEAM)}
        >
          <span className="plate-name">{t.phone.kudosTeam}</span>
        </button>
        {form.teammates.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`plate pick ${to === p.id ? "chosen" : ""}`}
            style={{ "--plate": p.color } as CSSProperties}
            onClick={() => setTo(p.id)}
          >
            <span className="plate-av">{p.avatar}</span>
            <span className="plate-name">{p.name}</span>
          </button>
        ))}
      </div>
      <textarea
        rows={3}
        maxLength={MAX_KUDOS_LENGTH}
        value={text}
        placeholder={t.phone.kudosPlaceholder}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn big" disabled={!to || !text.trim()}>
        {t.phone.send}
      </button>
    </form>
  );
}

function LashAnswer({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const max = view.lashMaxAnswers ?? 1;
  const [texts, setTexts] = useState<string[]>(() => {
    const mine = view.myLashAnswers ?? [];
    return Array.from({ length: max }, (_, i) => mine[i] ?? "");
  });
  const [editing, setEditing] = useState((view.myLashAnswers ?? []).length === 0);

  if (!editing)
    return (
      <div className="waiting">
        <h2>{t.phone.sent}</h2>
        <ul className="my-answers">
          {(view.myLashAnswers ?? []).map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <button className="btn ghost" onClick={() => setEditing(true)}>
          {t.phone.edit}
        </button>
      </div>
    );

  return (
    <form
      className="answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        const filled = texts.filter((x) => x.trim());
        if (!filled.length) return;
        send({ t: "lashAnswers", texts: filled });
        setEditing(false);
      }}
    >
      <h2 className="phone-prompt">{view.lashPrompt}</h2>
      {max > 1 && <p className="muted">{t.phone.upTo(max)}</p>}
      {texts.map((x, i) => (
        <textarea
          key={i}
          rows={2}
          autoFocus={i === 0}
          maxLength={MAX_LASH_LENGTH}
          value={x}
          placeholder={i === 0 ? t.phone.idea : t.phone.anotherIdea}
          onChange={(e) => setTexts(texts.map((y, j) => (j === i ? e.target.value : y)))}
        />
      ))}
      <button className="btn big" disabled={!texts.some((x) => x.trim())}>
        {t.phone.send}
      </button>
    </form>
  );
}

function Vote({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const v = view.vote!;
  if (!v.canVote) return <Waiting title={t.phone.yours} sub={t.phone.yoursSub} send={send} />;
  return (
    <div className="vote">
      <h2 className="phone-prompt">{v.prompt}</h2>
      {v.answers.map((a, i) => (
        <button
          key={i}
          className={`vote-btn side-${i} ${v.myChoice === i ? "chosen" : ""} ${
            v.myChoice !== null && v.myChoice !== i ? "faded" : ""
          } ${view.roundKind === "emoji" ? "emoji-answer" : ""}`}
          disabled={!a}
          onClick={() => send({ t: "vote", matchupId: v.matchupId, choice: i as 0 | 1 })}
        >
          {a || "🦗"}
        </button>
      ))}
      {v.myChoice !== null && (
        <>
          <p className="muted center-text">{t.phone.voted}</p>
          <Reactions send={send} />
        </>
      )}
    </div>
  );
}

function LashVote({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const b = view.lashBallot!;
  const [picked, setPicked] = useState<string[]>(b.myVotes);
  const [submitted, setSubmitted] = useState(b.submitted);

  if (b.votesAllowed === 0) return <Waiting title={t.phone.nothingToVote} sub={t.phone.allYours} send={send} />;
  if (submitted)
    return (
      <div className="waiting">
        <h2>{t.phone.votesIn}</h2>
        <button className="btn ghost" onClick={() => setSubmitted(false)}>
          {t.phone.changeVotes}
        </button>
        <Reactions send={send} />
      </div>
    );

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < b.votesAllowed ? [...p, id] : p));

  return (
    <div className="lash-vote">
      <h2 className="phone-prompt">{view.lashPrompt}</h2>
      <p className="muted">{t.phone.pickUpTo(b.votesAllowed, picked.length)}</p>
      <div className="lash-options">
        {b.answers.map((a) => (
          <button
            key={a.id}
            className={`lash-opt ${picked.includes(a.id) ? "chosen" : ""}`}
            disabled={a.mine}
            onClick={() => toggle(a.id)}
          >
            {a.text}
            {a.mine && <span className="mine">{t.phone.yoursTag}</span>}
          </button>
        ))}
      </div>
      <button
        className="btn big sticky"
        disabled={picked.length === 0}
        onClick={() => {
          send({ t: "lashVote", answerIds: picked });
          setSubmitted(true);
        }}
      >
        {t.phone.submitVotes}
      </button>
    </div>
  );
}

function Claim({ view, send }: { view: PlayerView; send: Send }) {
  const t = useT();
  const items = view.claimable ?? [];
  if (items.length === 0) return <Waiting title={t.phone.eyesUp} send={send} />;
  return (
    <div className="lash-vote">
      <h2 className="phone-prompt">{t.phone.claimQ}</h2>
      <p className="muted">{t.phone.claimHint}</p>
      <div className="lash-options">
        {items.map((a) => (
          <button
            key={a.id}
            className={`lash-opt claim-opt ${a.mine ? "chosen" : ""}`}
            onClick={() => send({ t: "claim", answerId: a.id, on: !a.mine })}
          >
            <span className="claim-votes">{a.votes}</span>
            <span className="claim-text">
              {a.text}
              {a.owners.length > 0 && <small>🙋 {a.owners.join(", ")}</small>}
            </span>
            <span className="mine">{a.mine ? t.phone.claimMine : t.phone.claimTake}</span>
          </button>
        ))}
      </div>
      <Reactions send={send} />
    </div>
  );
}
