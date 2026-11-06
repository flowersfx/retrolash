import { useEffect, useMemo, useState } from "react";
import { normalizeCode, useCountdown, useRoom } from "./net";
import {
  MAX_ANSWER_LENGTH,
  MAX_LASH_LENGTH,
  type ClientMessage,
  type PlayerView,
} from "../shared/types";

const NAME_KEY = "retrolash:name";

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
  const [joined, setJoined] = useState(() => {
    try {
      return sessionStorage.getItem(`retrolash:joined:${initialCode}`) === "1";
    } catch {
      return false;
    }
  });

  const hello = useMemo<ClientMessage | null>(
    () => (joined ? { t: "helloPlayer", name } : null),
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

  const join = () => {
    if (code.length !== 4 || !name.trim()) return;
    try {
      localStorage.setItem(NAME_KEY, name.trim());
      sessionStorage.setItem(`retrolash:joined:${code}`, "1");
    } catch {
      /* private mode */
    }
    history.replaceState(null, "", `?room=${code}`);
    setJoined(true);
  };

  if (!joined) {
    return (
      <main className="phone">
        <h1 className="logo">
          Retro<span>lash</span>
        </h1>
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            join();
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
          <button className="btn big" disabled={code.length !== 4 || !name.trim()}>
            Join
          </button>
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

function Waiting({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="waiting">
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
    </div>
  );
}

function PhoneStage({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
  switch (view.phase) {
    case "lobby":
      return (
        <Waiting
          title="You're in! 🎉"
          sub={
            view.playerCount < view.minPlayers
              ? `Waiting for more players (${view.playerCount}/${view.minPlayers})…`
              : "Waiting for the host to start."
          }
        />
      );
    case "roundIntro":
      return <Waiting title={view.roundTitle ?? "Get ready"} sub="Look at the big screen 👀" />;
    case "answering":
      return view.roundKind === "lastlash" ? (
        <LashAnswer view={view} send={send} />
      ) : (
        <Answer view={view} send={send} />
      );
    case "voting":
      return <Vote view={view} send={send} />;
    case "lashVoting":
      return <LashVote view={view} send={send} />;
    case "summary":
      return (
        <Waiting
          title="Thanks for playing! 🙌"
          sub={view.anonymous ? undefined : `You scored ${view.you?.score ?? 0} points.`}
        />
      );
    default:
      return <Waiting title="Eyes on the big screen 👀" />;
  }
}

function Answer({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
  const tasks = view.tasks ?? [];
  const current = tasks.find((t) => t.answer === null);
  const [text, setText] = useState("");
  useEffect(() => setText(""), [current?.matchupId]);

  if (tasks.length === 0)
    return <Waiting title="Sit this one out" sub="You joined mid-round — you'll get prompts next round. You can still vote!" />;
  if (!current) return <Waiting title="All done ✓" sub="Waiting for the others…" />;

  const idx = tasks.indexOf(current) + 1;
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
      </p>
      <h2 className="phone-prompt">{current.prompt}</h2>
      <textarea
        autoFocus
        rows={3}
        maxLength={MAX_ANSWER_LENGTH}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
        }}
        placeholder="Your answer"
      />
      <div className="row-between">
        <span className="muted">{MAX_ANSWER_LENGTH - text.length}</span>
        <button className="btn big" disabled={!text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function LashAnswer({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
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

function Vote({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
  const v = view.vote!;
  if (!v.canVote)
    return <Waiting title="This one's yours 😎" sub="Sit back while the others vote." />;
  return (
    <div className="vote">
      <h2 className="phone-prompt">{v.prompt}</h2>
      {v.answers.map((a, i) => (
        <button
          key={i}
          className={`vote-btn side-${i} ${v.myChoice === i ? "chosen" : ""} ${
            v.myChoice !== null && v.myChoice !== i ? "faded" : ""
          }`}
          disabled={!a}
          onClick={() => send({ t: "vote", matchupId: v.matchupId, choice: i as 0 | 1 })}
        >
          {a || "🦗 no answer"}
        </button>
      ))}
      {v.myChoice !== null && <p className="muted center-text">Voted ✓ — tap to change</p>}
    </div>
  );
}

function LashVote({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
  const b = view.lashBallot!;
  const [picked, setPicked] = useState<string[]>(b.myVotes);
  const [submitted, setSubmitted] = useState(b.submitted);

  if (b.votesAllowed === 0)
    return <Waiting title="Nothing to vote on" sub="All the answers are yours!" />;
  if (submitted)
    return (
      <div className="waiting">
        <h2>Votes in ✓</h2>
        <button className="btn ghost" onClick={() => setSubmitted(false)}>
          Change votes
        </button>
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
