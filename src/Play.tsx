import { useEffect, useMemo, useState } from "react";
import { normalizeCode, useCountdown, useRoom } from "./net";
import {
  FOLLOWUP_OPTIONS,
  MAX_ANSWER_LENGTH,
  MAX_EMOJI_LENGTH,
  MAX_LASH_LENGTH,
  MOODS,
  REACTIONS,
  emojiOnly,
  isHeadToHead,
  type ClientMessage,
  type PlayerView,
} from "../shared/types";
import { SAFETY_EMOJI, SAFETY_QUIPS } from "../shared/prompts";

const NAME_KEY = "retrolash:name";
type Send = (m: ClientMessage) => void;

function readSession(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function Play({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  // Rejoin automatically after a reload in the same tab.
  const [joined, setJoined] = useState(() => readSession(`retrolash:joined:${initialCode}`) !== null);
  const [audience, setAudience] = useState(
    () => readSession(`retrolash:joined:${initialCode}`) === "audience",
  );

  const hello = useMemo<ClientMessage | null>(
    () => (joined ? { t: "helloPlayer", name, audience } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [joined],
  );
  const { view, receivedAt, error, connected, send } = useRoom<PlayerView>(
    joined ? code : null,
    hello,
  );

  // Server errors only happen on a failed join or a kick: back to the form.
  useEffect(() => {
    if (!error) return;
    setJoined(false);
    try {
      sessionStorage.removeItem(`retrolash:joined:${code}`);
    } catch {
      /* private mode */
    }
  }, [error, code]);

  // A little buzz when there's something to do (Android; iOS ignores it).
  const key = view ? phaseKey(view) : "";
  useEffect(() => {
    if (!view || view.you?.audience) return;
    if (["answering", "voting", "lashVoting"].includes(view.phase)) navigator.vibrate?.(60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const join = (asAudience: boolean) => {
    if (code.length !== 4 || !name.trim()) return;
    try {
      localStorage.setItem(NAME_KEY, name.trim());
      sessionStorage.setItem(`retrolash:joined:${code}`, asAudience ? "audience" : "player");
    } catch {
      /* private mode */
    }
    history.replaceState(null, "", `?room=${code}`);
    setAudience(asAudience);
    setJoined(true);
  };

  if (!joined) {
    const ready = code.length === 4 && !!name.trim();
    return (
      <main className="phone">
        <h1 className="logo">
          Retro<span>lash</span>
        </h1>
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            join(false);
          }}
        >
          <label>
            Room code
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
            Your name
            <input
              value={name}
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
              autoComplete="nickname"
              placeholder="Name"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn big" disabled={!ready}>
            Join the game
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={!ready}
            onClick={() => join(true)}
          >
            👀 Join as audience
          </button>
          <p className="muted small-print">
            Audience members vote and react, but don't write answers or score. Good for
            visitors dropping in mid-retro.
          </p>
        </form>
      </main>
    );
  }

  return (
    <main className="phone">
      <header className="phone-header">
        {view?.you && (
          <span className="me">
            <span className="avatar">{view.you.avatar}</span> {view.you.name}
            {view.you.audience && <span className="badge">audience</span>}
          </span>
        )}
        <PhoneTimer view={view} receivedAt={receivedAt} />
        {!connected && <span className="offline">reconnecting…</span>}
      </header>
      {!view ? (
        <Waiting title="Connecting…" />
      ) : (
        <PhoneStage key={phaseKey(view)} view={view} send={send} />
      )}
    </main>
  );
}

// Remount the stage between tasks so local input state resets.
function phaseKey(v: PlayerView) {
  return [v.phase, v.roundTitle, v.vote?.matchupId].join(":");
}

function PhoneTimer({ view, receivedAt }: { view: PlayerView | null; receivedAt: number }) {
  const s = useCountdown(view?.remainingMs, receivedAt);
  if (s === null || view?.phase === "roundIntro") return null;
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
          aria-label={`React ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function PhoneStage({ view, send }: { view: PlayerView; send: Send }) {
  const audience = !!view.you?.audience;
  switch (view.phase) {
    case "lobby":
      return (
        <Waiting
          title={audience ? "You're in the audience 🍿" : "You're in! 🎉"}
          sub={
            view.playerCount < view.minPlayers
              ? `Waiting for more players (${view.playerCount}/${view.minPlayers})…`
              : "Waiting for the host to start."
          }
          send={send}
        />
      );
    case "roundIntro":
      return <Waiting title={view.roundTitle ?? "Get ready"} sub="Look at the big screen 👀" />;
    case "answering":
      if (audience)
        return (
          <Waiting
            title="The team is writing ✍️"
            sub="You'll get to vote in a moment. Meanwhile, cheer them on."
            send={send}
          />
        );
      if (view.roundKind === "checkin") return <Mood view={view} send={send} />;
      if (view.roundKind === "followup") return <Followup view={view} send={send} />;
      if (view.roundKind === "lastlash") return <LashAnswer view={view} send={send} />;
      return <Answer view={view} send={send} />;
    case "voting":
      return <Vote view={view} send={send} />;
    case "lashVoting":
      return <LashVote view={view} send={send} />;
    case "lashResult":
      return <Claim view={view} send={send} />;
    case "summary":
      return (
        <Waiting
          title="Thanks for playing! 🙌"
          sub={
            view.anonymous || audience ? undefined : `You scored ${view.you?.score ?? 0} points.`
          }
        />
      );
    default:
      return <Waiting title="Eyes on the big screen 👀" send={send} />;
  }
}

function Answer({ view, send }: { view: PlayerView; send: Send }) {
  const tasks = view.tasks ?? [];
  const current = tasks.find((t) => t.answer === null);
  const [text, setText] = useState("");
  useEffect(() => setText(""), [current?.matchupId]);
  const emoji = view.roundKind === "emoji";
  const max = emoji ? MAX_EMOJI_LENGTH : MAX_ANSWER_LENGTH;

  if (tasks.length === 0 && isHeadToHead(view.roundKind))
    return (
      <Waiting
        title="Sit this one out"
        sub="You joined mid-round, so you'll get prompts next round. You can still vote!"
        send={send}
      />
    );
  if (!current) return <Waiting title="All done ✓" sub="Waiting for the others…" send={send} />;

  const idx = tasks.indexOf(current) + 1;
  const help = () => {
    const list = emoji ? SAFETY_EMOJI : SAFETY_QUIPS;
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
        Prompt {idx} of {tasks.length}
        {emoji && " · emoji only 🙂"}
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
        placeholder={emoji ? "Use your emoji keyboard 😀" : "Your answer"}
      />
      <div className="row-between">
        <button type="button" className="btn ghost small" onClick={help}>
          🆘 Help me
        </button>
        <span className="muted">{emoji ? "" : max - text.length}</span>
        <button className="btn big" disabled={!text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function Mood({ view, send }: { view: PlayerView; send: Send }) {
  const mine = view.myMood ?? null;
  return (
    <div className="poll">
      <h2 className="phone-prompt">How was this sprint for you?</h2>
      <p className="muted">Anonymous: nobody sees who picked what.</p>
      <div className="mood-options">
        {MOODS.map((m, i) => (
          <button
            key={m.label}
            className={`mood-btn ${mine === i ? "chosen" : ""} ${mine !== null && mine !== i ? "faded" : ""}`}
            onClick={() => send({ t: "mood", value: i })}
          >
            <span className="mood-emoji">{m.emoji}</span>
            {m.label}
          </button>
        ))}
      </div>
      {mine !== null && <p className="muted center-text">Got it ✓ (tap to change)</p>}
    </div>
  );
}

function Followup({ view, send }: { view: PlayerView; send: Send }) {
  const items = view.followup?.items ?? [];
  const [mine, setMine] = useState<(number | null)[]>(
    () => view.followup?.mine ?? items.map(() => null),
  );
  const done = mine.every((v) => v !== null);
  const set = (i: number, v: number) => {
    const next = mine.map((x, j) => (j === i ? v : x));
    setMine(next);
    send({ t: "followup", answers: next });
  };
  return (
    <div className="poll">
      <h2 className="phone-prompt">Last retro's action items: did we do them?</h2>
      <div className="followup-list">
        {items.map((text, i) => (
          <div key={i} className="followup-item">
            <p>{text}</p>
            <div className="followup-options">
              {FOLLOWUP_OPTIONS.map((o, v) => (
                <button
                  key={o.label}
                  className={`fu-btn ${mine[i] === v ? "chosen" : ""}`}
                  onClick={() => set(i, v)}
                >
                  {o.emoji} {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {done && <p className="muted center-text">All answered ✓ (you can still change them)</p>}
    </div>
  );
}

function LashAnswer({ view, send }: { view: PlayerView; send: Send }) {
  const max = view.lashMaxAnswers ?? 1;
  const [texts, setTexts] = useState<string[]>(() => {
    const mine = view.myLashAnswers ?? [];
    return Array.from({ length: max }, (_, i) => mine[i] ?? "");
  });
  const [editing, setEditing] = useState((view.myLashAnswers ?? []).length === 0);

  if (!editing)
    return (
      <div className="waiting">
        <h2>Sent ✓</h2>
        <ul className="my-answers">
          {(view.myLashAnswers ?? []).map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <button className="btn ghost" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
    );

  return (
    <form
      className="answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        const filled = texts.filter((t) => t.trim());
        if (!filled.length) return;
        send({ t: "lashAnswers", texts: filled });
        setEditing(false);
      }}
    >
      <h2 className="phone-prompt">{view.lashPrompt}</h2>
      {max > 1 && <p className="muted">Up to {max} ideas</p>}
      {texts.map((t, i) => (
        <textarea
          key={i}
          rows={2}
          autoFocus={i === 0}
          maxLength={MAX_LASH_LENGTH}
          value={t}
          placeholder={i === 0 ? "Your idea" : "Another idea (optional)"}
          onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))}
        />
      ))}
      <button className="btn big" disabled={!texts.some((t) => t.trim())}>
        Send
      </button>
    </form>
  );
}

function Vote({ view, send }: { view: PlayerView; send: Send }) {
  const v = view.vote!;
  if (!v.canVote)
    return <Waiting title="This one's yours 😎" sub="Sit back while the others vote." send={send} />;
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
          {a || "🦗 no answer"}
        </button>
      ))}
      {v.myChoice !== null && (
        <>
          <p className="muted center-text">Voted ✓ (tap to change)</p>
          <Reactions send={send} />
        </>
      )}
    </div>
  );
}

function LashVote({ view, send }: { view: PlayerView; send: Send }) {
  const b = view.lashBallot!;
  const [picked, setPicked] = useState<string[]>(b.myVotes);
  const [submitted, setSubmitted] = useState(b.submitted);

  if (b.votesAllowed === 0)
    return <Waiting title="Nothing to vote on" sub="All the answers are yours!" send={send} />;
  if (submitted)
    return (
      <div className="waiting">
        <h2>Votes in ✓</h2>
        <button className="btn ghost" onClick={() => setSubmitted(false)}>
          Change votes
        </button>
        <Reactions send={send} />
      </div>
    );

  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < b.votesAllowed ? [...p, id] : p,
    );

  return (
    <div className="lash-vote">
      <h2 className="phone-prompt">{view.lashPrompt}</h2>
      <p className="muted">
        Pick up to {b.votesAllowed} · {picked.length}/{b.votesAllowed}
      </p>
      <div className="lash-options">
        {b.answers.map((a) => (
          <button
            key={a.id}
            className={`lash-opt ${picked.includes(a.id) ? "chosen" : ""}`}
            disabled={a.mine}
            onClick={() => toggle(a.id)}
          >
            {a.text}
            {a.mine && <span className="mine">yours</span>}
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
        Submit votes
      </button>
    </div>
  );
}

function Claim({ view, send }: { view: PlayerView; send: Send }) {
  const items = view.claimable ?? [];
  if (items.length === 0) return <Waiting title="Eyes on the big screen 👀" send={send} />;
  return (
    <div className="lash-vote">
      <h2 className="phone-prompt">Who takes which action item?</h2>
      <p className="muted">Tap to volunteer. Your name is shown as the owner.</p>
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
            <span className="mine">{a.mine ? "yours ✓" : "I'll take it"}</span>
          </button>
        ))}
      </div>
      <Reactions send={send} />
    </div>
  );
}
